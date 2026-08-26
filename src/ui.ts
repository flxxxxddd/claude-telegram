/**
 * Terminal output for the CLI.
 *
 * Colour is dropped when stdout is not a TTY or `NO_COLOR` is set, so piping
 * `cctg status` into a file gives plain text rather than escape codes.
 */

const enabled = process.stdout.isTTY === true && !process.env.NO_COLOR

const wrap = (code: number) => (text: string): string =>
  enabled ? `\x1b[${code}m${text}\x1b[0m` : text

export const bold = wrap(1)
export const dim = wrap(2)
export const red = wrap(31)
export const green = wrap(32)
export const yellow = wrap(33)
export const blue = wrap(34)
export const cyan = wrap(36)

export const ok = (text: string): string => `${green('✓')} ${text}`
export const bad = (text: string): string => `${red('✗')} ${text}`
export const warn = (text: string): string => `${yellow('!')} ${text}`
export const info = (text: string): string => `${dim('·')} ${text}`

/** A two-column list with the labels padded to a common width. */
export function pairs(rows: [string, string][]): string {
  const width = Math.max(0, ...rows.map(([label]) => label.length))
  return rows.map(([label, value]) => `  ${dim(label.padEnd(width))}  ${value}`).join('\n')
}

/** A section heading with a rule under it, sized to the terminal. */
export function heading(text: string): string {
  const width = Math.min(process.stdout.columns ?? 80, 60)
  return `\n${bold(text)}\n${dim('─'.repeat(Math.max(text.length, width)))}`
}

/** Relative time, for "connected 4m ago". */
export function ago(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86400)}d ago`
}
