/**
 * Turning a session's state into Telegram rich messages.
 *
 * Rich messages are a block tree, not a flat text+entities pair, so a turn keeps
 * its structure: prose stays paragraphs, the tool trail collapses into a
 * `<details>` the reader can open, and the pinned status is a real table.
 *
 * Nothing here talks to Telegram. It builds documents; `stream.ts` and `hud.ts`
 * decide when to send them.
 */

import {
  blockquote,
  bold,
  cell,
  code,
  details,
  document,
  footer,
  heading,
  italic,
  list,
  paragraph,
  preformatted,
  table,
  thinking,
  type Insertable,
  type RichDocument,
} from '@yaebal/rich'
import type { Locale, Strings } from '../i18n/index.ts'
import type { TurnSnapshot } from '../mirror/transcript.ts'

/** Lifecycle of a session as the status message reports it. */
export type SessionState = 'idle' | 'working' | 'waiting' | 'done' | 'offline' | 'error'

const STATE_DOT: Record<SessionState, string> = {
  idle: '⚪',
  working: '🔵',
  waiting: '🟡',
  done: '🟢',
  offline: '⚫',
  error: '🔴',
}

/** Dynamic key lookup would defeat the dictionary's compile-time checking. */
const STATE_KEY = {
  idle: 'state.idle',
  working: 'state.working',
  waiting: 'state.waiting',
  done: 'state.done',
  offline: 'state.offline',
  error: 'state.error',
} as const

/**
 * Context window per model family, in tokens. Only used to draw a percentage —
 * an unknown model falls back to the common window rather than inventing a
 * flattering number.
 */
const DEFAULT_WINDOW = 200_000

export function contextWindow(_model: string | undefined): number {
  return DEFAULT_WINDOW
}

/** `128k` — compact enough for a table cell. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** `102.4k / 200k · 51%` */
export function formatContext(tokens: number, model: string | undefined): string {
  if (!tokens) return ''
  const window = contextWindow(model)
  return `${formatTokens(tokens)} / ${formatTokens(window)} · ${Math.round((tokens / window) * 100)}%`
}

/** Model ids are long, and the family is the only part worth a table cell. */
export function shortModel(model: string | undefined): string | undefined {
  return model?.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

/** Telegram caps a message; long prose is trimmed with the cut made explicit. */
const CAP = 3500
function capped(text: string): string {
  return text.length > CAP ? `${text.slice(0, CAP)}\n…` : text
}

export type RenderOptions = {
  t: Strings
  locale: Locale
  /** Show the tool trail. Off when the mirror posts activity separately. */
  showTools?: boolean
}

/* --------------------------------------------------------------- the turn -- */

/**
 * The turn as it stands. Used for both the live draft and the final message —
 * a live turn with nothing but a thought shows the thinking placeholder, which
 * Telegram animates; a finished one never does.
 */
export function renderTurn(snap: TurnSnapshot, o: RenderOptions): RichDocument {
  const blocks: Insertable[] = []

  if (!snap.prose.length && snap.thinking && !snap.complete) {
    blocks.push(thinking(capped(snap.thinking)))
  }

  for (const p of snap.prose) blocks.push(paragraph(capped(p)))

  if (o.showTools !== false && snap.tools.length) {
    blocks.push(details(
      o.t.t(o.locale, 'turn.toolsMany', { n: snap.tools.length }),
      [list(snap.tools.map(tool => paragraph(code(tool.line))))],
    ))
  }

  // A turn that produced nothing visible still needs a body — Telegram rejects
  // an empty rich message with a 400.
  if (!blocks.length) blocks.push(paragraph(o.t.t(o.locale, 'turn.complete')))

  return document(blocks)
}

/** The thinking placeholder on its own — the first thing a new turn shows. */
export function renderThinking(o: RenderOptions): RichDocument {
  return document([thinking(o.t.t(o.locale, 'turn.thinking'))])
}

/* ------------------------------------------------------------------- hud -- */

export type HudData = {
  state: SessionState
  project: string
  prompt?: string | null
  model?: string
  effort?: string
  contextTokens?: number
  branch?: string
  queued?: number
}

/**
 * The pinned status message: a headline, the prompt being worked on, and a
 * table of everything worth knowing at a glance. Redrawn in place on every
 * change, so it never scrolls away.
 */
export function renderHud(d: HudData, o: RenderOptions): RichDocument {
  const { t, locale } = o
  const unknown = t.t(locale, 'hud.unknown')
  const state = `${STATE_DOT[d.state]} ${t.t(locale, STATE_KEY[d.state])}`

  const rows: Insertable[][] = [
    [cell(t.t(locale, 'hud.project'), { header: true }), cell(bold(d.project), { header: true })],
    [cell(t.t(locale, 'hud.state')), cell(state)],
    [cell(t.t(locale, 'hud.model')), cell(shortModel(d.model) ?? unknown)],
    [cell(t.t(locale, 'hud.effort')), cell(d.effort ?? unknown)],
    [cell(t.t(locale, 'hud.context')), cell(formatContext(d.contextTokens ?? 0, d.model) || unknown)],
  ]
  if (d.branch) rows.push([cell(t.t(locale, 'hud.branch')), cell(code(d.branch))])
  if (d.queued) rows.push([cell(t.t(locale, 'hud.session')), cell(t.t(locale, 'project.queued', { n: d.queued }))])

  const blocks: Insertable[] = [heading(2, state)]
  if (d.prompt) blocks.push(blockquote([paragraph(capped(d.prompt.slice(0, 400)))]))
  blocks.push(table(rows, { bordered: true }))
  blocks.push(footer(italic(t.t(locale, 'hud.updated'))))

  return document(blocks)
}

/* ---------------------------------------------------------------- others -- */

/** A permission request, rendered above its allow/deny buttons. */
export function renderPermission(tool: string, preview: string, o: RenderOptions): RichDocument {
  const blocks: Insertable[] = [paragraph(o.t.t(o.locale, 'permission.ask', { tool }))]
  if (preview.trim()) blocks.push(preformatted(capped(preview)))
  return document(blocks)
}

/** The coalesced tool trail used by the `activity` mirror mode. */
export function renderActivity(lines: string[], o: RenderOptions): RichDocument {
  return document([details(
    o.t.t(o.locale, 'turn.toolsMany', { n: lines.length }),
    [list(lines.map(l => paragraph(code(l))))],
    { open: true },
  )])
}

/** A plain paragraph — the fallback whenever there is nothing to structure. */
export function renderText(text: string): RichDocument {
  return document([paragraph(capped(text))])
}
