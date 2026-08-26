/**
 * Follows a session's transcript and assembles it into turns.
 *
 * Claude Code appends a record per API response, not per token, so a "stream"
 * here is a sequence of whole thinking blocks, prose paragraphs and tool calls.
 * That is the same granularity the terminal shows, and it is what the Telegram
 * draft renders as it grows.
 *
 * The file is followed by offset, never re-read from the start: a long session's
 * transcript reaches megabytes and re-parsing it on every poke would put the
 * daemon in a permanent read loop.
 */

import { closeSync, openSync, readSync, statSync, watch, type FSWatcher } from 'node:fs'
import { contextTokens, parseRecord, userPrompt, type ContentBlock, type Record_ } from './records.ts'
import { isToolUse, summarizeTool } from './summarize.ts'

export type ToolCall = { name: string; line: string }

/** Everything the renderer needs to draw the turn as it stands right now. */
export type TurnSnapshot = {
  sessionId: string
  cwd: string
  prompt: string | null
  /** Assistant prose, one entry per text block, in order. */
  prose: string[]
  /** The latest thinking block, shown only while there is no prose yet. */
  thinking: string | null
  tools: ToolCall[]
  model?: string
  effort?: string
  contextTokens: number
  branch?: string
  title?: string
  startedAt: number
  complete: boolean
}

const emptyTurn = (sessionId: string, cwd: string): TurnSnapshot => ({
  sessionId,
  cwd,
  prompt: null,
  prose: [],
  thinking: null,
  tools: [],
  contextTokens: 0,
  startedAt: Date.now(),
  complete: false,
})

/**
 * Reads whatever has been appended to a file since the last call. A trailing
 * partial line is held back rather than parsed, so a record split across two
 * reads is never dropped.
 */
export class TranscriptTail {
  private offset = 0
  private pending = ''

  constructor(readonly path: string) {}

  /** Start following from the end, ignoring history. */
  seekToEnd(): void {
    try {
      this.offset = statSync(this.path).size
    } catch {
      this.offset = 0
    }
    this.pending = ''
  }

  /** Every complete record appended since the previous read. */
  read(): Record_[] {
    let size: number
    try {
      size = statSync(this.path).size
    } catch {
      return []
    }
    // A shrunk file means the transcript was rotated or replaced; start over
    // rather than reading from an offset that now points mid-record.
    if (size < this.offset) {
      this.offset = 0
      this.pending = ''
    }
    if (size === this.offset) return []

    let chunk = ''
    try {
      const fd = openSync(this.path, 'r')
      try {
        const buf = Buffer.allocUnsafe(size - this.offset)
        const n = readSync(fd, buf, 0, buf.length, this.offset)
        chunk = buf.subarray(0, n).toString('utf8')
        this.offset += n
      } finally {
        closeSync(fd)
      }
    } catch {
      return []
    }

    const lines = (this.pending + chunk).split('\n')
    this.pending = lines.pop() ?? ''
    const out: Record_[] = []
    for (const line of lines) {
      const rec = parseRecord(line)
      if (rec) out.push(rec)
    }
    return out
  }
}

export type MirrorEvents = {
  /** The turn grew: new prose, a new tool call, a new thought. */
  onUpdate?: (snap: TurnSnapshot) => void
  /** The turn ended. Fires once per turn, after a final read. */
  onComplete?: (snap: TurnSnapshot) => void
  /** Claude Code named the session; the topic should be renamed to match. */
  onTitle?: (title: string) => void
}

/**
 * Follows one session's transcript, turning records into `TurnSnapshot`s.
 *
 * Sidechain records (subagents) are skipped: a fan-out of five agents would
 * otherwise interleave five unrelated narratives into one Telegram message.
 */
export class TurnMirror {
  private tail: TranscriptTail
  private watcher: FSWatcher | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private turn: TurnSnapshot
  private title: string | undefined

