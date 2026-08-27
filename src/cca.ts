/**
 * Reading claude-account-manager's state.
 *
 * `cca` stores several Claude.ai logins and points Claude Code at one of them.
 * This bridge cares about two questions it can answer: which account a session
 * is running as, and how much of that account's quota is left — because "when
 * will this stop working" is the thing you actually want to know from a phone.
 *
 * Everything here is read-only and file-based. `cca list` fetches live limits
 * over the network, which is wrong for a status message redrawn several times a
 * second; the cache under `~/.ccacc/cache/usage/` is the same data cca's own
 * status line reads, and reading it costs nothing. It is a private layout, so
 * every field is treated as optional and a shape that has moved on degrades to
 * "no account information" rather than to a crash.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** cca's home, overridable exactly as cca overrides it. */
export function ccaHome(): string {
  return process.env.CCA_HOME ?? join(homedir(), '.ccacc')
}

const configPath = (): string => join(ccaHome(), 'config.json')
const usagePath = (name: string): string => join(ccaHome(), 'cache', 'usage', `${name}.json`)

/** One rate-limit window as cca caches it. */
export type Window = {
  /** Percent of the window consumed, 0–100. */
  utilization: number
  /** When it resets, in ms since the epoch, when cca reported one. */
  resetsAt?: number
}

export type Account = {
  name: string
  email?: string
  /** `shared` swaps credentials only; `isolated` swaps the whole config dir. */
  mode?: 'shared' | 'isolated'
  dir: string
  active: boolean
  /** The five-hour session window — the one that stops you mid-task. */
  session?: Window
  /** The seven-day window. */
  weekly?: Window
  /** When the cached usage was fetched, in ms. */
  fetchedAt?: number
}

type ConfigFile = {
  activeProfile?: string
  profiles?: Record<string, { dir?: string; email?: string; mode?: string }>
}

type UsageFile = {
  fetchedAt?: number
  usage?: {
    five_hour?: { utilization?: number; resets_at?: string | null }
    seven_day?: { utilization?: number; resets_at?: string | null }
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

/** cca reports `resets_at` as an ISO string; everything here is milliseconds. */
function parseReset(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

function readWindow(w: { utilization?: number; resets_at?: string | null } | undefined): Window | undefined {
  if (!w || typeof w.utilization !== 'number') return undefined
  return { utilization: w.utilization, resetsAt: parseReset(w.resets_at) }
}

/** Is cca set up on this machine at all? */
export function ccaPresent(): boolean {
  return existsSync(configPath())
}

/** Is the `cca` binary runnable, which is what launching a session needs? */
export function ccaRunnable(): boolean {
  return spawnSync('command', ['-v', 'cca'], { shell: true }).status === 0
}

/** Every profile cca knows, with whatever usage is cached for it. */
export function accounts(): Account[] {
  const config = readJson<ConfigFile>(configPath())
  if (!config?.profiles) return []
  return Object.entries(config.profiles).map(([name, profile]) => {
    const usage = readJson<UsageFile>(usagePath(name))
    return {
      name,
      email: profile.email,
      mode: profile.mode === 'isolated' ? 'isolated' : 'shared',
      dir: profile.dir ?? '',
      active: config.activeProfile === name,
      session: readWindow(usage?.usage?.five_hour),
      weekly: readWindow(usage?.usage?.seven_day),
      fetchedAt: usage?.fetchedAt,
    }
  })
}

export function account(name: string): Account | undefined {
  return accounts().find(a => a.name === name)
}

/**
 * The profile the current process is running as.
 *
 * cca points Claude Code at a profile by setting one of two variables to that
 * profile's directory, so matching on the directory identifies it exactly —
 * no guessing from a basename that a rename would break.
 */
export function currentAccount(env: NodeJS.ProcessEnv = process.env): Account | undefined {
  const dir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR
  if (!dir) return undefined
  const target = resolve(dir)
  return accounts().find(a => a.dir && resolve(a.dir) === target)
}

/**
 * The account with the most room left, which is what `cca run --best` picks.
 *
 * Ranked by the window that will actually stop you: the five-hour session
 * window first, the weekly one only as a tie-break. An account with no cached
 * usage sorts last rather than first — unknown is not the same as empty, and
 * sending a turn to an account that turns out to be spent wastes the trip.
 */
export function bestAccount(list: Account[] = accounts()): Account | undefined {
  const score = (a: Account): number => {
    if (!a.session && !a.weekly) return -1
    return 100 - Math.max(a.session?.utilization ?? 0, (a.weekly?.utilization ?? 0) / 2)
  }
  return [...list].sort((a, b) => score(b) - score(a))[0]
}

/** The window that matters most for an account right now. */
export function tightestWindow(a: Account): Window | undefined {
  if (!a.session) return a.weekly
  if (!a.weekly) return a.session
  return a.session.utilization >= a.weekly.utilization ? a.session : a.weekly
}

/** `04:40` — a reset time is only useful to the minute. */
export function formatReset(at: number | undefined): string | undefined {
  if (!at) return undefined
  const delta = at - Date.now()
  if (delta <= 0) return undefined
  const hours = Math.floor(delta / 3_600_000)
  const minutes = Math.round((delta % 3_600_000) / 60_000)
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

/** `60% · 2h 14m` — a table cell's worth of a window. */
export function formatWindow(w: Window | undefined): string | undefined {
  if (!w) return undefined
  const reset = formatReset(w.resetsAt)
  return reset ? `${Math.round(w.utilization)}% · ${reset}` : `${Math.round(w.utilization)}%`
}

/** The sentinel stored when a project should use whichever account has room. */
export const BEST_ACCOUNT = '@best'

/**
 * The `cca` prefix that launches a session as `name`, or nothing when cca
 * cannot run it. `@best` becomes `--best`, which is cca's own ranking rather
 * than a second opinion computed here.
 */
export function ccaPrefix(name: string | null): string {
  if (!name || !ccaRunnable()) return ''
  return name === BEST_ACCOUNT ? 'cca run --best -- ' : `cca run ${shellName(name)} -- `
}

/** Profile names are `[A-Za-z0-9_-]` in practice; refuse anything else. */
function shellName(name: string): string {
  return /^[A-Za-z0-9._-]+$/.test(name) ? name : `'${name.replaceAll("'", `'\\''`)}'`
}
