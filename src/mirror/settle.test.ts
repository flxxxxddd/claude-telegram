import { expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TurnMirror } from './transcript.ts'

const scratch = (): string => join(mkdtempSync(join(tmpdir(), 'cctg-settle-')), 'session.jsonl')

const prompt = (text: string) =>
  `${JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), sessionId: 's1', message: { content: text } })}\n`

const assistant = (content: unknown[]) =>
  `${JSON.stringify({
    type: 'assistant',
    uuid: crypto.randomUUID(),
    sessionId: 's1',
    message: { model: 'claude-opus-5', content },
  })}\n`

/**
 * The Stop hook and Claude Code's write of the final assistant record race, and
 * the hook usually wins. A turn closed on the hook alone dropped its closing
 * paragraph — observed live as `prose=0 tools=1` for a turn that ended with a
 * sentence.
 */
test('settle waits for a record that lands after the turn is already over', async () => {
  const path = scratch()
  writeFileSync(path, '')
  const mirror = new TurnMirror('s1', '/proj', path, {})
  mirror.start()

  appendFileSync(path, prompt('go'))
  appendFileSync(path, assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'wc -l' } }]))
  mirror.poke()
  expect(mirror.snapshot().prose).toEqual([])

  // The closing sentence lands 150ms after Stop would have fired.
  setTimeout(() => appendFileSync(path, assistant([{ type: 'text', text: 'It printed 3.' }])), 150)

  await mirror.settle(2000, 300)
  const snap = mirror.finish()
  mirror.stop()

  expect(snap.prose).toEqual(['It printed 3.'])
  expect(snap.tools).toHaveLength(1)
})

test('settle returns promptly once the transcript is quiet', async () => {
  const path = scratch()
  writeFileSync(path, prompt('go') + assistant([{ type: 'text', text: 'done' }]))
  const mirror = new TurnMirror('s1', '/proj', path, {})
  mirror.start()

  const started = Date.now()
  await mirror.settle(5000, 200)
  mirror.stop()
  // It must not sit out the full budget when nothing more is coming.
  expect(Date.now() - started).toBeLessThan(1500)
})
