/**
 * Who may reach the assistant. Kept in `<state>/access.json` — plain JSON on
 * purpose, because the `/cctg:access` skill edits it from a terminal session and
 * a human has to be able to read what they just allowed.
 *
 * The daemon re-reads the file when its mtime changes, so an edit takes effect
 * without a restart.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { paths } from '../paths.ts'

/**
 * `pairing` answers an unknown DM with a one-time code so the user can approve
 * it from their terminal. `allowlist` answers nobody it does not already know —
 * the mode to switch to once you are in. `open` is for a private bot on a
 * machine only you can reach.
 */
export type DmPolicy = 'pairing' | 'allowlist' | 'open'

export type Access = {
  dmPolicy: DmPolicy
  /** Numeric Telegram user ids allowed to DM the bot. */
  allowedUsers: string[]
  /** Group/supergroup chat ids the bot answers in (on mention). */
  allowedChats: string[]
  /** Require an @mention before answering in a group. */
  requireMention: boolean
  /** Emoji reaction acknowledging receipt; must be on Telegram's fixed list. */
  ackReaction: string | null
  /** Live pairing codes, keyed by code. */
  pending: Record<string, { userId: string; chatId: string; expiresAt: number }>
}

export const DEFAULT_ACCESS: Access = {
  dmPolicy: 'pairing',
  allowedUsers: [],
  allowedChats: [],
  requireMention: true,
  ackReaction: '👀',
  pending: {},
}

/** Telegram only accepts reactions from this fixed set on most messages. */
export const REACTION_WHITELIST = [
  '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '🎉', '🤩',
  '🙏', '👌', '🕊', '🤡', '🥱', '🥴', '😍', '🐳', '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡',
  '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈', '😴', '😭', '🤓', '👻',
  '👨‍💻', '👀', '🎃', '🙈', '😇', '😨', '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅',
  '🤪', '🗿', '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷‍♂', '🤷', '🤷‍♀', '😡',
] as const

const PAIRING_TTL_MS = 10 * 60 * 1000

let cached: { at: number; value: Access } | undefined

function mtime(): number {
  try {
    return statSync(paths.access).mtimeMs
  } catch {
    return 0
  }
}

/** Read `access.json`, reusing the last parse while the file is untouched. */
export function loadAccess(): Access {
  const at = mtime()
  if (cached && cached.at === at) return cached.value
  let parsed: Partial<Access> = {}
  try {
    if (existsSync(paths.access)) parsed = JSON.parse(readFileSync(paths.access, 'utf8')) as Partial<Access>
  } catch {
    // A hand-edited file with a syntax error must not open the bot up: fall
    // through to defaults, which deny everyone until it is fixed.
    parsed = {}
  }
  const value: Access = {
    ...DEFAULT_ACCESS,
    ...parsed,
    allowedUsers: (parsed.allowedUsers ?? []).map(String),
    allowedChats: (parsed.allowedChats ?? []).map(String),
    pending: parsed.pending ?? {},
  }
  cached = { at, value }
  return value
}

export function saveAccess(a: Access): void {
  mkdirSync(paths.state, { recursive: true })
  writeFileSync(paths.access, `${JSON.stringify(a, null, 2)}\n`, { mode: 0o600 })
  cached = undefined
}

/** Drop expired pairing codes. Returns true when something was removed. */
export function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt <= now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

/**
 * Mint a pairing code for an unknown user. Unambiguous alphabet — no `0`/`O`,
 * no `1`/`I` — because the user reads this off a phone and types it in a
 * terminal.
 */
export function mintPairingCode(a: Access, userId: string, chatId: string): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  for (const b of bytes) code += alphabet[b % alphabet.length]
  a.pending[code] = { userId, chatId, expiresAt: Date.now() + PAIRING_TTL_MS }
  return code
}

export type Gate =
  | { ok: true }
  | { ok: false; reason: 'unknown-user'; userId: string; chatId: string }
  | { ok: false; reason: 'denied' }

/** Decide whether a DM from `userId` may be forwarded to a session. */
export function gateDm(a: Access, userId: string): Gate {
  if (a.dmPolicy === 'open') return { ok: true }
  if (a.allowedUsers.includes(userId)) return { ok: true }
  if (a.dmPolicy === 'pairing') return { ok: false, reason: 'unknown-user', userId, chatId: userId }
  return { ok: false, reason: 'denied' }
}

/** Decide whether a group message may be forwarded. */
export function gateGroup(a: Access, chatId: string, mentioned: boolean): Gate {
  if (!a.allowedChats.includes(chatId)) return { ok: false, reason: 'denied' }
  if (a.requireMention && !mentioned) return { ok: false, reason: 'denied' }
  return { ok: true }
}
