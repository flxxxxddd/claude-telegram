/**
 * One line per tool call — what the collapsed "ran N steps" section shows.
 *
 * These strings land in a Telegram message, so they are truncated hard and the
 * arguments most likely to carry a secret (a full command line, a URL with a
 * query string) are cut before anything else.
 */

import type { ContentBlock } from './records.ts'

const trunc = (v: unknown, n: number): string => {
  const s = typeof v === 'string' ? v : ''
  return s.length > n ? `${s.slice(0, n)}…` : s
}

const base = (p: unknown): string => (typeof p === 'string' ? (p.split('/').pop() ?? p) : '')

/** A short, human label for a single tool call. */
export function summarizeTool(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
      return `$ ${trunc(input.command, 90)}`
    case 'Read':
      return `read ${base(input.file_path)}`
    case 'Write':
      return `write ${base(input.file_path)}`
    case 'Edit':
    case 'MultiEdit':
      return `edit ${base(input.file_path)}`
    case 'NotebookEdit':
      return `edit ${base(input.notebook_path)}`
    case 'Grep':
      return `grep ${trunc(input.pattern, 60)}`
    case 'Glob':
      return `glob ${trunc(input.pattern, 60)}`
    case 'WebFetch':
      return `fetch ${trunc(hostOf(input.url), 60)}`
    case 'WebSearch':
      return `search ${trunc(input.query, 60)}`
    case 'Task':
    case 'Agent':
      return `agent: ${trunc(input.description, 60)}`
    case 'TodoWrite':
      return 'updated the plan'
    default:
      return name.startsWith('mcp__') ? `mcp ${name.split('__').slice(1).join(' ')}` : name
  }
}

/** Host only — a URL's query string is where tokens hide. */
function hostOf(url: unknown): string {
  if (typeof url !== 'string') return ''
  try {
    return new URL(url).host
  } catch {
    return url.split('?')[0] ?? url
  }
}

/** Group repeated tools into `Bash ×4, Read ×2` for a one-line heading. */
export function summarizeCounts(calls: { name: string }[]): string {
  const counts = new Map<string, number>()
  for (const c of calls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1)
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    .join(', ')
}

export const isToolUse = (b: ContentBlock): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
  b.type === 'tool_use'
