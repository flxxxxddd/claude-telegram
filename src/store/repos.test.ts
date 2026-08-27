import { describe, expect, test } from 'bun:test'
import { memoryDb } from '../db.ts'
import { bindings, handles, hud, kvStore, queue, settings, topics } from './repos.ts'

describe('topics', () => {
  test('a project owns one topic per chat, in both directions', () => {
    const conn = memoryDb()
    topics.put(conn, { chat_id: '42', cwd: '/a', thread_id: 7, name: 'a' })
    expect(topics.get(conn, '42', '/a')?.thread_id).toBe(7)
    expect(topics.byThread(conn, '42', 7)?.cwd).toBe('/a')
    expect(topics.get(conn, '43', '/a')).toBeNull()
  })

  test('reopening a project replaces its thread rather than adding a second', () => {
    const conn = memoryDb()
    topics.put(conn, { chat_id: '42', cwd: '/a', thread_id: 7, name: 'a' })
    topics.put(conn, { chat_id: '42', cwd: '/a', thread_id: 9, name: 'a renamed' })
    expect(topics.all(conn)).toHaveLength(1)
    expect(topics.get(conn, '42', '/a')?.thread_id).toBe(9)
    // The old id must stop resolving, or a deleted topic keeps taking messages.
    expect(topics.byThread(conn, '42', 7)).toBeNull()
  })

  test('a forgotten topic is gone from both lookups', () => {
    const conn = memoryDb()
    topics.put(conn, { chat_id: '42', cwd: '/a', thread_id: 7, name: 'a' })
    topics.forget(conn, '42', 7)
    expect(topics.get(conn, '42', '/a')).toBeNull()
    expect(topics.byThread(conn, '42', 7)).toBeNull()
  })
})

describe('queue', () => {
  test('holds messages per project and replays them oldest first', () => {
    const conn = memoryDb()
    queue.push(conn, '/a', { content: 'one' })
    queue.push(conn, '/a', { content: 'two' })
    queue.push(conn, '/b', { content: 'other project' })
    expect(queue.depth(conn, '/a')).toBe(2)

    expect(queue.drain(conn, '/a')).toEqual([{ content: 'one' }, { content: 'two' }])
    expect(queue.depth(conn, '/a')).toBe(0)
    // Draining one project must not touch another's backlog.
    expect(queue.depth(conn, '/b')).toBe(1)
  })
})

describe('settings', () => {
  test('an unknown project reads as empty rather than throwing', () => {
    const conn = memoryDb()
    expect(settings.get(conn, '/new'))
      .toEqual({ cwd: '/new', model: null, effort: null, permission_mode: null, account: null })
  })

  test('patching one field leaves the others alone', () => {
    const conn = memoryDb()
    settings.patch(conn, '/a', { model: 'opus' })
    settings.patch(conn, '/a', { effort: 'high' })
    settings.patch(conn, '/a', { account: 'work' })
    expect(settings.get(conn, '/a')).toMatchObject({ model: 'opus', effort: 'high', account: 'work' })
  })

  test('the account column survives the migration onto an existing database', () => {
    // Migration 2 adds `account` to a table migration 1 created. A database
    // written before it must keep its rows and read the new column as null.
    const conn = memoryDb()
    settings.patch(conn, '/a', { model: 'opus' })
    expect(settings.get(conn, '/a').account).toBeNull()
  })
})

describe('handles', () => {
  test('the same value always gets the same id', () => {
    const conn = memoryDb()
    const first = handles.of(conn, '/Users/me/some/very/long/project/path')
    expect(handles.of(conn, '/Users/me/some/very/long/project/path')).toBe(first)
    expect(handles.get(conn, first)).toBe('/Users/me/some/very/long/project/path')
  })

  test('an id fits a 64-byte callback payload with room to spare', () => {
    const conn = memoryDb()
    expect(handles.of(conn, '/x').length).toBeLessThanOrEqual(8)
  })

  test('an unknown id resolves to null rather than throwing', () => {
    expect(handles.get(memoryDb(), 'zzzzzz')).toBeNull()
  })
})

describe('bindings and hud', () => {
  test('a chat binds to one session at a time', () => {
    const conn = memoryDb()
    bindings.set(conn, '42', 's1')
    bindings.set(conn, '42', 's2')
    expect(bindings.get(conn, '42')).toBe('s2')
    bindings.clear(conn, '42')
    expect(bindings.get(conn, '42')).toBeNull()
  })

  test('a topic remembers its pinned status message', () => {
    const conn = memoryDb()
    hud.set(conn, '42', 7, 100)
    expect(hud.get(conn, '42', 7)).toBe(100)
    hud.clear(conn, '42', 7)
    expect(hud.get(conn, '42', 7)).toBeNull()
  })
})

describe('kvStore', () => {
  test('behaves as a sklad storage adapter, namespaced by prefix', () => {
    const conn = memoryDb()
    const locales = kvStore<string>(conn, 'locale:')
    const other = kvStore<string>(conn, 'other:')
    locales.set('42', 'ru')
    expect(locales.get('42')).toBe('ru')
    expect(other.get('42')).toBeUndefined()
    expect(locales.has('42')).toBe(true)
    locales.delete('42')
    expect(locales.get('42')).toBeUndefined()
  })
})
