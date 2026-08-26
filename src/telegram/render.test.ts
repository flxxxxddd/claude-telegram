import { describe, expect, test } from 'bun:test'
import { strings } from '../i18n/index.ts'
import type { TurnSnapshot } from '../mirror/transcript.ts'
import { formatContext, formatTokens, renderHud, renderTurn, shortModel } from './render.ts'

const en = { t: strings(), locale: 'en' as const }
const ru = { t: strings(), locale: 'ru' as const }

const turn = (patch: Partial<TurnSnapshot> = {}): TurnSnapshot => ({
  sessionId: 's1',
  cwd: '/proj',
  prompt: 'deploy',
  prose: [],
  thinking: null,
  tools: [],
  contextTokens: 0,
  startedAt: 0,
  complete: false,
  ...patch,
})

describe('formatting', () => {
  test('token counts stay short enough for a table cell', () => {
    expect(formatTokens(940)).toBe('940')
    expect(formatTokens(9_400)).toBe('9.4k')
    expect(formatTokens(94_000)).toBe('94k')
    expect(formatTokens(1_400_000)).toBe('1.4M')
  })

  test('context reads as used, total and percent', () => {
    expect(formatContext(100_000, 'claude-opus-5')).toBe('100k / 200k · 50%')
  })

  test('a zero context renders as nothing, not as 0%', () => {
    expect(formatContext(0, 'claude-opus-5')).toBe('')
  })

  test('the model family is what reaches the table', () => {
    expect(shortModel('claude-opus-5')).toBe('opus-5')
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku-4-5')
    expect(shortModel(undefined)).toBeUndefined()
  })
})

describe('renderTurn', () => {
  test('an unfinished turn with only a thought shows the animated placeholder', () => {
    const html = renderTurn(turn({ thinking: 'weighing options' }), en).content
    expect(html).toContain('<tg-thinking>')
    expect(html).toContain('weighing options')
  })

  test('a finished turn never shows the thinking placeholder', () => {
    const html = renderTurn(turn({ thinking: 'stale', complete: true }), en).content
    expect(html).not.toContain('<tg-thinking>')
  })

  test('the tool trail collapses into a details block', () => {
    const html = renderTurn(turn({
      prose: ['Reading the runbook.'],
      tools: [{ name: 'Read', line: 'read RUNBOOK.md' }, { name: 'Bash', line: '$ bun test' }],
    }), en).content
    expect(html).toContain('<details>')
    expect(html).toContain('Ran 2 steps')
    expect(html).toContain('read RUNBOOK.md')
  })

  test('an empty turn still produces a body, since telegram rejects an empty message', () => {
    expect(renderTurn(turn({ complete: true }), en).content.trim()).not.toBe('')
  })
})

describe('renderHud', () => {
  test('carries the state, the prompt and the facts as a table', () => {
    const html = renderHud({
      state: 'working',
      project: 'codexgram',
      prompt: 'deploy',
      model: 'claude-opus-5',
      effort: 'high',
      contextTokens: 40_000,
      branch: 'main',
    }, en).content
    expect(html).toContain('🔵 Working')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('<table')
    expect(html).toContain('opus-5')
    expect(html).toContain('40k / 200k · 20%')
    expect(html).toContain('<footer>')
  })

  test('unreported facts say so rather than rendering blank cells', () => {
    const html = renderHud({ state: 'idle', project: 'p' }, en).content
    expect(html).toContain('not reported yet')
  })

  test('russian gets russian, including the state word', () => {
    const html = renderHud({ state: 'done', project: 'p' }, ru).content
    expect(html).toContain('🟢 Готово')
    expect(html).toContain('Модель')
  })
})
