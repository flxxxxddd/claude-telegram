/**
 * The wire between the long-lived daemon and everything that talks to it: the
 * per-session MCP shim, the activity hook, and the CLI.
 *
 * Transport is a UNIX domain socket carrying newline-delimited JSON — one object
 * per line. `JSON.stringify` never emits a raw newline, so `\n` is a safe frame
 * delimiter and no length prefix is needed.
 */

import type { Socket } from 'node:net'

/** How a client identifies itself in its first frame. */
export type ClientKind = 'session' | 'hook' | 'cli'

/** What a Claude Code session tells the daemon about itself when it connects. */
export type SessionInfo = {
  /** Claude Code's own session id — also the transcript file's basename. */
  id: string
  cwd: string
  /** Best-known human title; upgraded from the transcript's `ai-title`. */
  title: string
  pid: number
  /** True when this session was spawned by the daemon, so it may be controlled. */
  launched: boolean
  /**
   * The transcript this session writes, resolved in the session's own
   * environment. The daemon cannot work it out: a `cca --isolated` profile
   * moves `CLAUDE_CONFIG_DIR`, so the daemon would follow a file under its own
   * home that nothing ever writes.
   */
  transcript: string
  /** The cca profile this session runs as, when it runs under one. */
  account?: string
}

/** A session as the daemon reports it to the CLI and to `/sessions`. */
export type SessionView = SessionInfo & {
  connectedAt: number
  model?: string
  effort?: string
  /** Chat + topic the session currently posts into, when it has one. */
  chatId?: string
  threadId?: number
  busy: boolean
}

/** The daemon's view of itself, for `cctg status` and `cctg doctor`. */
export type DaemonStatus = {
  pid: number
  version: string
  startedAt: number
  botUsername: string
  /** Whether the bot can open topics — decides threading mode. */
  topicsEnabled: boolean
  threadMode: 'topics' | 'flat'
  sessions: SessionView[]
}

/** Frames a client sends to the daemon. */
export type ClientMsg =
  | { t: 'hello'; kind: 'session'; session: SessionInfo }
  | { t: 'hello'; kind: 'hook' }
  | { t: 'hello'; kind: 'cli' }
  /** An MCP tool call forwarded from the session's shim. */
  | { t: 'call'; cid: number; name: string; args: Record<string, unknown> }
  /** Claude Code wants permission for a tool; render it as buttons. */
  | { t: 'permission_request'; request_id: string; tool_name: string; description: string; input_preview: string }
  /** Session title changed (Claude Code assigned an `ai-title`). */
  | { t: 'retitle'; title: string }
  | { t: 'bye' }
  /**
   * A Claude Code hook event. The hook is a short-lived process, so it carries
   * the addressing (`session_id`, `cwd`, `transcript`) in every frame instead of
   * registering. The daemon mirrors the turn by reading the transcript itself.
   */
  | { t: 'hook'; event: HookEvent; session_id: string; cwd: string; transcript: string }
  /** The CLI asking for `DaemonStatus`. */
  | { t: 'status' }
  /** The CLI asking the daemon to exit. */
  | { t: 'stop' }

export type HookEvent = 'UserPromptSubmit' | 'PostToolUse' | 'Stop' | 'SessionEnd' | 'Notification'

/** Frames the daemon sends back. */
export type DaemonMsg =
  | { t: 'welcome'; botUsername: string; version: string; topicsEnabled: boolean }
  | { t: 'result'; cid: number; ok: true; text: string }
  | { t: 'result'; cid: number; ok: false; error: string }
  /** A Telegram message routed to this session, shaped as a channel notification. */
  | { t: 'inbound'; params: unknown }
  | { t: 'permission_reply'; request_id: string; behavior: 'allow' | 'deny' }
  | { t: 'ask_answer'; ask_id: string; choice: string }
  /** The user tapped "interrupt" in Telegram; the shim raises SIGINT on itself. */
  | { t: 'interrupt' }
  | { t: 'status'; status: DaemonStatus }

/**
 * Wrap a socket with newline-delimited JSON framing. `onMsg` runs for each
 * complete line; the returned function serializes and frames one object.
 * Parse failures go to `onError` rather than tearing the connection down — a
 * single corrupt frame must not drop a session that is otherwise healthy.
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
      sock.write(`${JSON.stringify(obj)}\n`)
    } catch (err) {
      onError?.(err)
    }
  }
}
