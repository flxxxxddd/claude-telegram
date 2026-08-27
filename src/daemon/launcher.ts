/**
 * Starting a Claude Code session from Telegram.
 *
 * Spawning a shell because a chat message asked is exactly the sort of thing
 * that should be opt-in, so it only happens when `TELEGRAM_LAUNCH_CMD` is set.
 * Without it the bot prints the command it *would* have run and the user
 * decides. The template is the user's own shell line, so it can point at tmux,
 * a terminal emulator, or anything else that survives the daemon.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { ccaPrefix } from '../cca.ts'
import type { Config } from '../config.ts'
import { projectName } from '../paths.ts'
import type { ProjectSettings } from '../db.ts'

/**
 * How a session names this bridge on the command line.
 *
 * Channel entries are tagged: `plugin:<name>@<marketplace>` for one a plugin
 * provides, `server:<name>` for a hand-configured MCP server. Both flags take
 * the same tagged form, space-separated.
 */
export const CHANNEL_ID = 'plugin:claude-telegram@claude-telegram'

/** The flag that registers this session for inbound messages. */
export const CHANNEL_FLAG = `--channels ${CHANNEL_ID}`

/**
 * Without this, Claude Code drops everything typed to the bot: only channel
 * plugins on its own approved list may inject messages. It takes the same
 * tagged entry as `--channels` — passing it bare is an option-parse error —
 * and it makes Claude Code show a confirmation dialog at startup.
 */
export const DEV_CHANNELS_FLAG = `--dangerously-load-development-channels ${CHANNEL_ID}`

/** Shell-quote a value so a path with a space cannot split into two arguments. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * The `claude` invocation implied by a project's stored settings.
 *
 * With an account chosen, it runs through `cca run`, which points Claude Code
 * at that login before starting it. `cca run --best` is passed through rather
 * than resolved here — picking the account is cca's job, and it knows things
 * this bridge does not, such as which logins are about to expire.
 */
export function claudeCommand(cwd: string, settings: ProjectSettings): string {
  const parts = ['claude', CHANNEL_FLAG, DEV_CHANNELS_FLAG]
  if (settings.model) parts.push(`--model ${settings.model}`)
  if (settings.effort) parts.push(`--effort ${settings.effort}`)
  if (settings.permission_mode) parts.push(`--permission-mode ${settings.permission_mode}`)
  // `cca run <name> -- <args>` forwards everything after `--` to claude, so the
  // prefix replaces the `claude` word rather than wrapping the whole line.
  const prefix = ccaPrefix(settings.account)
  const invocation = prefix ? `${prefix}${parts.slice(1).join(' ')}` : parts.join(' ')
  return `cd ${shellQuote(cwd)} && ${invocation}`
}

/**
 * Fill `{cwd}`, `{name}` and `{claude}` in the launch template. `{claude}` is
 * the full invocation including the channel flag and the project's settings, so
 * a template only has to say *where* to run it (`tmux new-session -d … '{claude}'`).
 */
export function renderLaunchCommand(template: string, cwd: string, settings: ProjectSettings): string {
  return template
    .replaceAll('{cwd}', shellQuote(cwd))
    .replaceAll('{name}', shellQuote(projectName(cwd)))
    .replaceAll('{claude}', claudeCommand(cwd, settings))
}

export type LaunchResult =
  | { spawned: true; command: string }
  | { spawned: false; reason: 'not-configured' | 'missing-directory' | 'failed'; command: string; detail?: string }

/**
 * Start a session, or explain why not. Never throws: this runs from a button
 * tap and the failure has to come back as a message, not as a daemon crash.
 */
export function launch(cwd: string, config: Config, settings: ProjectSettings): LaunchResult {
  const manual = claudeCommand(cwd, settings)
  if (!existsSync(cwd)) return { spawned: false, reason: 'missing-directory', command: manual }
  if (!config.launchCmd.trim()) return { spawned: false, reason: 'not-configured', command: manual }

  const command = renderLaunchCommand(config.launchCmd, cwd, settings)
  try {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CCTG_LAUNCHED: '1' },
    })
    child.unref()
    return { spawned: true, command }
  } catch (err) {
    return { spawned: false, reason: 'failed', command, detail: err instanceof Error ? err.message : String(err) }
  }
}
