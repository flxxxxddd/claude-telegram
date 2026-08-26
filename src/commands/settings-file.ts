/**
 * Reading and writing Claude Code's own `settings.json`.
 *
 * The mirror needs four hooks wired there. Editing a user's settings file is
 * the sort of thing that has to be surgical: this merges the hooks in and
 * leaves every other key exactly as it found it, including keys this version
 * has never heard of.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { claudeHome } from '../paths.ts'
import type { HookEvent } from '../protocol.ts'

export const HOOK_EVENTS: HookEvent[] = ['UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']

type HookEntry = { type?: string; command?: string }
type HookMatcher = { matcher?: string; hooks?: HookEntry[] }
type Settings = { hooks?: Record<string, HookMatcher[]> } & Record<string, unknown>

export function settingsPath(): string {
  return join(claudeHome(), 'settings.json')
}

export function readSettings(): Settings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8')) as unknown
    return raw && typeof raw === 'object' ? (raw as Settings) : {}
  } catch {
    return {}
  }
}

/** Is our hook already wired for every event the mirror needs? */
export function hooksInstalled(command: string): boolean {
  const hooks = readSettings().hooks ?? {}
  return HOOK_EVENTS.every(event =>
    (hooks[event] ?? []).some(matcher => (matcher.hooks ?? []).some(hook => hook.command === command)))
}

/**
 * Add our hook to each event, leaving anything already there untouched. The
 * same command is never added twice, so running setup again is a no-op.
 */
export function installHooks(command: string): { added: HookEvent[]; path: string } {
  const settings = readSettings()
  const hooks = { ...(settings.hooks ?? {}) }
  const added: HookEvent[] = []

  for (const event of HOOK_EVENTS) {
    const matchers = [...(hooks[event] ?? [])]
    const present = matchers.some(m => (m.hooks ?? []).some(h => h.command === command))
    if (present) continue
    // PostToolUse is the only one that matches on a tool name; the rest fire
    // unconditionally and a matcher there would be ignored.
    matchers.push(event === 'PostToolUse'
      ? { matcher: '*', hooks: [{ type: 'command', command }] }
      : { hooks: [{ type: 'command', command }] })
    hooks[event] = matchers
    added.push(event)
  }

  if (added.length) {
    const path = settingsPath()
    mkdirSync(dirname(path), { recursive: true })
    // Back up before the first edit: this is the user's file, not ours.
    if (existsSync(path)) writeFileSync(`${path}.cctg-backup`, readFileSync(path))
    writeFileSync(path, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`)
  }
  return { added, path: settingsPath() }
}

/** Remove our hook from every event, leaving the rest of the file alone. */
export function removeHooks(command: string): HookEvent[] {
  const settings = readSettings()
  const hooks = { ...(settings.hooks ?? {}) }
  const removed: HookEvent[] = []

  for (const event of HOOK_EVENTS) {
    const matchers = hooks[event]
    if (!matchers) continue
    const kept = matchers
      .map(m => ({ ...m, hooks: (m.hooks ?? []).filter(h => h.command !== command) }))
      .filter(m => (m.hooks ?? []).length > 0)
    if (kept.length !== matchers.length) removed.push(event)
    if (kept.length) hooks[event] = kept
    else delete hooks[event]
  }

  if (removed.length) writeFileSync(settingsPath(), `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`)
  return removed
}
