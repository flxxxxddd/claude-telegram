import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TranscriptTail, TurnMirror, type TurnSnapshot } from './transcript.ts'

const scratch = (): string => join(mkdtempSync(join(tmpdir(), 'cctg-')), 'session.jsonl')

const assistant = (content: unknown[], extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({
    type: 'assistant',
    uuid: crypto.randomUUID(),
    sessionId: 's1',
    message: { model: 'claude-opus-5', content, usage: { input_tokens: 2, cache_read_input_tokens: 100 } },
    ...extra,
  })}\n`

const prompt = (text: string) =>
  `${JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), sessionId: 's1', message: { role: 'user', content: text } })}\n`

describe('TranscriptTail', () => {
  test('reads only what was appended since the last call', () => {
    const path = scratch()
    writeFileSync(path, prompt('one'))
    const tail = new TranscriptTail(path)
    expect(tail.read()).toHaveLength(1)
    expect(tail.read()).toHaveLength(0)
    appendFileSync(path, prompt('two'))
    expect(tail.read()).toHaveLength(1)
  })

  test('holds back a partial trailing line until the rest arrives', () => {
    const path = scratch()
    const line = prompt('split me')
    writeFileSync(path, line.slice(0, 20))
    const tail = new TranscriptTail(path)
    expect(tail.read()).toHaveLength(0)
    appendFileSync(path, line.slice(20))
    expect(tail.read()).toHaveLength(1)
  })

  test('restarts from the top when the file shrinks', () => {
    const path = scratch()
    writeFileSync(path, prompt('a') + prompt('b'))
    const tail = new TranscriptTail(path)
    expect(tail.read()).toHaveLength(2)
    writeFileSync(path, prompt('c'))
    expect(tail.read()).toHaveLength(1)
  })
})

describe('TurnMirror', () => {
  const mirror = (path: string) => {
    const seen: TurnSnapshot[] = []
    const m = new TurnMirror('s1', '/proj', path, { onUpdate: s => seen.push(s) })
    return { m, seen }
  }

  test('assembles prose, thinking and tool calls into one turn', () => {
    const path = scratch()
    writeFileSync(path, '')
    const { m } = mirror(path)
    m.start()
    appendFileSync(path, prompt('deploy it'))
    appendFileSync(path, assistant([{ type: 'thinking', thinking: 'weighing options' }]))
    m.poke()
    expect(m.snapshot().thinking).toBe('weighing options')

    appendFileSync(path, assistant([
      { type: 'text', text: 'Reading the runbook.' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/proj/RUNBOOK.md' } },
    ]))
    appendFileSync(path, assistant([
      { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'bun test' } },
    ]))
    const snap = m.finish()
    m.stop()

    expect(snap.prompt).toBe('deploy it')
    expect(snap.prose).toEqual(['Reading the runbook.'])
    // Prose supersedes thinking: once the model speaks, the thought is stale.
    expect(snap.thinking).toBeNull()
    expect(snap.tools.map(t => t.line)).toEqual(['read RUNBOOK.md', '$ bun test'])
    expect(snap.model).toBe('claude-opus-5')
    expect(snap.contextTokens).toBe(102)
    expect(snap.complete).toBe(true)
  })

  test('a new prompt starts a new turn even without a Stop in between', () => {
    const path = scratch()
    writeFileSync(path, '')
    const { m } = mirror(path)
    m.start()
    appendFileSync(path, prompt('first') + assistant([{ type: 'text', text: 'partial' }]))
    m.poke()
    appendFileSync(path, prompt('second'))
    m.poke()
    m.stop()
    expect(m.snapshot().prompt).toBe('second')
    expect(m.snapshot().prose).toEqual([])
  })

  test('ignores subagent records so parallel agents do not interleave', () => {
    const path = scratch()
    writeFileSync(path, '')
    const { m } = mirror(path)
    m.start()
    appendFileSync(path, prompt('go'))
    appendFileSync(path, assistant([{ type: 'text', text: 'from the subagent' }], { isSidechain: true }))
    appendFileSync(path, assistant([{ type: 'text', text: 'from the main thread' }]))
    m.poke()
    m.stop()
    expect(m.snapshot().prose).toEqual(['from the main thread'])
  })

  test('a tool result fed back as a user record does not start a turn', () => {
    const path = scratch()
    writeFileSync(path, '')
    const { m } = mirror(path)
    m.start()
    appendFileSync(path, prompt('go'))
    appendFileSync(path, assistant([{ type: 'text', text: 'working' }]))
    appendFileSync(path, `${JSON.stringify({
      type: 'user',
      uuid: 'u2',
      sessionId: 's1',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    })}\n`)
    m.poke()
    m.stop()
    expect(m.snapshot().prompt).toBe('go')
    expect(m.snapshot().prose).toEqual(['working'])
  })

  test('reports the session title Claude Code assigns', () => {
    const path = scratch()
    writeFileSync(path, '')
    let title: string | undefined
    const m = new TurnMirror('s1', '/proj', path, { onTitle: t => (title = t) })
    m.start()
    appendFileSync(path, `${JSON.stringify({ type: 'ai-title', aiTitle: 'Deploy the hub', sessionId: 's1' })}\n`)
    m.poke()
    m.stop()
    expect(title).toBe('Deploy the hub')
  })
})
