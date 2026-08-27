/**
 * The daemon's SQLite database — one file, `<state>/cctg.db`, opened once.
 *
 * Everything that must survive a daemon restart lives here: which topic belongs
 * to which project, which session a flat chat is bound to, the offline queue,
 * per-project settings, and the pinned status message ids. `@yaebal/sklad`
 * adapters (sessions, i18n locales) share the same file through the `kv` table,
 * so there is exactly one thing to back up and exactly one writer.
 *
 * WAL is on: the CLI opens the same file read-only for `cctg status` while the
 * daemon is writing, and without WAL that reader would block the writer.
 */

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { paths } from './paths.ts'

export type TopicRow = { chat_id: string; cwd: string; thread_id: number; name: string }
export type QueueRow = { id: number; cwd: string; payload: string; created_at: number }
export type ProjectSettings = {
  cwd: string
  model: string | null
  effort: string | null
  permission_mode: string | null
  /** A cca profile name, or `@best` for whichever has room. */
  account: string | null
}

const MIGRATIONS: string[] = [
  `CREATE TABLE topics (
     chat_id    TEXT    NOT NULL,
     cwd        TEXT    NOT NULL,
     thread_id  INTEGER NOT NULL,
     name       TEXT    NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (chat_id, cwd)
   );
   CREATE UNIQUE INDEX topics_by_thread ON topics (chat_id, thread_id);

   CREATE TABLE bindings (
     chat_id    TEXT    NOT NULL PRIMARY KEY,
     session_id TEXT    NOT NULL,
     updated_at INTEGER NOT NULL
   );

   CREATE TABLE queue (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     cwd        TEXT    NOT NULL,
     payload    TEXT    NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX queue_by_cwd ON queue (cwd, id);

   CREATE TABLE settings (
     cwd             TEXT NOT NULL PRIMARY KEY,
     model           TEXT,
     effort          TEXT,
     permission_mode TEXT,
     updated_at      INTEGER NOT NULL
   );

   CREATE TABLE hud (
     chat_id    TEXT    NOT NULL,
     thread_id  INTEGER NOT NULL,
     message_id INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (chat_id, thread_id)
   );

   CREATE TABLE turns (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     cwd        TEXT    NOT NULL,
     session_id TEXT    NOT NULL,
     started_at INTEGER NOT NULL,
     ended_at   INTEGER,
     prompt     TEXT,
     summary    TEXT
   );
   CREATE INDEX turns_by_session ON turns (session_id, id);

   CREATE TABLE kv (
     key   TEXT NOT NULL PRIMARY KEY,
     value TEXT NOT NULL
   );`,

  // Which claude-account-manager profile a project's sessions launch as.
  `ALTER TABLE settings ADD COLUMN account TEXT;`,
]

let handle: Database | undefined

/** Open (and migrate) the database. Idempotent — later calls reuse the handle. */
export function db(): Database {
  if (handle) return handle
  mkdirSync(paths.state, { recursive: true })
  const conn = new Database(paths.db, { create: true })
  conn.exec('PRAGMA journal_mode = WAL')
  conn.exec('PRAGMA foreign_keys = ON')
  migrate(conn)
  handle = conn
  return conn
}

/**
 * Apply every migration past `user_version`, each in its own transaction, then
 * bump the version. Migrations are append-only: never edit one that shipped.
 */
export function migrate(conn: Database): void {
  const current = (conn.query('PRAGMA user_version').get() as { user_version: number }).user_version
  for (let i = current; i < MIGRATIONS.length; i++) {
    conn.transaction(() => {
      conn.exec(MIGRATIONS[i] as string)
      conn.exec(`PRAGMA user_version = ${i + 1}`)
    })()
  }
}

/** Close the handle — tests and `cctg` one-shot commands use this. */
export function closeDb(): void {
  handle?.close()
  handle = undefined
}

/** Open an in-memory database with the same schema, for tests. */
export function memoryDb(): Database {
  const conn = new Database(':memory:')
  migrate(conn)
  return conn
}
