#!/usr/bin/env bun
/**
 * Claude Code activity hook → Telegram topic mirror.
 *
 * Wire it to PostToolUse (and optionally Stop) in settings.json. On each event
 * Claude Code passes a JSON payload on stdin; this script formats a one-line
 * summary and ships it to the daemon over the same UNIX socket, which posts it
 * into the project's topic. Fire-and-forget: it never blocks or fails the turn.
 *
 *   "hooks": {
 *     "PostToolUse": [{ "matcher": "*", "hooks": [
 *       { "type": "command", "command": "bun /ABS/PATH/hooks/activity.ts" } ]}],
 *     "Stop": [{ "hooks": [
 *       { "type": "command", "command": "bun /ABS/PATH/hooks/activity.ts" } ]}]
 *   }
 */

import { connect } from 'net'
import { SOCK_PATH } from '../protocol.ts'

const trunc = (s: unknown, n: number) => {
  const str = typeof s === 'string' ? s : ''
  return str.length > n ? str.slice(0, n) + '…' : str
}
const base = (p: unknown) => (typeof p === 'string' ? p.split('/').pop() : '') ?? ''

function summarize(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'Bash': return `🔧 Bash: ${trunc(input.command, 90)}`
    case 'Edit':
    case 'MultiEdit': return `✏️ Edit ${base(input.file_path)}`
    case 'Write': return `📝 Write ${base(input.file_path)}`
    case 'Read': return `📖 Read ${base(input.file_path)}`
    case 'NotebookEdit': return `✏️ Notebook ${base(input.notebook_path)}`
    case 'Grep': return `🔎 Grep ${trunc(input.pattern, 60)}`
    case 'Glob': return `🔎 Glob ${trunc(input.pattern, 60)}`
    case 'WebFetch': return `🌐 Fetch ${trunc(input.url, 70)}`
    case 'WebSearch': return `🌐 Search ${trunc(input.query, 60)}`
    case 'Task': return `🤖 Agent: ${trunc(input.description, 60)}`
    default: return `🔧 ${tool}`
  }
}

async function main(): Promise<void> {
  const raw = await new Promise<string>(resolve => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', c => (buf += c))
    process.stdin.on('end', () => resolve(buf))
    setTimeout(() => resolve(buf), 1000) // never hang the turn
  })

  let payload: Record<string, unknown>
  try { payload = JSON.parse(raw) } catch { return }

  const cwd = (payload.cwd as string) || process.cwd()
  const event = payload.hook_event_name as string
  let text: string | null = null
  if (event === 'PostToolUse' && payload.tool_name) {
    text = summarize(payload.tool_name as string, (payload.tool_input as Record<string, unknown>) ?? {})
  } else if (event === 'Stop') {
    text = '✅ turn complete'
  }
  if (!text) return

  await new Promise<void>(resolve => {
    const s = connect(SOCK_PATH)
    const done = () => { try { s.destroy() } catch {}; resolve() }
    s.on('connect', () => s.write(JSON.stringify({ t: 'activity', cwd, text }) + '\n', () => setTimeout(done, 50)))
    s.on('error', done) // no daemon → silently skip
    setTimeout(done, 800)
  })
}

main().catch(() => {}).finally(() => process.exit(0))
