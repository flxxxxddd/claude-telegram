#!/usr/bin/env bun
/**
 * The per-session MCP shim.
 *
 * Claude Code spawns one of these per session. It holds no Telegram state at
 * all: it connects to the shared daemon over a UNIX socket, registers the
 * session, forwards tool calls, and relays what comes back as MCP
 * notifications. If no daemon is listening it starts one, detached, and
 * retries — so the first session of the day brings the bridge up.
 *
 * Identity comes from `CLAUDE_CODE_SESSION_ID`, which is also the name of the
 * session's transcript file. That is what lets the daemon mirror the turn
 * without being told where to look.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { basename } from 'node:path'
import { z } from 'zod'
import { paths, projectName } from '../paths.ts'
import { frame, type ClientMsg, type DaemonMsg, type SessionInfo } from '../protocol.ts'
import { VERSION } from '../version.ts'
import { INSTRUCTIONS, TOOLS } from './tools.ts'

const DAEMON_ENTRY = new URL('../daemon/run.ts', import.meta.url).pathname

const session: SessionInfo = {
  id: process.env.CLAUDE_CODE_SESSION_ID ?? `unknown-${process.pid}`,
  cwd: process.cwd(),
  title: projectName(process.cwd()) || basename(process.cwd()) || 'session',
  // The process to signal on an interrupt is Claude Code itself, not this shim.
  pid: Number(process.env.CLAUDE_PID ?? process.pid),
  launched: process.env.CCTG_LAUNCHED === '1',
}

const warn = (message: string): void => {
  process.stderr.write(`cctg: ${message}\n`)
}

process.on('unhandledRejection', err => warn(`unhandled rejection: ${String(err)}`))
process.on('uncaughtException', err => warn(`uncaught exception: ${String(err)}`))

/* ------------------------------------------------------- daemon connection -- */

let send: ((msg: ClientMsg) => void) | null = null
let socket: Socket | null = null
let spawnedDaemon = false
let callId = 0
const inFlight = new Map<number, { resolve: (text: string) => void; reject: (err: Error) => void }>()

function startDaemon(): void {
  if (spawnedDaemon) return
  spawnedDaemon = true
  warn('no daemon listening; starting one')
  let out: 'ignore' | number = 'ignore'
  try {
    out = openSync(paths.log, 'a')
  } catch {
    out = 'ignore'
  }
  const child = spawn('bun', [DAEMON_ENTRY], { detached: true, stdio: ['ignore', out, out], env: process.env })
  child.unref()
}

function connectToDaemon(attempt = 1): void {
  const sock = connect(paths.sock)
  sock.on('connect', () => {
    socket = sock
    send = frame<DaemonMsg>(sock, onDaemonMsg, err => warn(`bad frame: ${String(err)}`))
    send({ t: 'hello', kind: 'session', session })
  })
  sock.on('error', () => {
    if (!spawnedDaemon) startDaemon()
    // Back off up to three seconds: a daemon that is still opening its socket
    // should not be hammered, and one that will never come up should not spin.
    setTimeout(() => connectToDaemon(attempt + 1), Math.min(300 * attempt, 3000))
  })
  sock.on('close', () => {
    if (socket !== sock) return
    socket = null
    send = null
    setTimeout(() => connectToDaemon(1), 500)
  })
}

function onDaemonMsg(msg: DaemonMsg): void {
  switch (msg.t) {
    case 'welcome':
      warn(`connected to daemon ${msg.version} as @${msg.botUsername}`)
      break
    case 'result': {
      const call = inFlight.get(msg.cid)
      if (!call) break
      inFlight.delete(msg.cid)
      if (msg.ok) call.resolve(msg.text)
      else call.reject(new Error(msg.error))
      break
    }
    case 'inbound':
      void mcp.notification({
        method: 'notifications/claude/channel',
        params: msg.params as Record<string, unknown>,
      })
      break
    case 'permission_reply':
      void mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id: msg.request_id, behavior: msg.behavior },
      })
      break
    case 'interrupt':
      // The user tapped "interrupt" in Telegram. SIGINT is what Ctrl-C sends,
      // so Claude Code treats it exactly as it treats an interrupt typed in.
      try {
        process.kill(session.pid, 'SIGINT')
      } catch {
        warn('interrupt requested, but the session process is gone')
      }
      break
    case 'ask_answer':
    case 'status':
      break
  }
}

/** Forward one tool call and wait for the daemon's answer. */
function callDaemon(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!send) {
      reject(new Error('the daemon is not connected yet — try again in a moment'))
      return
    }
    const cid = ++callId
    inFlight.set(cid, { resolve, reject })
    send({ t: 'call', cid, name, args })
    const timer = setTimeout(() => {
      if (inFlight.delete(cid)) reject(new Error(`${name} timed out`))
    }, timeoutMs)
    timer.unref?.()
  })
}

/** `ask` blocks on a human tapping a button, so it gets far longer than the rest. */
const TOOL_TIMEOUT_MS: Record<string, number> = { ask: 31 * 60 * 1000 }
const DEFAULT_TOOL_TIMEOUT_MS = 60_000

/* -------------------------------------------------------------- mcp server -- */

const mcp = new Server(
  { name: 'claude-telegram', version: VERSION },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
    },
    instructions: INSTRUCTIONS,
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }))

mcp.setRequestHandler(CallToolRequestSchema, async request => {
  const name = request.params.name
  const args = (request.params.arguments ?? {}) as Record<string, unknown>
  try {
    const text = await callDaemon(name, args, TOOL_TIMEOUT_MS[name] ?? DEFAULT_TOOL_TIMEOUT_MS)
    return { content: [{ type: 'text', text }] }
  } catch (err) {
    return {
      content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    }
  }
})

/**
 * Claude Code asks the channel for permission through this notification. It is
 * forwarded to the daemon, which renders the buttons; the answer comes back as
 * `permission_reply` and is relayed above.
 */
const PermissionRequest = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string().optional(),
    description: z.string().optional(),
    input_preview: z.string().optional(),
  }).passthrough(),
})

mcp.setNotificationHandler(PermissionRequest, notification => {
  send?.({
    t: 'permission_request',
    request_id: notification.params.request_id,
    tool_name: notification.params.tool_name ?? 'a tool',
    description: notification.params.description ?? '',
    input_preview: notification.params.input_preview ?? '',
  })
})

async function main(): Promise<void> {
  connectToDaemon()
  await mcp.connect(new StdioServerTransport())
}

const bye = (): void => {
  send?.({ t: 'bye' })
  socket?.destroy()
  process.exit(0)
}
process.on('SIGTERM', bye)
process.on('SIGINT', bye)

await main()
