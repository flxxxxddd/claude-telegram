/**
 * Typed repositories over the daemon's SQLite tables. Every function takes the
 * `Database` explicitly so tests can drive them against `memoryDb()` without
 * touching the real state directory.
 */

import type { Database } from 'bun:sqlite'
import type { ProjectSettings, QueueRow, TopicRow } from '../db.ts'

/* ---------------------------------------------------------------- topics -- */

export const topics = {
  /** The topic a project owns in a chat, if one has been created. */
  get(conn: Database, chatId: string, cwd: string): TopicRow | null {
    return conn.query('SELECT chat_id, cwd, thread_id, name FROM topics WHERE chat_id = ? AND cwd = ?')
      .get(chatId, cwd) as TopicRow | null
  },

  /** Reverse lookup: which project does this topic belong to? */
  byThread(conn: Database, chatId: string, threadId: number): TopicRow | null {
    return conn.query('SELECT chat_id, cwd, thread_id, name FROM topics WHERE chat_id = ? AND thread_id = ?')
      .get(chatId, threadId) as TopicRow | null
  },

  all(conn: Database): TopicRow[] {
    return conn.query('SELECT chat_id, cwd, thread_id, name FROM topics ORDER BY created_at').all() as TopicRow[]
  },

  put(conn: Database, row: TopicRow): void {
    conn.query(`INSERT INTO topics (chat_id, cwd, thread_id, name, created_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (chat_id, cwd) DO UPDATE SET thread_id = excluded.thread_id, name = excluded.name`)
      .run(row.chat_id, row.cwd, row.thread_id, row.name, Date.now())
  },

  /**
   * Forget a topic. Called when Telegram reports it gone (the user deleted it),
   * so the next message recreates one instead of failing forever on a dead id.
   */
  forget(conn: Database, chatId: string, threadId: number): void {
    conn.query('DELETE FROM topics WHERE chat_id = ? AND thread_id = ?').run(chatId, threadId)
  },
}

/* -------------------------------------------------------------- bindings -- */

export const bindings = {
  /** Which session a flat (topic-less) chat currently routes to. */
  get(conn: Database, chatId: string): string | null {
    const row = conn.query('SELECT session_id FROM bindings WHERE chat_id = ?').get(chatId) as
      { session_id: string } | null
    return row?.session_id ?? null
  },

  set(conn: Database, chatId: string, sessionId: string): void {
    conn.query(`INSERT INTO bindings (chat_id, session_id, updated_at) VALUES (?, ?, ?)
                ON CONFLICT (chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`)
      .run(chatId, sessionId, Date.now())
  },

  clear(conn: Database, chatId: string): void {
    conn.query('DELETE FROM bindings WHERE chat_id = ?').run(chatId)
  },
}

/* ----------------------------------------------------------------- queue -- */

export const queue = {
  /**
   * Hold a message typed at an offline project. Returns the queue depth so the
   * bot can tell the user how much is waiting.
   */
  push(conn: Database, cwd: string, payload: unknown): number {
    conn.query('INSERT INTO queue (cwd, payload, created_at) VALUES (?, ?, ?)')
      .run(cwd, JSON.stringify(payload), Date.now())
    return queue.depth(conn, cwd)
  },

  depth(conn: Database, cwd: string): number {
    return (conn.query('SELECT COUNT(*) AS n FROM queue WHERE cwd = ?').get(cwd) as { n: number }).n
  },

  /** Take everything queued for a project, oldest first, and clear it. */
  drain(conn: Database, cwd: string): unknown[] {
    const rows = conn.query('SELECT id, cwd, payload, created_at FROM queue WHERE cwd = ? ORDER BY id')
      .all(cwd) as QueueRow[]
    if (rows.length) conn.query('DELETE FROM queue WHERE cwd = ?').run(cwd)
    return rows.map(r => JSON.parse(r.payload) as unknown)
  },
}

/* -------------------------------------------------------------- settings -- */

const EMPTY: Omit<ProjectSettings, 'cwd'> = { model: null, effort: null, permission_mode: null }

export const settings = {
  get(conn: Database, cwd: string): ProjectSettings {
    const row = conn.query('SELECT cwd, model, effort, permission_mode FROM settings WHERE cwd = ?')
      .get(cwd) as ProjectSettings | null
    return row ?? { cwd, ...EMPTY }
  },

  /** Patch one project's settings; unnamed columns keep their stored value. */
  patch(conn: Database, cwd: string, patch: Partial<Omit<ProjectSettings, 'cwd'>>): ProjectSettings {
    const next = { ...settings.get(conn, cwd), ...patch }
    conn.query(`INSERT INTO settings (cwd, model, effort, permission_mode, updated_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (cwd) DO UPDATE SET model = excluded.model, effort = excluded.effort,
                  permission_mode = excluded.permission_mode, updated_at = excluded.updated_at`)
      .run(cwd, next.model, next.effort, next.permission_mode, Date.now())
    return next
  },
}

