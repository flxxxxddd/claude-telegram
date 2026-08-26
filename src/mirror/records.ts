/**
 * The shape of Claude Code's transcript, as much of it as the mirror needs.
 *
 * A transcript is JSONL at `~/.claude/projects/<slug>/<session-id>.jsonl`, one
 * record per line, appended as the turn runs. Everything here was observed in
 * Claude Code 2.1.246; unknown record types and unknown content blocks are
 * ignored rather than treated as errors, because this file is not a published
 * interface and will grow fields.
 */

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content?: unknown; is_error?: boolean }
  | { type: string; [k: string]: unknown }

export type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export type Record_ =
  | {
      type: 'assistant'
      uuid: string
      sessionId: string
      cwd?: string
      gitBranch?: string
      isSidechain?: boolean
      effort?: string
      timestamp?: string
      message: { model?: string; content?: ContentBlock[]; usage?: Usage; stop_reason?: string | null }
    }
  | {
      type: 'user'
      uuid: string
      sessionId: string
      cwd?: string
      gitBranch?: string
      isSidechain?: boolean
      timestamp?: string
      message: { content?: string | ContentBlock[] }
    }
  | { type: 'ai-title'; aiTitle: string; sessionId: string }
  | { type: string; [k: string]: unknown }

/** Parse one JSONL line, returning `null` for a blank or truncated line. */
export function parseRecord(line: string): Record_ | null {
  if (!line.trim()) return null
  try {
    const value = JSON.parse(line) as unknown
    return value && typeof value === 'object' ? (value as Record_) : null
  } catch {
    // A partial trailing line: the writer is mid-append. The tailer keeps the
    // bytes and retries once the rest lands.
    return null
  }
}

/** Total tokens the model is carrying — what a context gauge should show. */
export function contextTokens(u: Usage | undefined): number {
  if (!u) return 0
  return (u.input_tokens ?? 0)
    + (u.cache_creation_input_tokens ?? 0)
    + (u.cache_read_input_tokens ?? 0)
    + (u.output_tokens ?? 0)
}

/**
 * The user's own prompt, or `null` when this `user` record is really a tool
 * result being fed back. Only the former starts a turn.
 */
export function userPrompt(rec: Record_): string | null {
  if (rec.type !== 'user') return null
  const content = (rec as Extract<Record_, { type: 'user' }>).message?.content
  if (typeof content === 'string') return content.trim() || null
  if (!Array.isArray(content)) return null
  if (content.some(b => b.type === 'tool_result')) return null
  const text = content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim()
  return text || null
}
