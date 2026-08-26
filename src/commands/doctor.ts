/**
 * `cctg doctor` — check every link in the chain, and name the fix for each one
 * that is broken. A check that only reports a problem makes the user guess.
 */

import { existsSync } from 'node:fs'
import { botToken, loadConfig, looksLikeToken } from '../config.ts'
import { db } from '../db.ts'
import { paths } from '../paths.ts'
import { loadAccess } from '../store/access.ts'
import { topics } from '../store/repos.ts'
import { bad, dim, heading, info, ok, warn } from '../ui.ts'
import { askStatus } from './client.ts'
import { hookCommand } from './setup.ts'
import { INSTALL_STEPS, pluginInstalled } from './plugin-state.ts'
import { hooksInstalled, settingsPath } from './settings-file.ts'

type Check = { level: 'ok' | 'warn' | 'bad'; text: string; fix?: string }

const render = (check: Check): string => {
  const line = check.level === 'ok' ? ok(check.text) : check.level === 'warn' ? warn(check.text) : bad(check.text)
  return check.fix ? `${line}\n    ${dim(check.fix)}` : line
}

export async function doctor(): Promise<number> {
  const checks: Check[] = []
  const config = loadConfig()

  const token = botToken()
  if (!token) {
    checks.push({ level: 'bad', text: 'no bot token', fix: 'run `cctg setup`' })
  } else if (!looksLikeToken(token)) {
    checks.push({
      level: 'bad',
      text: 'the stored token is not shaped like a Telegram token',
      fix: `expected <bot id>:<secret>; check ${paths.env}`,
    })
  } else {
    checks.push({ level: 'ok', text: `token present (${token.split(':')[0]})` })
  }

  const live = await askStatus()
  if (live) {
    checks.push({ level: 'ok', text: `daemon ${live.version} running as @${live.botUsername} (pid ${live.pid})` })
    checks.push(live.topicsEnabled
      ? { level: 'ok', text: 'topic mode is on — every project gets its own thread' }
      : {
          level: 'warn',
          text: 'topic mode is off, so every chat carries one session at a time',
          fix: 'in @BotFather: Bot Settings → Topic Mode → Enable, then `cctg daemon restart`',
        })
    checks.push({
      level: live.sessions.length ? 'ok' : 'warn',
      text: `${live.sessions.length} session(s) connected`,
      fix: live.sessions.length
        ? undefined
        : 'start Claude Code with `--channels plugin:claude-telegram@claude-telegram`',
    })
  } else {
    checks.push({
      level: 'warn',
      text: 'no daemon is running',
      fix: 'run `cctg daemon start`, or open a Claude Code session — the first one starts it',
    })
  }

  const access = loadAccess()
  if (!access.allowedUsers.length && !access.allowedChats.length) {
    checks.push({
      level: 'warn',
      text: 'nobody is allowed yet',
      fix: 'DM the bot, then run `/cctg:access pair <code>` in your session',
    })
  } else {
    checks.push({
      level: 'ok',
      text: `${access.allowedUsers.length} user(s), ${access.allowedChats.length} chat(s) allowed · policy ${access.dmPolicy}`,
    })
    if (access.dmPolicy === 'pairing') {
      checks.push({
        level: 'warn',
        text: 'policy is still `pairing`, so strangers get a pairing code',
        fix: 'run `/cctg:access policy allowlist` once you are in',
      })
    }
  }

  checks.push(pluginInstalled()
    ? { level: 'ok', text: 'the plugin is installed' }
    : {
        level: 'bad',
        text: 'the plugin is not installed, so the channel flag resolves to nothing',
        fix: INSTALL_STEPS.join('  &&  '),
      })

  const command = hookCommand()
  checks.push(hooksInstalled(command)
    ? { level: 'ok', text: 'mirror hooks are wired' }
    : {
        level: config.mirror === 'off' ? 'ok' : 'warn',
        text: config.mirror === 'off' ? 'mirroring is off by configuration' : 'mirror hooks are not wired',
        fix: config.mirror === 'off' ? undefined : `run \`cctg setup --hooks\` to add them to ${settingsPath()}`,
      })

  checks.push(existsSync(paths.db)
    ? { level: 'ok', text: `state database at ${paths.db} (${topics.all(db()).length} topics)` }
    : { level: 'warn', text: 'no state database yet — it is created on first run' })

  console.log(heading('cctg doctor'))
  for (const check of checks) console.log(render(check))
  console.log(`\n${info(`state directory: ${paths.state}`)}`)

  return checks.some(c => c.level === 'bad') ? 1 : 0
}
