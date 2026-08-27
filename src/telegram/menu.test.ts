import { expect, test } from 'bun:test'
import { MENU, menuHelp, pushMenu } from './menu.ts'

test('every menu entry is a valid Telegram command name', () => {
  // The Bot API rejects anything else with a 400, at boot, for the whole menu.
  for (const entry of MENU) {
    expect(entry.name).toMatch(/^[a-z0-9_]{1,32}$/)
    expect(entry.description.default.length).toBeGreaterThan(0)
    expect(entry.description.ru.length).toBeGreaterThan(0)
    expect(entry.description.default.length).toBeLessThanOrEqual(256)
  }
})

test('help is rendered from the menu, so the two cannot drift', () => {
  const help = menuHelp('en')
  for (const entry of MENU) expect(help).toContain(`/${entry.name} — ${entry.description.default}`)
  expect(menuHelp('ru')).toContain(`/${MENU[0]?.name} — ${MENU[0]?.description.ru}`)
})

test('an entry with no handler is dropped rather than published', async () => {
  const pushed: unknown[] = []
  const warnings: string[] = []
  await pushMenu(
    { setMyCommands: async params => void pushed.push(params) },
    MENU.map(e => e.name).filter(name => name !== 'help'),
    message => warnings.push(message),
  )
  const first = pushed[0] as { commands: { command: string }[] }
  expect(first.commands.map(c => c.command)).not.toContain('help')
  expect(warnings.join()).toContain('/help has no handler')
})

test('both the default menu and the russian one are pushed', async () => {
  const pushed: { language_code?: string }[] = []
  await pushMenu(
    { setMyCommands: async params => void pushed.push(params as { language_code?: string }) },
    MENU.map(e => e.name),
    () => undefined,
  )
  expect(pushed).toHaveLength(2)
  expect(pushed[0]?.language_code).toBeUndefined()
  expect(pushed[1]?.language_code).toBe('ru')
})

test('a failure to publish does not throw — it costs autocompletion, not the bridge', async () => {
  const warnings: string[] = []
  await pushMenu(
    { setMyCommands: async () => { throw new Error('429') } },
    MENU.map(e => e.name),
    message => warnings.push(message),
  )
  expect(warnings.join()).toContain('could not publish')
})