  constructor(
    readonly sessionId: string,
    readonly cwd: string,
    readonly path: string,
    private events: MirrorEvents,
  ) {
    this.tail = new TranscriptTail(path)
    this.turn = emptyTurn(sessionId, cwd)
  }

  /** Begin following from the end of the file — history is not replayed. */
  start(): void {
    this.tail.seekToEnd()
    this.watch()
  }

  /**
   * Watch the file and also poll. `fs.watch` misses appends on some filesystems
   * (network mounts, and macOS under heavy write load), and a status message
   * that silently stops updating is worse than one that updates a beat late.
   */
  private watch(): void {
    if (this.watcher || this.timer) return
    try {
      this.watcher = watch(this.path, () => this.poke())
    } catch {
      // The file does not exist yet — the poll below picks it up when it does.
    }
    this.timer = setInterval(() => this.poke(), 500)
    this.timer.unref?.()
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = undefined
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Read whatever is new and fire the events it implies. */
  poke(): void {
    const records = this.tail.read()
    if (!records.length) return
    let changed = false
    for (const rec of records) changed = this.apply(rec) || changed
    if (changed && !this.turn.complete) this.events.onUpdate?.(this.snapshot())
  }

  /**
   * Close the current turn. Called from the `Stop` hook, which fires after the
   * last record is written, so one final read catches the closing prose.
   */
  finish(): TurnSnapshot {
    this.poke()
    const records = this.tail.read()
    for (const rec of records) this.apply(rec)
    this.turn.complete = true
    const snap = this.snapshot()
    this.events.onComplete?.(snap)
    this.turn = emptyTurn(this.sessionId, this.cwd)
    return snap
  }

  /** The turn as it stands, safe to hand to a renderer. */
  snapshot(): TurnSnapshot {
    return { ...this.turn, title: this.title, prose: [...this.turn.prose], tools: [...this.turn.tools] }
  }

  /** True while a turn has produced nothing at all — nothing worth posting. */
  get empty(): boolean {
    return !this.turn.prose.length && !this.turn.tools.length && !this.turn.thinking
  }

  private apply(rec: Record_): boolean {
    if (rec.type === 'ai-title') {
      const title = (rec as { aiTitle?: string }).aiTitle?.trim()
      if (title && title !== this.title) {
        this.title = title
        this.events.onTitle?.(title)
      }
      return false
    }

    if ((rec as { isSidechain?: boolean }).isSidechain) return false

    if (rec.type === 'user') {
      const prompt = userPrompt(rec)
      if (prompt === null) return false
      // A fresh prompt starts a fresh turn even if the previous one was never
      // closed — an interrupted turn leaves no Stop hook behind.
      this.turn = emptyTurn(this.sessionId, this.cwd)
      this.turn.prompt = prompt
      const branch = (rec as { gitBranch?: string }).gitBranch
      if (branch) this.turn.branch = branch
      return true
    }

    if (rec.type !== 'assistant') return false
    const a = rec as Extract<Record_, { type: 'assistant' }>
    let changed = false

    if (a.message?.model) this.turn.model = a.message.model
    if (a.effort) this.turn.effort = a.effort
    if (a.gitBranch) this.turn.branch = a.gitBranch
    const ctx = contextTokens(a.message?.usage)
    if (ctx > this.turn.contextTokens) this.turn.contextTokens = ctx

    for (const block of (a.message?.content ?? []) as ContentBlock[]) {
      if (block.type === 'thinking') {
        const text = (block as { thinking?: string }).thinking?.trim()
        if (text) {
          this.turn.thinking = text
          changed = true
        }
      } else if (block.type === 'text') {
        const text = (block as { text?: string }).text?.trim()
        if (text) {
          this.turn.prose.push(text)
          this.turn.thinking = null
          changed = true
        }
      } else if (isToolUse(block)) {
        this.turn.tools.push({ name: block.name, line: summarizeTool(block.name, block.input ?? {}) })
        changed = true
      }
    }
    return changed
  }
}
