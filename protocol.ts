/**
 * IPC protocol shared between the per-session MCP shim (server.ts) and the
 * long-lived daemon (daemon.ts). Transport is a UNIX domain socket carrying
 * newline-delimited JSON — one JSON object per line, no embedded newlines
 * (JSON.stringify never emits raw newlines, so '\n' is a safe frame delimiter).
 */

import { homedir } from 'os'
import { join } from 'path'
import type { Socket } from 'net'

export const STATE_DIR =
  process.env.TELEGRAM_STATE_DIR ??
  join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'channels', 'telegram')

export const SOCK_PATH = join(STATE_DIR, 'daemon.sock')
export const DAEMON_PID_FILE = join(STATE_DIR, 'daemon.pid')
export const DAEMON_LOG = join(STATE_DIR, 'daemon.log')

/** Info a shim registers about its Claude Code session. */
export type SessionInfo = {
  id: string
  cwd: string
  title: string
  pid: number
}

/** Messages the shim sends to the daemon. */
export type ShimMsg =
  | { t: 'hello'; session: SessionInfo }
  | { t: 'call'; cid: number; name: string; args: Record<string, unknown> }
  | { t: 'permission_request'; request_id: string; tool_name: string; description: string; input_preview: string }
  | { t: 'bye' }
  // Sent by the activity hook (a short-lived client, not a registered session):
  // mirrors Claude's tool activity into the project topic.
  | { t: 'activity'; cwd: string; text: string }

/** Messages the daemon sends to a shim. */
export type DaemonMsg =
  | { t: 'welcome'; botUsername: string }
  | { t: 'result'; cid: number; ok: true; text: string }
  | { t: 'result'; cid: number; ok: false; error: string }
  | { t: 'inbound'; params: unknown }
  | { t: 'permission_reply'; request_id: string; behavior: 'allow' | 'deny' }
  | { t: 'ask_answer'; ask_id: string; choice: string }

/**
 * Wrap a socket with newline-delimited JSON framing. Calls `onMsg` for each
 * complete line. Returns a `send` that serializes+frames one object.
 */
export function frame<Incoming>(
  sock: Socket,
  onMsg: (msg: Incoming) => void,
  onError?: (err: unknown) => void,
): (obj: unknown) => void {
  let buf = ''
  sock.setEncoding('utf8')
  sock.on('data', chunk => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line) continue
      try {
        onMsg(JSON.parse(line) as Incoming)
      } catch (err) {
        onError?.(err)
      }
    }
  })
  return (obj: unknown) => {
    try {
      sock.write(JSON.stringify(obj) + '\n')
    } catch (err) {
      onError?.(err)
    }
  }
}
