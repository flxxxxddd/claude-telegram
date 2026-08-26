#!/usr/bin/env bun
/**
 * `cctg` — the command line around the bridge.
 *
 * The daemon and the MCP shim are what actually do the work; this is for
 * setting them up, seeing what they are doing, and finding out why they are not.
 */

import { runHook } from './commands/hook.ts'
import { daemon } from './commands/daemon.ts'
import { doctor } from './commands/doctor.ts'
import { setup } from './commands/setup.ts'
import { status } from './commands/status.ts'
import { bold, dim, heading } from './ui.ts'
import { VERSION } from './version.ts'

const USAGE = `${heading(`cctg ${VERSION}`)}
Drive Claude Code from Telegram.

  ${bold('cctg setup')}              first run: token, language, mirror hooks
  ${bold('cctg setup --hooks')}      only wire the mirror hooks
  ${bold('cctg status')}             connected sessions, topics and queues
  ${bold('cctg doctor')}             check every link in the chain
  ${bold('cctg daemon start')}       run the bridge in this terminal
  ${bold('cctg daemon start --detach')}
  ${bold('cctg daemon stop')}
  ${bold('cctg daemon restart')}
  ${bold('cctg daemon log -f')}      follow the daemon log
  ${bold('cctg hook')}               internal: a Claude Code hook event on stdin
  ${bold('cctg mcp')}                internal: the per-session MCP shim

${dim('State lives in $TELEGRAM_STATE_DIR, or ~/.claude/channels/telegram.')}
`

async function main(argv: string[]): Promise<number> {
  const [command = 'help', ...rest] = argv

  switch (command) {
    case 'setup':
      return setup(rest)
    case 'status':
      return status()
    case 'doctor':
      return doctor()
    case 'daemon':
      return daemon(rest)
    case 'hook':
      await runHook()
      return 0
    case 'mcp':
      await import('./mcp/server.ts')
      // The shim owns stdio for the whole session. Returning here would fall
      // through to the `process.exit` below and close the transport the instant
      // it finished connecting, which the client reports as CONNECTION_CLOSED.
      await new Promise<never>(() => undefined)
      return 0
    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION)
      return 0
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE)
      return 0
    default:
      console.log(USAGE)
      return 1
  }
}

process.exit(await main(process.argv.slice(2)))