/* ------------------------------------------------------------------- hud -- */

export const hud = {
  /** The pinned status message for a topic, if one has been posted. */
  get(conn: Database, chatId: string, threadId: number): number | null {
    const row = conn.query('SELECT message_id FROM hud WHERE chat_id = ? AND thread_id = ?')
      .get(chatId, threadId) as { message_id: number } | null
    return row?.message_id ?? null
  },

  set(conn: Database, chatId: string, threadId: number, messageId: number): void {
    conn.query(`INSERT INTO hud (chat_id, thread_id, message_id, updated_at) VALUES (?, ?, ?, ?)
                ON CONFLICT (chat_id, thread_id) DO UPDATE SET message_id = excluded.message_id,
                  updated_at = excluded.updated_at`)
      .run(chatId, threadId, messageId, Date.now())
  },

  clear(conn: Database, chatId: string, threadId: number): void {
    conn.query('DELETE FROM hud WHERE chat_id = ? AND thread_id = ?').run(chatId, threadId)
  },
}

/* ----------------------------------------------------------------- turns -- */

export const turns = {
  begin(conn: Database, cwd: string, sessionId: string, prompt: string | null): number {
    const res = conn.query('INSERT INTO turns (cwd, session_id, started_at, prompt) VALUES (?, ?, ?, ?)')
      .run(cwd, sessionId, Date.now(), prompt)
    return Number(res.lastInsertRowid)
  },

  end(conn: Database, id: number, summary: string | null): void {
    conn.query('UPDATE turns SET ended_at = ?, summary = ? WHERE id = ?').run(Date.now(), summary, id)
  },

  recent(conn: Database, sessionId: string, limit = 10): { prompt: string | null; summary: string | null }[] {
    return conn.query('SELECT prompt, summary FROM turns WHERE session_id = ? ORDER BY id DESC LIMIT ?')
      .all(sessionId, limit) as { prompt: string | null; summary: string | null }[]
  },
}

/* --------------------------------------------------------------- handles -- */

/**
 * Short, stable ids for values too long to fit in a button.
 *
 * `callback_data` is capped at 64 bytes and an absolute path routinely exceeds
 * it, so a button carries a handle and the daemon looks the path back up. Ids
 * are minted once per value and reused, so a button stays valid across daemon
 * restarts — Telegram keeps old buttons on screen indefinitely.
 */
export const handles = {
  /** The id for `value`, minting one on first use. */
  of(conn: Database, value: string): string {
    const existing = conn.query('SELECT key FROM kv WHERE key LIKE ? AND value = ?')
      .get('h:%', JSON.stringify(value)) as { key: string } | null
    if (existing) return existing.key.slice(2)
    const id = Math.random().toString(36).slice(2, 8)
    conn.query('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(`h:${id}`, JSON.stringify(value))
    return id
  },

  /** The value behind an id, or `null` when the button predates a state reset. */
  get(conn: Database, id: string): string | null {
    const row = conn.query('SELECT value FROM kv WHERE key = ?').get(`h:${id}`) as { value: string } | null
    if (!row) return null
    try {
      const parsed = JSON.parse(row.value) as unknown
      return typeof parsed === 'string' ? parsed : null
    } catch {
      return null
    }
  },
}

/* -------------------------------------------------------------------- kv -- */

/**
 * A `@yaebal/sklad` `StorageAdapter` backed by the same database, so the i18n
 * plugin's per-chat locale lands in `cctg.db` rather than a second file.
 */
export function kvStore<T>(conn: Database, prefix: string) {
  return {
    get(key: string): T | undefined {
      const row = conn.query('SELECT value FROM kv WHERE key = ?').get(prefix + key) as { value: string } | null
      if (!row) return undefined
      try {
        return JSON.parse(row.value) as T
      } catch {
        return undefined
      }
    },
    set(key: string, value: T): void {
      conn.query('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
        .run(prefix + key, JSON.stringify(value))
    },
    delete(key: string): void {
      conn.query('DELETE FROM kv WHERE key = ?').run(prefix + key)
    },
    has(key: string): boolean {
      return conn.query('SELECT 1 FROM kv WHERE key = ?').get(prefix + key) !== null
    },
  }
}
