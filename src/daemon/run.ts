#!/usr/bin/env bun
/**
 * Standalone daemon entry point. The shim spawns this detached when it finds no
 * daemon listening, and `cctg daemon start` runs it in the foreground.
 */

import { Daemon } from './index.ts'

const daemon = new Daemon()

const stop = (): void => {
  void daemon.shutdown().then(() => process.exit(0))
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

try {
  await daemon.start()
} catch (err) {
  process.stderr.write(`cctg daemon: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}
