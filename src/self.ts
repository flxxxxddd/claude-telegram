/**
 * How the process re-invokes itself.
 *
 * The shim starts a daemon when it finds none, and `cctg daemon start --detach`
 * does the same. Both need to name an executable and a script — and after
 * bundling there is no `src/daemon/run.ts` to point at. Re-running *this*
 * artifact with a different argument sidesteps path resolution entirely: there
 * is one file, and it already knows how to be a daemon.
 */

import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { paths } from './paths.ts'

/** The interpreter and script that are running right now. */
export function selfEntry(): { exec: string; script: string } {
  return {
    exec: process.execPath,
    script: process.argv[1] ?? new URL('./cli.ts', import.meta.url).pathname,
  }
}

/**
 * Start a detached daemon writing to the daemon log. Returns without waiting:
 * the caller retries its connection until the socket appears.
 */
export function spawnDaemon(): void {
  const { exec, script } = selfEntry()
  let out: 'ignore' | number = 'ignore'
  try {
    out = openSync(paths.log, 'a')
  } catch {
    out = 'ignore'
  }
  // `--foreground` is essential, not incidental: `daemon start` detaches by
  // default, so without it this child would spawn a child of its own, forever.
  const child = spawn(exec, [script, 'daemon', 'start', '--foreground'], {
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  })
  child.unref()
}
