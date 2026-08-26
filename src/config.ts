/**
 * Configuration: `<state>/config.json` for durable choices, the environment for
 * secrets and per-run overrides. The environment always wins, so a shell export
 * can redirect one run without editing (and dirtying) the shared file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { paths } from './paths.ts'

export type ThreadMode = 'auto' | 'topics' | 'flat'
export type MirrorMode = 'full' | 'activity' | 'off'
export type Locale = 'en' | 'ru'

export type Config = {
  /** `auto` uses topics when the bot has topic mode enabled; see telegram/topics.ts. */
  threadMode: ThreadMode
  /** How much of a turn reaches Telegram. `full` reads the transcript. */
  mirror: MirrorMode
  /** Fallback UI language before a chat picks one. */
  locale: Locale
  /**
   * Shell template used to start a session from Telegram. `{cwd}` and `{name}`
   * are substituted. Empty means the bot prints the command instead of running
   * it — spawning a shell on a stranger's say-so is opt-in, always.
   */
  launchCmd: string
  /** Directories offered by `/new`, in addition to those the daemon has seen. */
  projects: string[]
  /** Stream partial answers as an ephemeral rich draft while Claude works. */
  streaming: boolean
  /** Keep a pinned status message per topic, updated as the session works. */
  pinnedStatus: boolean
}

const DEFAULTS: Config = {
  threadMode: 'auto',
  mirror: 'full',
  locale: 'en',
  launchCmd: '',
  projects: [],
  streaming: true,
  pinnedStatus: true,
}

function readFile(): Partial<Config> {
  try {
    const raw = JSON.parse(readFileSync(paths.config, 'utf8')) as unknown
    return raw && typeof raw === 'object' ? (raw as Partial<Config>) : {}
  } catch {
    return {}
  }
}

const oneOf = <T extends string>(v: string | undefined, allowed: readonly T[]): T | undefined =>
  v !== undefined && (allowed as readonly string[]).includes(v) ? (v as T) : undefined

/** Effective configuration: defaults ← file ← environment. */
export function loadConfig(): Config {
  const file = readFile()
  return {
    ...DEFAULTS,
    ...file,
    threadMode: oneOf(process.env.TELEGRAM_THREAD_MODE, ['auto', 'topics', 'flat'] as const)
      ?? file.threadMode ?? DEFAULTS.threadMode,
    mirror: oneOf(process.env.CCTG_MIRROR, ['full', 'activity', 'off'] as const)
      ?? file.mirror ?? DEFAULTS.mirror,
    locale: oneOf(process.env.CCTG_LOCALE, ['en', 'ru'] as const)
      ?? file.locale ?? DEFAULTS.locale,
    launchCmd: process.env.TELEGRAM_LAUNCH_CMD ?? file.launchCmd ?? DEFAULTS.launchCmd,
  }
}

/**
 * Merge `patch` into the file. Only the keys in `patch` are written back —
 * everything else keeps whatever the user (or a future version) put there, so
 * saving one setting never silently reverts another.
 */
export function saveConfig(patch: Partial<Config>): void {
  mkdirSync(dirname(paths.config), { recursive: true })
  writeFileSync(paths.config, `${JSON.stringify({ ...readFile(), ...patch }, null, 2)}\n`, { mode: 0o600 })
}

/**
 * The bot token, from the environment or from `<state>/.env`. Never from
 * `config.json` — that file is meant to be readable and diffable.
 */
export function botToken(): string | undefined {
  const fromEnv = process.env.TELEGRAM_BOT_TOKEN?.trim()
  if (fromEnv) return fromEnv
  if (!existsSync(paths.env)) return undefined
  for (const line of readFileSync(paths.env, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?TELEGRAM_BOT_TOKEN\s*=\s*(.*)$/.exec(line)
    if (m?.[1]) return m[1].trim().replace(/^["']|["']$/g, '')
  }
  return undefined
}

/** Write the token to `<state>/.env` with an owner-only mode. */
export function saveBotToken(token: string): void {
  mkdirSync(dirname(paths.env), { recursive: true })
  const keep = existsSync(paths.env)
    ? readFileSync(paths.env, 'utf8').split('\n').filter(l => !/^\s*(?:export\s+)?TELEGRAM_BOT_TOKEN\s*=/.test(l))
    : []
  const body = [...keep.filter(Boolean), `TELEGRAM_BOT_TOKEN=${token}`].join('\n')
  writeFileSync(paths.env, `${body}\n`, { mode: 0o600 })
}

/** A token is `<numeric bot id>:<35 url-safe chars>`; reject anything else early. */
export function looksLikeToken(token: string): boolean {
  return /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token.trim())
}
