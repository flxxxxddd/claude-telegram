import { afterEach, beforeEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { projectName, projectTranscriptDir, stateDir, transcriptPath } from './paths.ts'

let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = { TELEGRAM_STATE_DIR: process.env.TELEGRAM_STATE_DIR, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
  delete process.env.TELEGRAM_STATE_DIR
  process.env.CLAUDE_CONFIG_DIR = '/home/me/.claude'
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/**
 * These pin Claude Code's own addressing, observed in 2.1.246. If the slug is
 * wrong the mirror follows a file that does not exist and stays silent forever,
 * which is the hardest failure in this project to notice. Do not regenerate a
 * failing expectation from the implementation it is testing — check it against
 * a real `~/.claude/projects` directory.
 */
test('a transcript directory is the absolute path with every non-alphanumeric run dashed', () => {
  expect(projectTranscriptDir('/Users/flx/Desktop/claude-telegram-multi'))
    .toBe('/home/me/.claude/projects/-Users-flx-Desktop-claude-telegram-multi')
})

test('dots, spaces and underscores all become dashes', () => {
  expect(projectTranscriptDir('/Users/flx/Desktop/status.cyka.cloud'))
    .toBe('/home/me/.claude/projects/-Users-flx-Desktop-status-cyka-cloud')
  expect(projectTranscriptDir('/tmp/my project_v2'))
    .toBe('/home/me/.claude/projects/-tmp-my-project-v2')
})

test('a transcript is the session id inside that directory', () => {
  expect(transcriptPath('/tmp/app', 'e0dce1d4-49c6-4816-bea5-b8810b5bbe6c'))
    .toBe('/home/me/.claude/projects/-tmp-app/e0dce1d4-49c6-4816-bea5-b8810b5bbe6c.jsonl')
})

test('the state directory defaults under the claude config dir and is overridable', () => {
  expect(stateDir()).toBe(join('/home/me/.claude', 'channels', 'telegram'))
  process.env.TELEGRAM_STATE_DIR = '/tmp/second-bot'
  expect(stateDir()).toBe('/tmp/second-bot')
})

test('a project name is the last segment, trailing slash or not', () => {
  expect(projectName('/Users/flx/Desktop/app')).toBe('app')
  expect(projectName('/Users/flx/Desktop/app/')).toBe('app')
})
