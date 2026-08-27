/**
 * Whether Claude Code has this plugin installed.
 *
 * The `--channels plugin:…` flag names a plugin, so without the install it
 * resolves to nothing and the session starts perfectly normally with no bridge
 * attached. Nothing reports that — not the flag, not the session, not the
 * daemon, which never hears from anyone. Setup and doctor check it instead.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeHome } from '../paths.ts'

export const PLUGIN_NAME = 'claude-telegram'
export const MARKETPLACE = 'flxxxxddd/claude-telegram'

/** Is `claude-telegram@<any marketplace>` installed for this user? */
export function pluginInstalled(): boolean {
  try {
    const raw = readFileSync(join(claudeHome(), 'plugins', 'installed_plugins.json'), 'utf8')
    const parsed = JSON.parse(raw) as { plugins?: Record<string, unknown> }
    return Object.keys(parsed.plugins ?? {}).some(key => key.split('@')[0] === PLUGIN_NAME)
  } catch {
    return false
  }
}

/** What to run to install it, in the order it has to be run. */
export const INSTALL_STEPS = [
  `claude plugin marketplace add ${MARKETPLACE}`,
  `claude plugin install ${PLUGIN_NAME}@${PLUGIN_NAME}`,
] as const

/**
 * Whether Claude Code will let this plugin push inbound messages.
 *
 * Channels have a second gate, separate from everything else: only plugins on
 * an approved list may inject messages into a session. A self-installed plugin
 * is not on it, so without either `--dangerously-load-development-channels` or
 * an explicit entry in managed settings, the bridge half-works — turns mirror,
 * topics fill, and everything typed to the bot is dropped after one line at
 * startup. That asymmetry is why this is worth checking rather than leaving to
 * the user to notice.
 */
export function inboundAllowlisted(): boolean {
  for (const path of MANAGED_SETTINGS_PATHS) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
        allowedChannelPlugins?: { marketplace?: string; plugin?: string }[]
      }
      if (parsed.allowedChannelPlugins?.some(entry => entry.plugin === PLUGIN_NAME)) return true
    } catch {
      // Absent or unreadable: this machine has no managed settings, which is
      // the normal case and simply means the flag is required.
    }
  }
  return false
}

/** Where managed settings live, per platform. Both are root-owned. */
export const MANAGED_SETTINGS_PATHS = process.platform === 'darwin'
  ? ['/Library/Application Support/ClaudeCode/managed-settings.json']
  : ['/etc/claude-code/managed-settings.json']

/**
 * The flag that lifts the inbound gate for one session.
 *
 * It takes the same tagged entry `--channels` does; passing it bare fails with
 * `option '--dangerously-load-development-channels <servers...>' argument
 * missing`. It is also ignored entirely under `--print`, where there is no
 * interactive session for a message to reach.
 */
export const DEV_CHANNELS_FLAG =
  '--dangerously-load-development-channels plugin:claude-telegram@claude-telegram'
