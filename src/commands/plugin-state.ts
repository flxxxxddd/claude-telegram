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
