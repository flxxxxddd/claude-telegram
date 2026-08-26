/**
 * A fingerprint of the sources a bundle was built from.
 *
 * `plugin/dist/cctg.js` is committed, because a plugin installed from git has
 * no build step — which introduces exactly one failure mode: a source change
 * that ships without a rebuild, so the plugin silently runs the previous
 * version.
 *
 * Comparing the committed bundle byte-for-byte against a fresh build does not
 * detect that, because no bundler promises identical output across its own
 * versions: Bun 1.3 emits `(exports) => {}` where an older Bun emits
 * `function (exports) {}`, and the diff is thousands of lines of vendored code.
 * So the build records a hash of the *inputs* instead, and a test recomputes it.
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export const STAMP_FILE = 'plugin/dist/sources.sha256'

/** Every file whose contents end up in the bundle. */
function sourceFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) {
        walk(path)
      } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
        out.push(path)
      }
    }
  }
  walk(join(root, 'src'))
  return out
}

/**
 * Hash the sources and the dependency versions they were built against. Paths
 * go into the hash too, so a renamed file counts as a change.
 */
export function sourceStamp(root: string): string {
  const hash = createHash('sha256')
  for (const path of sourceFiles(root)) {
    hash.update(relative(root, path))
    hash.update(readFileSync(path))
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies?: unknown }
  hash.update(JSON.stringify(pkg.dependencies ?? {}))
  return hash.digest('hex')
}
