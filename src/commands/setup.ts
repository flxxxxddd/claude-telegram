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
import { loadAccess } from '../store/access.ts'
import { bad, bold, cyan, dim, heading, info, ok, warn } from '../ui.ts'
import { askStatus } from './client.ts'
import { HOOK_EVENTS, hooksInstalled, installHooks, settingsPath } from './settings-file.ts'

/**
 * The hook command written into `settings.json`. `cctg` is preferred — it
 * survives the plugin being moved or reinstalled — and the plugin-local path is
 * used when `cctg` is not on the PATH.
 */
export function hookCommand(): string {
  const onPath = spawnSync('command', ['-v', 'cctg'], { shell: true, encoding: 'utf8' }).status === 0
  if (onPath) return 'cctg hook'
  return `bun ${new URL('../../hooks/hook.ts', import.meta.url).pathname}`
}

/** The flag a session needs before any of this does anything. */
export const CHANNEL_FLAG = 'claude --channels plugin:claude-telegram@claude-telegram'

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
    if (hooksInstalled(command)) {
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

    console.log(heading('next'))
    if (!live) console.log(`  1. ${bold('cctg daemon start')}   ${dim('(or just open a Claude Code session)')}`)
    console.log(`  2. Start a session with ${bold(CHANNEL_FLAG)}`)
    if (!access.allowedUsers.length) {
      console.log(`  3. DM your bot; it replies with a code. Run ${bold('/cctg:access pair <code>')} in the session.`)
      console.log(`  4. Once you are in, ${bold('/cctg:access policy allowlist')} so strangers get nothing.`)
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
