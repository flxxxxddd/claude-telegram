/**
 * The Claude Code hook that drives the mirror.
 *
 * Claude Code passes a JSON payload on stdin for each event; this ships the
 * three fields the daemon needs — which session, which directory, which
 * transcript — over the same UNIX socket the shim uses, and returns.
 *
 * It is deliberately dumb. Every decision about what to post belongs to the
 * daemon, which can see the whole turn; a hook runs inside the user's turn, so
 * anything slow or fallible here is felt as latency in the terminal. It never
 * blocks for more than a moment and never fails the turn.
 */

import { connect } from 'node:net'
import { paths, transcriptPath } from '../paths.ts'
import type { ClientMsg, HookEvent } from '../protocol.ts'

const EVENTS: HookEvent[] = ['UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd', 'Notification']

/** Read stdin, but never wait on it — a hook that hangs hangs the turn. */
async function readPayload(): Promise<Record<string, unknown>> {
  const raw = await new Promise<string>(resolve => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => (buf += chunk))
    process.stdin.on('end', () => resolve(buf))
    setTimeout(() => resolve(buf), 1000)
  })
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Ship one frame and go. A missing daemon is silence, not an error. */
function ship(msg: ClientMsg): Promise<void> {
  return new Promise(resolve => {
    const sock = connect(paths.sock)
    const done = (): void => {
      sock.destroy()
      resolve()
    }
    sock.on('connect', () => sock.write(`${JSON.stringify(msg)}\n`, () => setTimeout(done, 30)))
    sock.on('error', done)
    setTimeout(done, 800)
  })
}

/** Read one hook event from stdin and forward it to the daemon. */
export async function runHook(): Promise<void> {
  const payload = await readPayload()
  const event = payload.hook_event_name
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : ''
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd()
  if (typeof event !== 'string' || !(EVENTS as string[]).includes(event) || !sessionId) return

  await ship({
    t: 'hook',
    event: event as HookEvent,
    session_id: sessionId,
    cwd,
    // Claude Code supplies the path, but derive it too so a payload without one
    // still points at the right file.
    transcript: typeof payload.transcript_path === 'string'
      ? payload.transcript_path
      : transcriptPath(cwd, sessionId),
  })
}
