import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sourceStamp, STAMP_FILE } from './build-stamp.ts'

const root = join(import.meta.dir, '..')

/**
 * The committed plugin bundle has to have been built from the committed
 * sources. When this fails, run `bun run build` and commit what it changes —
 * the plugin ships from git, so a stale bundle is a stale plugin.
 */
test('plugin/dist was built from these sources', () => {
  expect(existsSync(join(root, STAMP_FILE))).toBe(true)
  expect(readFileSync(join(root, STAMP_FILE), 'utf8').trim()).toBe(sourceStamp(root))
})
