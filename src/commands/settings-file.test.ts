import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOOK_EVENTS, hooksInstalled, installHooks, readSettings, removeHooks, settingsPath } from './settings-file.ts'

const COMMAND = 'cctg hook'
let home: string
let previous: string | undefined

beforeEach(() => {
  previous = process.env.CLAUDE_CONFIG_DIR
  home = mkdtempSync(join(tmpdir(), 'cctg-settings-'))
  process.env.CLAUDE_CONFIG_DIR = home
})

afterEach(() => {
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previous
})

const write = (value: unknown): void => writeFileSync(settingsPath(), JSON.stringify(value, null, 2))

describe('installHooks', () => {
  test('adds every event the mirror needs', () => {
    const { added } = installHooks(COMMAND)
    expect(added).toEqual(HOOK_EVENTS)
    expect(hooksInstalled(COMMAND)).toBe(true)
  })

  test('only PostToolUse gets a matcher — the others fire unconditionally', () => {
    installHooks(COMMAND)
    const hooks = readSettings().hooks ?? {}
    expect(hooks.PostToolUse?.[0]?.matcher).toBe('*')
    expect(hooks.Stop?.[0]?.matcher).toBeUndefined()
  })

  test('running it twice adds nothing the second time', () => {
    installHooks(COMMAND)
    expect(installHooks(COMMAND).added).toEqual([])
    expect(readSettings().hooks?.Stop).toHaveLength(1)
  })

  test('keys this version has never heard of survive the edit', () => {
    write({ model: 'opus', experimental: { future: true }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] } })
    installHooks(COMMAND)
    const settings = readSettings() as Record<string, unknown>
    expect(settings.model).toBe('opus')
    expect(settings.experimental).toEqual({ future: true })
    // The user's own Stop hook has to still be there next to ours.
    expect(readSettings().hooks?.Stop?.map(m => m.hooks?.[0]?.command)).toEqual(['mine', COMMAND])
  })

  test('the first edit leaves a backup of the untouched file', () => {
    write({ model: 'opus' })
    installHooks(COMMAND)
    expect(existsSync(`${settingsPath()}.cctg-backup`)).toBe(true)
    expect(JSON.parse(readFileSync(`${settingsPath()}.cctg-backup`, 'utf8'))).toEqual({ model: 'opus' })
  })

  test('a settings file that is not valid json is treated as empty, not as a crash', () => {
    writeFileSync(settingsPath(), '{ not json')
    expect(() => installHooks(COMMAND)).not.toThrow()
    expect(hooksInstalled(COMMAND)).toBe(true)
  })
})

describe('removeHooks', () => {
  test('takes ours out and leaves everything else', () => {
    write({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] } })
    installHooks(COMMAND)
    removeHooks(COMMAND)
    expect(hooksInstalled(COMMAND)).toBe(false)
    expect(readSettings().hooks?.Stop?.map(m => m.hooks?.[0]?.command)).toEqual(['mine'])
    expect((readSettings() as Record<string, unknown>).model).toBe('opus')
  })

  test('an event left with no hooks is dropped rather than left as an empty array', () => {
    installHooks(COMMAND)
    removeHooks(COMMAND)
    expect(readSettings().hooks?.PostToolUse).toBeUndefined()
  })
})
