#!/usr/bin/env bun
/**
 * Build one bundle and put it where each consumer looks for it.
 *
 * `dist/cli.js` is the npm binary. `plugin/dist/cctg.js` is the same bundle,
 * committed, because a plugin installed straight from git has no build step —
 * Claude Code clones the repo and runs what is there.
 *
 * One artifact matters: the shim starts the daemon by re-running itself with a
 * different argument, so there is nothing to resolve between two files.
 */

import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { sourceStamp, STAMP_FILE } from '../src/build-stamp.ts'

const root = join(import.meta.dir, '..')
const targets = [join(root, 'dist', 'cli.js'), join(root, 'plugin', 'dist', 'cctg.js')]

for (const outfile of targets) {
  await mkdir(join(outfile, '..'), { recursive: true })
  const result = await Bun.build({
    entrypoints: [join(root, 'src', 'cli.ts')],
    outdir: join(outfile, '..'),
    naming: outfile.split('/').pop(),
    target: 'bun',
    minify: false,
    sourcemap: 'none',
  })
  if (!result.success) {
    for (const message of result.logs) console.error(message)
    process.exit(1)
  }
  // Bun carries the entry point's shebang through, so only add one if the
  // bundler dropped it; two would be a syntax error, not a comment.
  const code = await Bun.file(outfile).text()
  if (!code.startsWith('#!')) await Bun.write(outfile, `#!/usr/bin/env bun\n${code}`)
  await Bun.$`chmod +x ${outfile}`.quiet()
  console.log(`${outfile}  ${(await Bun.file(outfile).size / 1024).toFixed(0)}kb`)
}

await rm(join(root, 'dist', 'cli.js.map'), { force: true })

// Record what this bundle was built from, so a shipped source change that
// forgot to rebuild fails the test suite instead of the plugin.
await Bun.write(join(root, STAMP_FILE), `${sourceStamp(root)}\n`)
console.log(`${STAMP_FILE}  ${sourceStamp(root).slice(0, 12)}…`)
