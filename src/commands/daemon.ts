/**
 * `cctg daemon start|stop|restart|log` — running the bridge by hand.
 *
 * Most people never touch this: the first session that finds no daemon starts
 * one. It matters when something is wrong and you want the log on your own
 * terminal instead of in a file.
 */

import { spawn } from 'node:child_process'
import { existsSync, openSync, readFileSync } from 'node:fs'
import { paths } from '../paths.ts'
import { bad, bold, dim, info, ok } from '../ui.ts'
import { askStatus, askStop } from './client.ts'

const ENTRY = new URL('../daemon/run.ts', import.meta.url).pathname

export async function daemon(args: string[]): Promise<number> {
  const action = args[0] ?? 'start'
  switch (action) {
    case 'start':
      return start(args.includes('--detach'))
    case 'stop':
      return stop()
    case 'restart':
      await stop()
      return start(true)
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
  if (!detach) {
    // Foreground: replace this process so Ctrl-C reaches the daemon directly.
    const { Daemon } = await import('../daemon/index.ts')
    const instance = new Daemon()
    const shutdown = (): void => void instance.shutdown().then(() => process.exit(0))
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    try {
      await instance.start()
      console.log(ok(`daemon running — log at ${paths.log}`))
      return 0
    } catch (err) {
      console.log(bad(err instanceof Error ? err.message : String(err)))
      return 1
    }
  }
  const out = openSync(paths.log, 'a')
  const child = spawn('bun', [ENTRY], { detached: true, stdio: ['ignore', out, out] })
  child.unref()
  console.log(ok(`daemon starting in the background — log at ${paths.log}`))
  return 0
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
