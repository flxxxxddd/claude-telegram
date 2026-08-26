import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { VERSION } from './version.ts'

const root = join(import.meta.dir, '..')
const json = (path: string): { version?: string; metadata?: { version?: string } } =>
  JSON.parse(readFileSync(join(root, path), 'utf8')) as never

/**
 * Four files carry the version and they are read by four different things —
 * npm, the plugin loader, the marketplace, and the MCP handshake. A release
 * that bumps three of them ships a plugin that reports the wrong version, so
 * they are pinned to each other here rather than to a changelog nobody reads.
 */
test('every manifest agrees with src/version.ts', () => {
  expect(json('package.json').version).toBe(VERSION)
  expect(json('plugin/.claude-plugin/plugin.json').version).toBe(VERSION)
  expect(json('.claude-plugin/marketplace.json').metadata?.version).toBe(VERSION)
})
