import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { botToken, loadConfig, looksLikeToken, saveBotToken, saveConfig } from './config.ts'
import { paths } from './paths.ts'

const TOKEN = '123456789:AAHfiqksKZ8abcdefghijklmnopqrstuvwxy'
const touched = ['TELEGRAM_STATE_DIR', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_THREAD_MODE', 'CCTG_MIRROR', 'CCTG_LOCALE']
let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(touched.map(key => [key, process.env[key]]))
  for (const key of touched) delete process.env[key]
  process.env.TELEGRAM_STATE_DIR = mkdtempSync(join(tmpdir(), 'cctg-config-'))
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('loadConfig', () => {
  test('an absent file gives the defaults', () => {
    expect(loadConfig()).toMatchObject({ threadMode: 'auto', mirror: 'full', locale: 'en', streaming: true })
  })

  test('the environment wins over the file', () => {
    saveConfig({ mirror: 'off', locale: 'ru' })
    process.env.CCTG_MIRROR = 'full'
    const config = loadConfig()
    expect(config.mirror).toBe('full')
    // Only the overridden key changes; the rest still comes from the file.
    expect(config.locale).toBe('ru')
  })

  test('a nonsense environment value is ignored, not adopted', () => {
    saveConfig({ mirror: 'activity' })
    process.env.CCTG_MIRROR = 'sideways'
    expect(loadConfig().mirror).toBe('activity')
  })

  test('a corrupt config file falls back to the defaults', () => {
    writeFileSync(paths.config, '{ not json')
    expect(loadConfig().mirror).toBe('full')
  })
})

describe('saveConfig', () => {
  test('writes back only the keys it was given', () => {
    saveConfig({ locale: 'ru', launchCmd: 'tmux …' })
    saveConfig({ mirror: 'activity' })
    const stored = JSON.parse(readFileSync(paths.config, 'utf8')) as Record<string, unknown>
    // Saving one setting must never silently revert another.
    expect(stored).toEqual({ locale: 'ru', launchCmd: 'tmux …', mirror: 'activity' })
  })
})

describe('the token', () => {
  test('comes from the environment before the file', () => {
    saveBotToken(TOKEN)
    process.env.TELEGRAM_BOT_TOKEN = 'from-the-shell'
    expect(botToken()).toBe('from-the-shell')
  })

  test('round-trips through .env, quotes and `export` included', () => {
    saveBotToken(TOKEN)
    expect(botToken()).toBe(TOKEN)
    writeFileSync(paths.env, `export TELEGRAM_BOT_TOKEN="${TOKEN}"\n`)
    expect(botToken()).toBe(TOKEN)
  })

  test('saving a new token replaces the old one instead of appending', () => {
    saveBotToken('111:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    saveBotToken(TOKEN)
    expect(readFileSync(paths.env, 'utf8').split('\n').filter(l => l.includes('TELEGRAM_BOT_TOKEN'))).toHaveLength(1)
    expect(botToken()).toBe(TOKEN)
  })

  test('other variables in .env are left alone', () => {
    writeFileSync(paths.env, 'TELEGRAM_LAUNCH_CMD=tmux\n')
    saveBotToken(TOKEN)
    expect(readFileSync(paths.env, 'utf8')).toContain('TELEGRAM_LAUNCH_CMD=tmux')
  })

  test('the .env file is not world-readable', () => {
    saveBotToken(TOKEN)
    expect(Bun.file(paths.env).stat().then(s => s.mode & 0o777)).resolves.toBe(0o600)
  })

  test('looksLikeToken accepts a real shape and rejects a pasted username', () => {
    expect(looksLikeToken(TOKEN)).toBe(true)
    expect(looksLikeToken('my_assistant_bot')).toBe(false)
    expect(looksLikeToken('123:short')).toBe(false)
  })
})
