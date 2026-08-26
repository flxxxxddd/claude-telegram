import { describe, expect, test } from 'bun:test'
import { DEFAULT_ACCESS, gateDm, gateGroup, mintPairingCode, pruneExpired, type Access } from './access.ts'

const access = (patch: Partial<Access> = {}): Access => ({ ...DEFAULT_ACCESS, pending: {}, ...patch })

describe('gateDm', () => {
  test('an allowed user gets through under every policy', () => {
    for (const dmPolicy of ['pairing', 'allowlist', 'open'] as const) {
      expect(gateDm(access({ dmPolicy, allowedUsers: ['7'] }), '7').ok).toBe(true)
    }
  })

  test('under `pairing`, an unknown user is offered a code', () => {
    const gate = gateDm(access({ dmPolicy: 'pairing' }), '9')
    expect(gate).toMatchObject({ ok: false, reason: 'unknown-user', userId: '9' })
  })

  test('under `allowlist`, an unknown user gets nothing at all', () => {
    // Not even a pairing code: a stranger should not be able to tell a bot is
    // listening on the other side.
    expect(gateDm(access({ dmPolicy: 'allowlist' }), '9')).toMatchObject({ ok: false, reason: 'denied' })
  })

  test('under `open`, anyone gets through', () => {
    expect(gateDm(access({ dmPolicy: 'open' }), '9').ok).toBe(true)
  })
})

describe('gateGroup', () => {
  test('an unlisted group is denied even when the bot is mentioned', () => {
    expect(gateGroup(access(), '-100', true).ok).toBe(false)
  })

  test('a listed group answers only when spoken to, by default', () => {
    const a = access({ allowedChats: ['-100'] })
    expect(gateGroup(a, '-100', false).ok).toBe(false)
    expect(gateGroup(a, '-100', true).ok).toBe(true)
  })

  test('requireMention off lets a listed group through unprompted', () => {
    expect(gateGroup(access({ allowedChats: ['-100'], requireMention: false }), '-100', false).ok).toBe(true)
  })
})

describe('pairing codes', () => {
  test('a code avoids characters that are ambiguous when read aloud', () => {
    const a = access()
    const code = mintPairingCode(a, '7', '7')
    expect(code).toHaveLength(6)
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/)
    expect(a.pending[code]).toMatchObject({ userId: '7' })
  })

  test('expired codes are pruned and live ones are kept', () => {
    const a = access({
      pending: {
        OLD123: { userId: '1', chatId: '1', expiresAt: Date.now() - 1000 },
        NEW456: { userId: '2', chatId: '2', expiresAt: Date.now() + 60_000 },
      },
    })
    expect(pruneExpired(a)).toBe(true)
    expect(Object.keys(a.pending)).toEqual(['NEW456'])
    expect(pruneExpired(a)).toBe(false)
  })
})
