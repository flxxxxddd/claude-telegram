import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BEST_ACCOUNT,
  accounts,
  bestAccount,
  ccaPresent,
  ccaPrefix,
  currentAccount,
  formatWindow,
  tightestWindow,
} from './cca.ts'

let home: string
let saved: string | undefined

/** Lay out a fake `~/.ccacc` exactly as cca writes one. */
function fakeCca(profiles: Record<string, { dir?: string; mode?: string; email?: string }>, active: string, usage: Record<string, unknown> = {}): void {
  writeFileSync(join(home, 'config.json'), JSON.stringify({ activeProfile: active, profiles }))
  mkdirSync(join(home, 'cache', 'usage'), { recursive: true })
  for (const [name, value] of Object.entries(usage)) {
    writeFileSync(join(home, 'cache', 'usage', `${name}.json`), JSON.stringify(value))
  }
}

const window = (utilization: number, resetsInMs?: number) => ({
  utilization,
  resets_at: resetsInMs === undefined ? null : new Date(Date.now() + resetsInMs).toISOString(),
})

beforeEach(() => {
  saved = process.env.CCA_HOME
  home = mkdtempSync(join(tmpdir(), 'ccacc-'))
  process.env.CCA_HOME = home
})

afterEach(() => {
  if (saved === undefined) delete process.env.CCA_HOME
  else process.env.CCA_HOME = saved
})

describe('reading cca', () => {
  test('a machine without cca reports no accounts rather than throwing', () => {
    expect(ccaPresent()).toBe(false)
    expect(accounts()).toEqual([])
  })

  test('profiles come back with their cached windows', () => {
    fakeCca(
      { work: { dir: '/p/work', email: 'w@x.com', mode: 'shared' } },
      'work',
      { work: { fetchedAt: 1, usage: { five_hour: window(60, 3_600_000), seven_day: window(15) } } },
    )
    const [work] = accounts()
    expect(work).toMatchObject({ name: 'work', email: 'w@x.com', active: true, mode: 'shared' })
    expect(work?.session?.utilization).toBe(60)
    expect(work?.weekly?.utilization).toBe(15)
  })

  test('a profile with no cached usage is still listed', () => {
    fakeCca({ fresh: { dir: '/p/fresh' } }, 'fresh')
    expect(accounts()).toHaveLength(1)
    expect(accounts()[0]?.session).toBeUndefined()
  })

  test('a corrupt usage file loses only that profile\'s numbers', () => {
    fakeCca({ a: { dir: '/p/a' }, b: { dir: '/p/b' } }, 'a', { b: { fetchedAt: 1, usage: { five_hour: window(20) } } })
    writeFileSync(join(home, 'cache', 'usage', 'a.json'), '{ not json')
    const list = accounts()
    expect(list.find(x => x.name === 'a')?.session).toBeUndefined()
    expect(list.find(x => x.name === 'b')?.session?.utilization).toBe(20)
  })
})

describe('currentAccount', () => {
  beforeEach(() => {
    fakeCca({ work: { dir: '/p/work', mode: 'shared' }, play: { dir: '/p/play', mode: 'isolated' } }, 'work')
  })

  test('a shared profile is identified by CLAUDE_SECURESTORAGE_CONFIG_DIR', () => {
    expect(currentAccount({ CLAUDE_SECURESTORAGE_CONFIG_DIR: '/p/work' } as never)?.name).toBe('work')
  })

  test('an isolated profile is identified by CLAUDE_CONFIG_DIR', () => {
    expect(currentAccount({ CLAUDE_CONFIG_DIR: '/p/play' } as never)?.name).toBe('play')
  })

  test('a directory belonging to no profile is not attributed to one', () => {
    // A plain `claude` run sets CLAUDE_CONFIG_DIR for its own reasons; claiming
    // that is some profile would put the wrong account on the status message.
    expect(currentAccount({ CLAUDE_CONFIG_DIR: '/somewhere/else' } as never)).toBeUndefined()
    expect(currentAccount({} as never)).toBeUndefined()
  })

  test('a trailing slash still matches — the two are the same directory', () => {
    expect(currentAccount({ CLAUDE_SECURESTORAGE_CONFIG_DIR: '/p/work/' } as never)?.name).toBe('work')
  })
})

describe('bestAccount', () => {
  test('ranks by the window that will actually stop you', () => {
    fakeCca(
      { spent: { dir: '/a' }, roomy: { dir: '/b' } },
      'spent',
      {
        spent: { usage: { five_hour: window(100), seven_day: window(10) } },
        roomy: { usage: { five_hour: window(30), seven_day: window(90) } },
      },
    )
    expect(bestAccount()?.name).toBe('roomy')
  })

  test('an account with no cached usage sorts last, not first', () => {
    // Unknown is not the same as empty: sending a turn to an account that turns
    // out to be spent wastes the trip.
    fakeCca(
      { unknown: { dir: '/a' }, known: { dir: '/b' } },
      'unknown',
      { known: { usage: { five_hour: window(70) } } },
    )
    expect(bestAccount()?.name).toBe('known')
  })
})

describe('presentation', () => {
  test('the tightest window is the one worth showing', () => {
    const a = { name: 'x', dir: '/x', active: true, session: { utilization: 20 }, weekly: { utilization: 80 } }
    expect(tightestWindow(a)?.utilization).toBe(80)
  })

  test('a window renders as a percentage, with its reset when there is one', () => {
    expect(formatWindow({ utilization: 60 })).toBe('60%')
    expect(formatWindow({ utilization: 60, resetsAt: Date.now() + 7_200_000 })).toMatch(/^60% · 2h/)
    // A reset already in the past is noise, not information.
    expect(formatWindow({ utilization: 60, resetsAt: Date.now() - 1000 })).toBe('60%')
    expect(formatWindow(undefined)).toBeUndefined()
  })
})

describe('ccaPrefix', () => {
  test('no account chosen means no prefix at all', () => {
    expect(ccaPrefix(null)).toBe('')
  })

  test('@best is handed to cca rather than resolved here', () => {
    // cca knows things this bridge does not, such as which logins are expiring.
    if (ccaPrefix('x')) expect(ccaPrefix(BEST_ACCOUNT)).toBe('cca run --best -- ')
  })
})
