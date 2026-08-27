import { expect, test } from 'bun:test'
import {
  ACCOUNT_BEST,
  ACCOUNT_INHERIT,
  accountCb,
  askCb,
  closeCb,
  langCb,
  permissionCb,
  projectCb,
  sessionCb,
  settingsCb,
} from './callbacks.ts'

/**
 * Telegram caps `callback_data` at 64 bytes and `pack` reports an overflow by
 * throwing — which takes down the whole keyboard being built, not one button.
 * These pack the worst realistic input for each namespace.
 */
test('every payload fits the 64-byte cap at its worst realistic size', () => {
  const worst: [string, () => string][] = [
    ['account', () => accountCb.pack({ h: 'abc123', a: 'zyx987', launch: true })],
    ['settings', () => settingsCb.pack({ h: 'abc123', page: 'permission', value: 'bypassPermissions' })],
    ['project', () => projectCb.pack({ h: 'abc123', action: 'interrupt' })],
    ['session', () => sessionCb.pack({ id: crypto.randomUUID() })],
    ['permission', () => permissionCb.pack({ id: 'ab12cd34', allow: true })],
    ['ask', () => askCb.pack({ id: 'ab12cd34', choice: 99 })],
    ['lang', () => langCb.pack({ locale: 'ru' })],
    ['close', () => closeCb.pack({})],
  ]
  for (const [name, pack] of worst) {
    const packed = pack()
    expect(packed.length, `${name} is ${packed.length} bytes`).toBeLessThanOrEqual(64)
  }
})

test('an account travels as a handle, so a long profile name cannot overflow it', () => {
  // A name is user-chosen; packing it verbatim threw at 69 bytes for a name
  // someone might plausibly use.
  const long = 'a-very-long-account-name-someone-might-actually-use-2026'
  expect(() => accountCb.pack({ h: 'abc123', a: long })).toThrow()
  expect(accountCb.pack({ h: 'abc123', a: 'zyx987' }).length).toBeLessThan(20)
})

test('the two account sentinels round-trip and stay distinguishable', () => {
  expect(accountCb.unpack(accountCb.pack({ h: 'h1', a: ACCOUNT_BEST }))?.a).toBe(ACCOUNT_BEST)
  expect(accountCb.unpack(accountCb.pack({ h: 'h1', a: ACCOUNT_INHERIT }))?.a).toBe(ACCOUNT_INHERIT)
  expect(ACCOUNT_BEST).not.toBe(ACCOUNT_INHERIT)
})

test('launch defaults to false, so a button packed before the flag still decodes', () => {
  const before = accountCb.pack({ h: 'h1', a: 'a1' })
  expect(accountCb.unpack(before)?.launch).toBe(false)
})

test('a payload from another namespace unpacks to undefined rather than throwing', () => {
  // Telegram keeps old buttons on screen indefinitely; this is a real path.
  expect(accountCb.unpack(langCb.pack({ locale: 'en' }))).toBeUndefined()
  expect(settingsCb.unpack('nonsense')).toBeUndefined()
})
