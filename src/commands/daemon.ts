/**
 * `cctg daemon start|stop|restart|log` — running the bridge by hand.
 *
 * Most people never touch this: the first session that finds no daemon starts
 * one. It matters when something is wrong and you want the log on your own
 * terminal instead of in a file.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { paths } from '../paths.ts'
import { spawnDaemon } from '../self.ts'
import { bad, bold, dim, info, ok } from '../ui.ts'
import { askStatus, askStop } from './client.ts'

export async function daemon(args: string[]): Promise<number> {
  const action = args[0] ?? 'start'
  switch (action) {
    case 'start':
      // Detached is the default. `start` running in the foreground meant a
      // closed terminal took the bridge down with it, and the symptom — "no
      // daemon is running" an hour later — pointed nowhere near the cause.
      return start(!args.includes('--foreground'))
    case 'stop':
      return stop()
    case 'restart':
      await stop()
      return start(!args.includes('--foreground'))
    case 'log':
      return log(args.includes('-f') || args.includes('--follow'))
    default:
      console.log(bad(`unknown action: ${action}`))
      console.log(info('expected one of: start, stop, restart, log'))
      return 1
  }
}

async function start(detach: boolean): Promise<number> {
  const live = await askStatus()
  if (live) {
    console.log(ok(`already running as @${live.botUsername} (pid ${live.pid})`))
    return 0
  }
  if (detach) {
    spawnDaemon()
    // Wait for it to answer rather than claiming success blindly: a daemon that
    // cannot reach Telegram exits within a second, and reporting "started" for
    // one that is already gone is how a bad token stays invisible.
    for (let attempt = 0; attempt < 20; attempt++) {
      await Bun.sleep(250)
      const started = await askStatus()
      if (started) {
        console.log(ok(`daemon running as @${started.botUsername} (pid ${started.pid})`))
        return 0
      }
    }
    console.log(bad('the daemon did not come up'))
    console.log(info(`what it said is in ${paths.log} — \`cctg daemon log\``))
    return 1
  }

  {
    // Foreground: this process becomes the daemon, so Ctrl-C reaches it.
    const { Daemon } = await import('../daemon/index.ts')
    const instance = new Daemon()
    const shutdown = (): void => void instance.shutdown().then(() => process.exit(0))
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    try {
      await instance.start()
    } catch (err) {
      console.log(bad(err instanceof Error ? err.message : String(err)))
      return 1
    }
    console.log(ok(`daemon running — log at ${paths.log}`))
    // `bot.start()` resolves once polling is up, so hold the process open until
    // a signal arrives; the handlers above are what actually end it.
    await new Promise<never>(() => undefined)
    return 0
  }
}

async function stop(): Promise<number> {
  const stopped = await askStop()
  if (stopped) {
    console.log(ok('daemon stopped'))
    return 0
  }
  // The socket may be stale while the process is still up; try the pid.
  if (existsSync(paths.pid)) {
    const pid = Number(readFileSync(paths.pid, 'utf8').trim())
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM')
        console.log(ok(`signalled pid ${pid}`))
        return 0
      } catch {
        console.log(info(`pid ${pid} is already gone`))
      }
    }
  }
  console.log(info('no daemon was running'))
  return 0
}

function log(follow: boolean): number {
  if (!existsSync(paths.log)) {
    console.log(info(`no log yet at ${paths.log}`))
    return 0
  }
  if (!follow) {
    console.log(readFileSync(paths.log, 'utf8').trimEnd())
    return 0
  }
  console.log(dim(`${bold('tail -f')} ${paths.log}`))
  spawn('tail', ['-f', paths.log], { stdio: 'inherit' })
  return 0
}
