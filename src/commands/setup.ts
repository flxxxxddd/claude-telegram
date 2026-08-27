/**
 * `cctg setup` — the whole first run, in one place.
 *
 * Everything it does can be done by hand (write a token, edit `settings.json`,
 * pair from a skill), and every step says what it is about to do. It exists
 * because doing all of it by hand from a phone is where people give up.
 */

import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { botToken, loadConfig, looksLikeToken, saveBotToken, saveConfig } from '../config.ts'
import { paths } from '../paths.ts'
import { selfEntry } from '../self.ts'
import { loadAccess } from '../store/access.ts'
import { INSTALL_STEPS, inboundAllowlisted, pluginInstalled } from './plugin-state.ts'
import { bad, bold, cyan, dim, heading, info, ok, warn } from '../ui.ts'
import { askStatus } from './client.ts'
import { HOOK_EVENTS, hooksInstalled, installHooks, removeHooks, settingsPath } from './settings-file.ts'

/**
 * The hook command written into `settings.json`.
 *
 * `cctg hook` is preferred — it survives this artifact being moved or rebuilt.
 * Without `cctg` on the PATH the entry that is running right now is named
 * instead, which is the source file in development and the bundle after a
 * build; either way it is a file that exists.
 */
export function hookCommand(): string {
  if (spawnSync('command', ['-v', 'cctg'], { shell: true }).status === 0) return 'cctg hook'
  const { exec, script } = selfEntry()
  return `${exec} ${script} hook`
}

/** The flag a session needs before any of this does anything. */
export const CHANNEL_FLAG = 'claude --channels plugin:claude-telegram@claude-telegram '
  + '--dangerously-load-development-channels plugin:claude-telegram@claude-telegram'

export async function setup(args: string[]): Promise<number> {
  const hooksOnly = args.includes('--hooks')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = async (question: string): Promise<string> => (await rl.question(question)).trim()

  try {
    console.log(heading('cctg setup'))

    if (!hooksOnly) {
      const existing = botToken()
      if (existing) {
        console.log(ok(`a token is already stored (${existing.split(':')[0]})`))
      } else {
        console.log(info('Create a bot: open @BotFather, send /newbot, and copy the token it replies with.'))
        const token = await ask(`${cyan('token')} > `)
        if (!looksLikeToken(token)) {
          console.log(bad('that is not shaped like a Telegram token (<bot id>:<secret>)'))
          return 1
        }
        saveBotToken(token)
        console.log(ok(`saved to ${paths.env}`))
      }

      console.log(info('Topic Mode gives every project its own thread inside your DM with the bot.'))
      console.log(info('Turn it on in @BotFather: Bot Settings → Topic Mode → Enable.'))
      const locale = await ask(`${cyan('interface language')} [en/ru] > `)
      if (locale === 'ru' || locale === 'en') {
        saveConfig({ locale })
        console.log(ok(`interface language set to ${locale}`))
      }
    }

    const command = hookCommand()
    if (pluginInstalled()) {
      // The plugin declares the same four hooks. Wiring them here as well
      // delivers every event twice, and a duplicate `Stop` cancels the message
      // the first one is still sending — so the plugin owns them alone.
      console.log(ok('mirror hooks come from the plugin'))
      const removed = removeHooks(command)
      if (removed.length) console.log(ok(`removed the duplicate copy in ${settingsPath()}`))
    } else if (hooksInstalled(command)) {
      console.log(ok('mirror hooks already wired'))
    } else {
      console.log(info(`The mirror needs ${HOOK_EVENTS.length} hooks in ${settingsPath()}.`))
      console.log(dim(`  ${command}`))
      const answer = await ask(`${cyan('add them now?')} [Y/n] > `)
      if (answer.toLowerCase().startsWith('n')) {
        console.log(warn('skipped — the pinned status and turn mirror stay off until they are wired'))
      } else {
        const { added, path } = installHooks(command)
        console.log(ok(`added ${added.join(', ')} to ${path}`))
      }
    }

    const config = loadConfig()
    const access = loadAccess()
    const live = await askStatus()
    const installed = pluginInstalled()

    console.log(heading('next'))
    if (!installed) {
      // The channel flag names a plugin. Without the install it resolves to
      // nothing and the session starts normally with no bridge attached, which
      // nothing anywhere reports.
      console.log(warn('the plugin is not installed — the channel flag does nothing without it'))
      for (const step of INSTALL_STEPS) console.log(`     ${bold(step)}`)
    }
    if (!live) console.log(`  ${ok('')}${bold('cctg daemon start')}   ${dim('(or just open a Claude Code session)')}`)
    console.log(`  Start a session with ${bold(CHANNEL_FLAG)}`)
    if (!inboundAllowlisted()) {
      console.log(`     ${dim('the second flag is what lets your Telegram messages reach the session')}`)
    }
    if (!access.allowedUsers.length) {
      console.log(`  DM your bot; it replies with a code. Run ${bold('/cctg:access pair <code>')} in the session.`)
      console.log(`  Once you are in, ${bold('/cctg:access policy allowlist')} so strangers get nothing.`)
    }
    if (!config.launchCmd) {
      console.log(`\n${info('To start sessions from Telegram, set TELEGRAM_LAUNCH_CMD, e.g.')}`)
      console.log(dim(`  export TELEGRAM_LAUNCH_CMD="tmux new-session -d -s cctg_{name} -c {cwd} '{claude}'"`))
    }
    return 0
  } finally {
    rl.close()
  }
}
