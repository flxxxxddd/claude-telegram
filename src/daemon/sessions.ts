/**
 * The registry of live Claude Code sessions.
 *
 * A session exists for as long as its MCP shim holds the socket open. Sessions
 * are addressed by Claude Code's own session id, which is also the name of the
 * transcript file — that is what lets the mirror find the narrative without
 * being told where it is.
 */

import type { DaemonMsg, SessionInfo, SessionView } from '../protocol.ts'
import type { TurnMirror } from '../mirror/transcript.ts'
import type { SessionState } from '../telegram/render.ts'
import type { TurnStream } from '../telegram/stream.ts'

export type SessionEntry = {
  info: SessionInfo
  send: (msg: DaemonMsg) => void
  connectedAt: number
  state: SessionState
  /** Follows this session's transcript while it is connected. */
  mirror?: TurnMirror
  /** The turn currently being streamed, if any. */
  stream?: TurnStream
  /** Where this session posts. Set once the daemon knows a chat for it. */
  chatId?: string
  threadId?: number
  model?: string
  effort?: string
  contextTokens?: number
  branch?: string
  lastPrompt?: string | null
  /**
   * Whether a turn is open. Hook events can arrive more than once for one
   * turn — a plugin-declared hook and a hand-wired one both fire — and a
   * duplicate `Stop` would otherwise cancel the stream the first one is still
   * committing.
   */
  turnOpen?: boolean
}

export class SessionRegistry {
  private byId = new Map<string, SessionEntry>()

  add(info: SessionInfo, send: (msg: DaemonMsg) => void): SessionEntry {
    // A reconnect under the same id replaces the old entry rather than adding a
    // second: Claude Code restarts the shim on `/mcp reconnect` without ending
    // the session.
    this.byId.get(info.id)?.mirror?.stop()
    const entry: SessionEntry = { info, send, connectedAt: Date.now(), state: 'idle' }
    this.byId.set(info.id, entry)
    return entry
  }

  remove(id: string): SessionEntry | undefined {
    const entry = this.byId.get(id)
    if (!entry) return undefined
    entry.mirror?.stop()
    entry.stream?.cancel()
    this.byId.delete(id)
    return entry
  }

  /**
   * Move an entry to the session id Claude Code actually uses.
   *
   * A shim registers with `CLAUDE_CODE_SESSION_ID`, but that variable is not
   * guaranteed to be set for every way a session can start. The hook payload
   * always carries the real id, so the first hook for a project corrects the
   * registration — and with it, which transcript the mirror follows.
   */
  rebind(oldId: string, newId: string): SessionEntry | undefined {
    if (oldId === newId) return this.byId.get(oldId)
    const entry = this.byId.get(oldId)
    if (!entry) return undefined
    entry.mirror?.stop()
    entry.mirror = undefined
    entry.info = { ...entry.info, id: newId }
    this.byId.delete(oldId)
    this.byId.set(newId, entry)
    return entry
  }

  get(id: string): SessionEntry | undefined {
    return this.byId.get(id)
  }

  all(): SessionEntry[] {
    return [...this.byId.values()]
  }

  /** Every connected session for a project, newest connection first. */
  forProject(cwd: string): SessionEntry[] {
    return this.all()
      .filter(e => e.info.cwd === cwd)
      .sort((a, b) => b.connectedAt - a.connectedAt)
  }

  /** The session a chat falls back to when nothing else picks one. */
  mostRecent(): SessionEntry | undefined {
    return this.all().sort((a, b) => b.connectedAt - a.connectedAt)[0]
  }

  /** The shape `/sessions` and `cctg status` render. */
  views(): SessionView[] {
    return this.all()
      .sort((a, b) => b.connectedAt - a.connectedAt)
      .map(e => ({
        ...e.info,
        connectedAt: e.connectedAt,
        model: e.model,
        effort: e.effort,
        chatId: e.chatId,
        threadId: e.threadId,
        busy: e.state === 'working',
      }))
  }
}
