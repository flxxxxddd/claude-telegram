#!/usr/bin/env bun
/**
 * Telegram channel DAEMON — one long-lived process per bot token.
 *
 * Owns the single Telegram getUpdates poller, all access control / pairing, and
 * every Bot API call. Claude Code sessions attach via per-session MCP shims
 * (server.ts) over a UNIX socket; the daemon routes inbound Telegram messages to
 * the right session and executes outbound tool calls on their behalf.
 *
 * This inverts the upstream design (one poller per session) so that N sessions
 * can share one bot token without fighting over the single getUpdates slot.
 */

import { z } from 'zod'
import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { randomBytes } from 'crypto'
import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync,
  renameSync, realpathSync, chmodSync, unlinkSync,
} from 'fs'
import { execFileSync, spawn } from 'child_process'
import { join, extname, sep, basename } from 'path'
import { createServer, connect, type Socket } from 'net'
import {
  STATE_DIR, SOCK_PATH, DAEMON_PID_FILE, frame,
  type ShimMsg, type SessionInfo,
} from './protocol.ts'

const ACCESS_FILE = join(STATE_DIR, 'access.json')
const APPROVED_DIR = join(STATE_DIR, 'approved')
const ENV_FILE = join(STATE_DIR, '.env')
const INBOX_DIR = join(STATE_DIR, 'inbox')

// Load ~/.claude/channels/telegram/.env into process.env. Real env wins.
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
const STATIC = process.env.TELEGRAM_ACCESS_MODE === 'static'

if (!TOKEN) {
  process.stderr.write('telegram daemon: TELEGRAM_BOT_TOKEN required\n')
  process.exit(1)
}

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

function log(msg: string): void {
  process.stderr.write(`telegram daemon: ${msg}\n`)
}

// ── Single-instance guard ──────────────────────────────────────────────────
// Only one daemon may hold the socket. If the socket file exists, probe it: a
// live listener means another daemon already runs (we exit); a dead socket
// (ECONNREFUSED/ENOENT) is stale and we reclaim it.
async function ensureSingleInstance(): Promise<void> {
  const alive = await new Promise<boolean>(resolve => {
    const probe = connect(SOCK_PATH)
    probe.on('connect', () => { probe.destroy(); resolve(true) })
    probe.on('error', () => resolve(false))
  })
  if (alive) {
    log('another daemon is already listening — exiting')
    process.exit(0)
  }
  try { unlinkSync(SOCK_PATH) } catch {}
}

// ── Access control (ported from upstream server.ts) ────────────────────────
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
const MAX_CHUNK_LIMIT = 4096
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}
type GroupPolicy = { requireMention: boolean; allowFrom: string[] }
type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

function readAccessFile(): Access {
  try {
    const parsed = JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try { renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`) } catch {}
    log('access.json is corrupt, moved aside. Starting fresh.')
    return defaultAccess()
  }
}

const BOOT_ACCESS: Access | null = STATIC
  ? (() => {
      const a = readAccessFile()
      if (a.dmPolicy === 'pairing') {
        log('static mode — dmPolicy "pairing" downgraded to "allowlist"')
        a.dmPolicy = 'allowlist'
      }
      a.pending = {}
      return a
    })()
  : null

function loadAccess(): Access {
  return BOOT_ACCESS ?? readAccessFile()
}

function saveAccess(a: Access): void {
  if (STATIC) return
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

function assertAllowedChat(chat_id: string): void {
  const access = loadAccess()
  if (access.allowFrom.includes(chat_id)) return
  if (chat_id in access.groups) return
  throw new Error(`chat ${chat_id} is not allowlisted — add via /telegram:access`)
}

function assertSendable(f: string): void {
  let real, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch { return }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) { delete a.pending[code]; changed = true }
  }
  return changed
}

type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

function gate(ctx: Context): GateResult {
  const access = loadAccess()
  if (pruneExpired(access)) saveAccess(access)
  if (access.dmPolicy === 'disabled') return { action: 'drop' }
  const from = ctx.from
  if (!from) return { action: 'drop' }
  const senderId = String(from.id)
  const chatType = ctx.chat?.type

  if (chatType === 'private') {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }
    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = {
      senderId, chatId: String(ctx.chat!.id),
      createdAt: now, expiresAt: now + 60 * 60 * 1000, replies: 1,
    }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }

  if (chatType === 'group' || chatType === 'supergroup') {
    const groupId = String(ctx.chat!.id)
    const policy = access.groups[groupId]
    if (!policy) return { action: 'drop' }
    const groupAllowFrom = policy.allowFrom ?? []
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) return { action: 'drop' }
    if ((policy.requireMention ?? true) && !isMentioned(ctx, access.mentionPatterns)) return { action: 'drop' }
    return { action: 'deliver', access }
  }
  return { action: 'drop' }
}

function dmCommandGate(ctx: Context): { access: Access; senderId: string } | null {
  if (ctx.chat?.type !== 'private') return null
  if (!ctx.from) return null
  const senderId = String(ctx.from.id)
  const access = loadAccess()
  if (pruneExpired(access)) saveAccess(access)
  if (access.dmPolicy === 'disabled') return null
  if (access.dmPolicy === 'allowlist' && !access.allowFrom.includes(senderId)) return null
  return { access, senderId }
}

function isMentioned(ctx: Context, extraPatterns?: string[]): boolean {
  const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? []
  const text = ctx.message?.text ?? ctx.message?.caption ?? ''
  for (const e of entities) {
    if (e.type === 'mention') {
      if (text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${botUsername}`.toLowerCase()) return true
    }
    if (e.type === 'text_mention' && e.user?.is_bot && e.user.username === botUsername) return true
  }
  if (ctx.message?.reply_to_message?.from?.username === botUsername) return true
  for (const pat of extraPatterns ?? []) {
    try { if (new RegExp(pat, 'i').test(text)) return true } catch {}
  }
  return false
}

function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

// ── Session registry & routing ─────────────────────────────────────────────
type Session = {
  info: SessionInfo
  send: (obj: unknown) => void
  sock: Socket
}
const sessions = new Map<string, Session>() // sessionId → Session
// chat_id → sessionId. Inbound for a chat routes to its bound session. Phase 1
// auto-binds a chat to the most-recently-registered session; Phase 2 adds an
// explicit /sessions picker.
const chatBindings = new Map<string, string>()
// request_id → sessionId, so a permission answer reaches the session that asked.
const permissionOwner = new Map<string, string>()
const pendingPermissions = new Map<string, { tool_name: string; description: string; input_preview: string }>()

// ask_id → an in-flight `ask` tool call blocked on a Telegram button tap.
type PendingAsk = {
  resolve: (label: string) => void
  question: string
  options: string[]
  timer: ReturnType<typeof setTimeout>
}
const pendingAsks = new Map<string, PendingAsk>()

// stream_id (message_id) → live "streaming" message state, debounced so bursty
// edits don't trip Telegram's ~1 edit/sec rate limit.
type StreamState = { chat_id: string; latest: string; lastEditAt: number; timer: ReturnType<typeof setTimeout> | null }
const streams = new Map<string, StreamState>()
const STREAM_MIN_INTERVAL = 1100

function flushStream(id: string): void {
  const st = streams.get(id)
  if (!st) return
  st.lastEditAt = Date.now()
  st.timer = null
  void bot.api.editMessageText(st.chat_id, Number(id), st.latest).catch(() => {})
}

function scheduleStreamEdit(id: string): void {
  const st = streams.get(id)
  if (!st || st.timer) return
  const wait = Math.max(0, STREAM_MIN_INTERVAL - (Date.now() - st.lastEditAt))
  st.timer = setTimeout(() => flushStream(id), wait)
}

// ── Threading: one DM forum topic per session (Phase 3) ─────────────────────
// Requires the bot to have Topic Mode enabled (BotFather); detected at boot via
// getMe().has_topics_enabled. Each session gets its own topic in each allowlisted
// DM; the daemon injects that topic's message_thread_id into the session's
// outbound messages and routes inbound by the topic the user typed in.
const THREAD_MODE = (process.env.TELEGRAM_THREAD_MODE as 'auto' | 'topics' | 'flat' | undefined) ?? 'auto'
let topicsEnabled = false // from getMe().has_topics_enabled

function threadingActive(): boolean {
  return THREAD_MODE === 'topics' || (THREAD_MODE === 'auto' && topicsEnabled)
}

// Topics are keyed by PROJECT (cwd), not by the ephemeral session id, so a
// reconnecting session (new id each spawn) or a daemon restart reattaches to the
// same topic. Disconnect leaves the topic in place and just marks it offline —
// remote-control style. Persisted to topics.json so it survives restarts.
const TOPICS_FILE = join(STATE_DIR, 'topics.json')
type TopicRec = { chat_id: string; cwd: string; thread_id: number; title: string }
const topicByKey = new Map<string, TopicRec>()          // `${chatId}::${cwd}` → topic
const cwdByThread = new Map<string, string>()            // `${chatId}:${threadId}` → cwd
const sessionByCwd = new Map<string, string>()           // cwd → currently-online sessionId

const topicKey = (chatId: string, cwd: string) => `${chatId}::${cwd}`

function loadTopics(): void {
  try {
    const recs = JSON.parse(readFileSync(TOPICS_FILE, 'utf8')) as TopicRec[]
    for (const r of recs) {
      topicByKey.set(topicKey(r.chat_id, r.cwd), r)
      cwdByThread.set(`${r.chat_id}:${r.thread_id}`, r.cwd)
    }
  } catch {}
}

function saveTopics(): void {
  try {
    const tmp = TOPICS_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify([...topicByKey.values()], null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, TOPICS_FILE)
  } catch (err) { log(`saveTopics failed: ${err}`) }
}

// message_thread_id for a session's outbound messages in a given chat.
function threadOpts(sessionId: string | null, chatId: string): { message_thread_id?: number } {
  if (!sessionId) return {}
  const cwd = sessions.get(sessionId)?.info.cwd
  if (!cwd) return {}
  const rec = topicByKey.get(topicKey(chatId, cwd))
  return rec ? { message_thread_id: rec.thread_id } : {}
}

// Create (or reattach to) a project topic in a DM, then announce online.
async function ensureTopic(chatId: string, cwd: string, title: string): Promise<void> {
  if (!threadingActive()) return
  if (Number(chatId) <= 0) return // DMs only (positive user IDs); groups stay flat
  const key = topicKey(chatId, cwd)
  let rec = topicByKey.get(key)
  if (rec && rec.title !== title) {
    // Project title changed — rename the existing topic to match.
    void bot.api.editForumTopic(chatId, rec.thread_id, { name: `🧵 ${title}`.slice(0, 128) }).catch(() => {})
    rec.title = title
    saveTopics()
  }
  if (!rec) {
    try {
      const topic = await bot.api.createForumTopic(chatId, `🧵 ${title}`.slice(0, 128))
      rec = { chat_id: chatId, cwd, thread_id: topic.message_thread_id, title }
      topicByKey.set(key, rec)
      cwdByThread.set(`${chatId}:${topic.message_thread_id}`, cwd)
      saveTopics()
    } catch (err) {
      log(`createForumTopic failed for "${title}" in ${chatId}: ${err}`)
      return
    }
  }
  await bot.api.sendMessage(chatId, `🟢 online — ${title}`, { message_thread_id: rec.thread_id }).catch(() => {})
}

// Session went away: keep the topic, announce offline, and offer a Start button.
function markOffline(cwd: string, title: string): void {
  if (!threadingActive()) return
  for (const rec of topicByKey.values()) {
    if (rec.cwd !== cwd) continue
    const kb = new InlineKeyboard().text('▶️ Start session', `start:${rec.thread_id}`)
    void bot.api.sendMessage(rec.chat_id, `🔴 offline — ${title}`, { message_thread_id: rec.thread_id, reply_markup: kb }).catch(() => {})
  }
}

// ── Launch a Claude Code session from Telegram (#5) ─────────────────────────
// Actual spawning happens only when TELEGRAM_LAUNCH_CMD is set (a shell template
// with {cwd}/{name} placeholders); otherwise we reply with the exact command to
// run manually. Keeps process-spawning opt-in and testable pre-cutover.
function defaultLaunchHint(cwd: string): string {
  return `cd ${cwd} && claude --channels plugin:telegram@claude-plugins-official`
}

function launchSession(cwd: string): { spawned: boolean; detail: string } {
  const tmpl = process.env.TELEGRAM_LAUNCH_CMD
  if (!tmpl) return { spawned: false, detail: defaultLaunchHint(cwd) }
  const cmd = tmpl.replaceAll('{cwd}', cwd).replaceAll('{name}', basename(cwd) || 'session')
  try {
    spawn('sh', ['-c', cmd], { detached: true, stdio: 'ignore', cwd }).unref()
    return { spawned: true, detail: cmd }
  } catch (err) {
    return { spawned: false, detail: `launch failed: ${err}` }
  }
}

// ── Offline inbound queue ───────────────────────────────────────────────────
// Messages typed into a project topic while its session is offline are held
// (per cwd, persisted) and replayed in order when a session for that project
// reconnects — so nothing is lost across a restart.
const QUEUE_FILE = join(STATE_DIR, 'queue.json')
const QUEUE_MAX = 100
const queuedInbound = new Map<string, unknown[]>() // cwd → inbound params[]

function loadQueue(): void {
  try {
    const obj = JSON.parse(readFileSync(QUEUE_FILE, 'utf8')) as Record<string, unknown[]>
    for (const [cwd, arr] of Object.entries(obj)) queuedInbound.set(cwd, arr)
  } catch {}
}

function saveQueue(): void {
  try {
    const tmp = QUEUE_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(queuedInbound), null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, QUEUE_FILE)
  } catch (err) { log(`saveQueue failed: ${err}`) }
}

function enqueueInbound(cwd: string, params: unknown): number {
  const arr = queuedInbound.get(cwd) ?? []
  arr.push(params)
  while (arr.length > QUEUE_MAX) arr.shift() // drop oldest past the cap
  queuedInbound.set(cwd, arr)
  saveQueue()
  return arr.length
}

function flushQueue(cwd: string, session: Session): void {
  const arr = queuedInbound.get(cwd)
  if (!arr || arr.length === 0) return
  log(`flushing ${arr.length} queued message(s) to ${cwd}`)
  for (const params of arr) session.send({ t: 'inbound', params })
  queuedInbound.delete(cwd)
  saveQueue()
}

// ── Activity mirror (tool-call feed via the activity hook) ──────────────────
// The hook fires per tool use and streams short lines here; we coalesce a burst
// into one topic message so a busy turn doesn't spam the chat or hit rate limits.
const ACTIVITY_FLUSH_MS = 1500
const ACTIVITY_MAX_LINES = 20
const activityBuf = new Map<string, { lines: string[]; timer: ReturnType<typeof setTimeout> }>() // cwd → buffer

function flushActivity(cwd: string): void {
  const buf = activityBuf.get(cwd)
  if (!buf) return
  activityBuf.delete(cwd)
  const text = buf.lines.slice(0, ACTIVITY_MAX_LINES).join('\n') +
    (buf.lines.length > ACTIVITY_MAX_LINES ? `\n… +${buf.lines.length - ACTIVITY_MAX_LINES} more` : '')
  for (const rec of topicByKey.values()) {
    if (rec.cwd !== cwd) continue
    void bot.api.sendMessage(rec.chat_id, text, { message_thread_id: rec.thread_id }).catch(() => {})
  }
}

function postActivity(cwd: string, text: string): void {
  if (!threadingActive()) return
  const buf = activityBuf.get(cwd)
  if (buf) { buf.lines.push(text); return }
  activityBuf.set(cwd, { lines: [text], timer: setTimeout(() => flushActivity(cwd), ACTIVITY_FLUSH_MS) })
}

// Build the `notifications/claude/channel` params for one inbound message.
function buildInboundParams(
  ctx: Context, text: string, imagePath: string | undefined, attachment?: AttachmentMeta,
): Record<string, unknown> {
  const from = ctx.from!
  const msgId = ctx.message?.message_id
  return {
    content: text,
    meta: {
      chat_id: String(ctx.chat!.id),
      ...(msgId != null ? { message_id: String(msgId) } : {}),
      user: from.username ?? String(from.id),
      user_id: String(from.id),
      ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
      ...(imagePath ? { image_path: imagePath } : {}),
      ...(attachment ? {
        attachment_kind: attachment.kind,
        attachment_file_id: attachment.file_id,
        ...(attachment.size != null ? { attachment_size: String(attachment.size) } : {}),
        ...(attachment.mime ? { attachment_mime: attachment.mime } : {}),
        ...(attachment.name ? { attachment_name: attachment.name } : {}),
      } : {}),
    },
  }
}

function mostRecentSessionId(): string | undefined {
  let last: string | undefined
  for (const id of sessions.keys()) last = id
  return last
}

function resolveSession(chatId: string, threadId?: number): Session | undefined {
  // A message typed inside a project topic routes to that project's online session.
  if (threadId != null) {
    const cwd = cwdByThread.get(`${chatId}:${threadId}`)
    if (cwd) {
      const sid = sessionByCwd.get(cwd)
      return sid && sessions.has(sid) ? sessions.get(sid) : undefined
    }
  }
  let sid = chatBindings.get(chatId)
  if (!sid || !sessions.has(sid)) {
    sid = mostRecentSessionId()
    if (sid) chatBindings.set(chatId, sid)
  }
  return sid ? sessions.get(sid) : undefined
}

// True when the thread is a known project topic whose session is currently offline.
function isOfflineTopic(chatId: string, threadId?: number): string | null {
  if (threadId == null) return null
  const cwd = cwdByThread.get(`${chatId}:${threadId}`)
  if (!cwd) return null
  const sid = sessionByCwd.get(cwd)
  return sid && sessions.has(sid) ? null : cwd
}

function dropSession(sessionId: string): void {
  const info = sessions.get(sessionId)?.info
  sessions.delete(sessionId)
  // Only clear the cwd→session binding if it still points at this session (a
  // newer session for the same project may have already taken over).
  if (info && sessionByCwd.get(info.cwd) === sessionId) {
    sessionByCwd.delete(info.cwd)
    markOffline(info.cwd, info.title) // keep the topic, just announce offline
  }
  for (const [chat, sid] of chatBindings) if (sid === sessionId) chatBindings.delete(chat)
  for (const [rid, sid] of permissionOwner) if (sid === sessionId) permissionOwner.delete(rid)
  log(`session ${sessionId} disconnected (${sessions.size} remaining)`)
}

// ── Bot ────────────────────────────────────────────────────────────────────
const bot = new Bot(TOKEN)
let botUsername = ''

function checkApprovals(): void {
  let files: string[]
  try { files = readdirSync(APPROVED_DIR) } catch { return }
  for (const senderId of files) {
    const file = join(APPROVED_DIR, senderId)
    void bot.api.sendMessage(senderId, 'Paired! Say hi to Claude.').then(
      () => rmSync(file, { force: true }),
      err => { log(`failed to send approval confirm: ${err}`); rmSync(file, { force: true }) },
    )
  }
}

// ── Outbound tool execution (called on behalf of a session) ────────────────
async function runTool(sessionId: string | null, name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'reply': {
      const chat_id = args.chat_id as string
      const text = args.text as string
      const reply_to = args.reply_to != null ? Number(args.reply_to) : undefined
      const files = (args.files as string[] | undefined) ?? []
      const format = (args.format as string | undefined) ?? 'text'
      const parseMode = format === 'markdownv2' ? ('MarkdownV2' as const) : undefined
      assertAllowedChat(chat_id)
      for (const f of files) {
        assertSendable(f)
        const st = statSync(f)
        if (st.size > MAX_ATTACHMENT_BYTES) {
          throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
        }
      }
      const access = loadAccess()
      const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
      const mode = access.chunkMode ?? 'length'
      const replyMode = access.replyToMode ?? 'first'
      const chunks = chunk(text, limit, mode)
      const thread = threadOpts(sessionId, chat_id)
      const sentIds: number[] = []
      try {
        for (let i = 0; i < chunks.length; i++) {
          const shouldReplyTo = reply_to != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
          const sent = await bot.api.sendMessage(chat_id, chunks[i], {
            ...thread,
            ...(shouldReplyTo ? { reply_parameters: { message_id: reply_to } } : {}),
            ...(parseMode ? { parse_mode: parseMode } : {}),
          })
          sentIds.push(sent.message_id)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`)
      }
      for (const f of files) {
        const ext = extname(f).toLowerCase()
        const input = new InputFile(f)
        const opts = { ...thread, ...(reply_to != null && replyMode !== 'off' ? { reply_parameters: { message_id: reply_to } } : {}) }
        const sent = PHOTO_EXTS.has(ext) ? await bot.api.sendPhoto(chat_id, input, opts) : await bot.api.sendDocument(chat_id, input, opts)
        sentIds.push(sent.message_id)
      }
      return sentIds.length === 1 ? `sent (id: ${sentIds[0]})` : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
    }
    case 'react': {
      assertAllowedChat(args.chat_id as string)
      await bot.api.setMessageReaction(args.chat_id as string, Number(args.message_id), [
        { type: 'emoji', emoji: args.emoji as ReactionTypeEmoji['emoji'] },
      ])
      return 'reacted'
    }
    case 'download_attachment': {
      const file_id = args.file_id as string
      const file = await bot.api.getFile(file_id)
      if (!file.file_path) throw new Error('Telegram returned no file_path — file may have expired')
      const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
      const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
      const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
      const path = join(INBOX_DIR, `${Date.now()}-${uniqueId}.${ext}`)
      mkdirSync(INBOX_DIR, { recursive: true })
      writeFileSync(path, buf)
      return path
    }
    case 'edit_message': {
      assertAllowedChat(args.chat_id as string)
      const editFormat = (args.format as string | undefined) ?? 'text'
      const editParseMode = editFormat === 'markdownv2' ? ('MarkdownV2' as const) : undefined
      const edited = await bot.api.editMessageText(
        args.chat_id as string, Number(args.message_id), args.text as string,
        ...(editParseMode ? [{ parse_mode: editParseMode }] : []),
      )
      const id = typeof edited === 'object' ? edited.message_id : args.message_id
      return `edited (id: ${id})`
    }
    case 'ask': {
      const chat_id = args.chat_id as string
      const question = (args.question as string) ?? ''
      const rawOptions = (args.options as Array<{ label: string; description?: string }> | undefined) ?? []
      if (rawOptions.length < 2) throw new Error('ask requires at least 2 options')
      assertAllowedChat(chat_id)
      const ask_id = randomBytes(3).toString('hex')
      const kb = new InlineKeyboard()
      // callback_data caps at 64 bytes: `ask:<6hex>:<idx>` stays well under.
      rawOptions.forEach((o, i) => { kb.text(o.label.slice(0, 60), `ask:${ask_id}:${i}`); kb.row() })
      const header = args.header ? `${args.header}\n\n` : ''
      const body = rawOptions.map((o, i) => o.description ? `${i + 1}. ${o.label} — ${o.description}` : `${i + 1}. ${o.label}`).join('\n')
      const text = `❓ ${header}${question}\n\n${body}`
      await bot.api.sendMessage(chat_id, text, { ...threadOpts(sessionId, chat_id), reply_markup: kb })
      return await new Promise<string>(resolve => {
        const timer = setTimeout(() => {
          pendingAsks.delete(ask_id)
          resolve('(no answer — the user did not respond in Telegram)')
        }, 15 * 60 * 1000)
        pendingAsks.set(ask_id, { resolve, question: text, options: rawOptions.map(o => o.label), timer })
      })
    }
    case 'stream': {
      const chat_id = args.chat_id as string
      const text = (args.text as string) ?? ''
      const stream_id = args.stream_id != null ? String(args.stream_id) : undefined
      const action = (args.action as string | undefined) ?? (stream_id ? 'update' : 'start')
      assertAllowedChat(chat_id)
      if (action === 'start' || !stream_id) {
        const sent = await bot.api.sendMessage(chat_id, text || '…', threadOpts(sessionId, chat_id))
        streams.set(String(sent.message_id), { chat_id, latest: text || '…', lastEditAt: Date.now(), timer: null })
        return String(sent.message_id)
      }
      const st = streams.get(stream_id)
      if (!st) {
        // Unknown/expired stream — best-effort direct edit so callers still work.
        await bot.api.editMessageText(chat_id, Number(stream_id), text).catch(() => {})
        return stream_id
      }
      st.latest = text
      if (action === 'final') {
        if (st.timer) { clearTimeout(st.timer); st.timer = null }
        await bot.api.editMessageText(chat_id, Number(stream_id), text).catch(() => {})
        streams.delete(stream_id)
      } else {
        scheduleStreamEdit(stream_id)
      }
      return stream_id
    }
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}

// ── Inbound → route to a session ───────────────────────────────────────────
type AttachmentMeta = { kind: string; file_id: string; size?: number; mime?: string; name?: string }

async function handleInbound(
  ctx: Context,
  text: string,
  downloadImage: (() => Promise<string | undefined>) | undefined,
  attachment?: AttachmentMeta,
): Promise<void> {
  const result = gate(ctx)
  if (result.action === 'drop') return
  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    await ctx.reply(`${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`)
    return
  }

  const access = result.access
  const chat_id = String(ctx.chat!.id)
  const msgId = ctx.message?.message_id

  // Permission-reply intercept ("yes xxxxx" / "no xxxxx").
  const permMatch = PERMISSION_REPLY_RE.exec(text)
  if (permMatch) {
    const request_id = permMatch[2]!.toLowerCase()
    const behavior = permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny'
    deliverPermissionReply(request_id, behavior)
    if (msgId != null) {
      const emoji = behavior === 'allow' ? '✅' : '❌'
      void bot.api.setMessageReaction(chat_id, msgId, [{ type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] }]).catch(() => {})
    }
    return
  }

  const threadId = ctx.message?.message_thread_id
  const session = resolveSession(chat_id, threadId)
  if (!session) {
    const offlineCwd = isOfflineTopic(chat_id, threadId)
    if (offlineCwd) {
      // Queue it for replay when a session for this project reconnects.
      const imagePath = downloadImage ? await downloadImage() : undefined
      const depth = enqueueInbound(offlineCwd, buildInboundParams(ctx, text, imagePath, attachment))
      void bot.api.sendMessage(chat_id, `🕓 Session offline — queued (#${depth}). I'll deliver it when Claude Code reopens this project.`, { message_thread_id: threadId }).catch(() => {})
    } else {
      void bot.api.sendMessage(chat_id, '⚠️ No Claude Code session is connected right now. Start one with the telegram channel and try again.').catch(() => {})
    }
    return
  }

  void bot.api.sendChatAction(chat_id, 'typing').catch(() => {})
  if (access.ackReaction && msgId != null) {
    void bot.api.setMessageReaction(chat_id, msgId, [{ type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] }]).catch(() => {})
  }

  const imagePath = downloadImage ? await downloadImage() : undefined
  session.send({ t: 'inbound', params: buildInboundParams(ctx, text, imagePath, attachment) })
}

function deliverPermissionReply(request_id: string, behavior: 'allow' | 'deny'): void {
  const sid = permissionOwner.get(request_id)
  const session = sid ? sessions.get(sid) : undefined
  if (session) session.send({ t: 'permission_reply', request_id, behavior })
  permissionOwner.delete(request_id)
  pendingPermissions.delete(request_id)
}

// A permission_request arrived from a shim → render inline buttons in every
// allowlisted DM. Ownership is tracked so the answer routes back to that shim.
function onPermissionRequest(sessionId: string, request_id: string, tool_name: string, description: string, input_preview: string): void {
  permissionOwner.set(request_id, sessionId)
  pendingPermissions.set(request_id, { tool_name, description, input_preview })
  const access = loadAccess()
  const text = `🔐 Permission: ${tool_name}`
  const keyboard = new InlineKeyboard()
    .text('See more', `perm:more:${request_id}`)
    .text('✅ Allow', `perm:allow:${request_id}`)
    .text('❌ Deny', `perm:deny:${request_id}`)
  for (const chat_id of access.allowFrom) {
    void bot.api.sendMessage(chat_id, text, { ...threadOpts(sessionId, chat_id), reply_markup: keyboard }).catch(e => log(`permission_request send to ${chat_id} failed: ${e}`))
  }
}

// ── Bot handlers ───────────────────────────────────────────────────────────
bot.command('start', async ctx => {
  if (!dmCommandGate(ctx)) return
  await ctx.reply(
    `This bot bridges Telegram to Claude Code sessions.\n\n` +
    `To pair:\n1. DM me anything — you'll get a 6-char code\n` +
    `2. In Claude Code: /telegram:access pair <code>\n\nAfter that, DMs here reach a session.`,
  )
})

bot.command('help', async ctx => {
  if (!dmCommandGate(ctx)) return
  await ctx.reply(
    `Messages route to a connected Claude Code session.\n\n` +
    `/start — pairing instructions\n/status — pairing state\n/sessions — list & pick a session`,
  )
})

bot.command('status', async ctx => {
  const gated = dmCommandGate(ctx)
  if (!gated) return
  const { access, senderId } = gated
  if (access.allowFrom.includes(senderId)) {
    const name = ctx.from!.username ? `@${ctx.from!.username}` : senderId
    const bound = chatBindings.get(String(ctx.chat!.id))
    const boundInfo = bound && sessions.has(bound) ? ` → ${sessions.get(bound)!.info.title}` : ' (no session bound)'
    await ctx.reply(`Paired as ${name}.${boundInfo}`)
    return
  }
  for (const [code, p] of Object.entries(access.pending)) {
    if (p.senderId === senderId) {
      await ctx.reply(`Pending pairing — run in Claude Code:\n\n/telegram:access pair ${code}`)
      return
    }
  }
  await ctx.reply(`Not paired. Send me a message to get a pairing code.`)
})

// /sessions — list connected sessions, tap to bind this chat to one.
bot.command('sessions', async ctx => {
  const gated = dmCommandGate(ctx)
  if (!gated || !gated.access.allowFrom.includes(gated.senderId)) return
  if (sessions.size === 0) { await ctx.reply('No Claude Code sessions connected.'); return }
  const chatId = String(ctx.chat!.id)
  const boundSid = chatBindings.get(chatId)
  const kb = new InlineKeyboard()
  const lines: string[] = []
  for (const s of sessions.values()) {
    const mark = s.info.id === boundSid ? '✅ ' : ''
    lines.push(`${mark}${s.info.title} — ${s.info.cwd}`)
    kb.text(`${mark}${s.info.title}`, `sess:bind:${s.info.id}`).row()
  }
  await ctx.reply(`Connected sessions — tap to route this chat:\n\n${lines.join('\n')}`, { reply_markup: kb })
})

// /new [path] — with a path, start a session THERE; without, list known projects.
bot.command('new', async ctx => {
  const gated = dmCommandGate(ctx)
  if (!gated || !gated.access.allowFrom.includes(gated.senderId)) return
  const chatId = String(ctx.chat!.id)

  const arg = (ctx.match as string | undefined)?.trim()
  if (arg) {
    // Treat the argument as a project directory to launch a session in.
    let dir: string
    try {
      dir = realpathSync(arg)
      if (!statSync(dir).isDirectory()) throw new Error('not a directory')
    } catch {
      await ctx.reply(`❌ Path not found or not a directory:\n${arg}`)
      return
    }
    if (sessionByCwd.has(dir)) { await ctx.reply(`🟢 A session is already online for ${dir}`); return }
    const res = launchSession(dir)
    if (res.spawned) await ctx.reply(`▶️ Launching a session in:\n${dir}`)
    else await ctx.reply(`To start a session there, run:\n\n${res.detail}\n\n(Set TELEGRAM_LAUNCH_CMD on the daemon to enable one-tap start.)`)
    return
  }

  const recs = [...topicByKey.values()].filter(r => r.chat_id === chatId)
  if (recs.length === 0) { await ctx.reply('No known projects yet. A topic is created the first time a session connects. Use /new <path> to start one in a specific directory.'); return }
  const kb = new InlineKeyboard()
  const lines: string[] = []
  for (const r of recs) {
    const online = sessionByCwd.has(r.cwd)
    lines.push(`${online ? '🟢' : '🔴'} ${r.title} — ${r.cwd}`)
    if (!online) kb.text(`▶️ ${r.title}`, `start:${r.thread_id}`).row()
  }
  await ctx.reply(`Projects:\n\n${lines.join('\n')}`, { reply_markup: kb })
})

bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data
  const access = loadAccess()
  const senderId = String(ctx.from.id)

  const startMatch = /^start:(\d+)$/.exec(data)
  if (startMatch) {
    if (!access.allowFrom.includes(senderId)) { await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {}); return }
    const cwd = cwdByThread.get(`${String(ctx.chat!.id)}:${startMatch[1]}`)
    if (!cwd) { await ctx.answerCallbackQuery({ text: 'Unknown project.' }).catch(() => {}); return }
    if (sessionByCwd.has(cwd)) { await ctx.answerCallbackQuery({ text: 'Already online.' }).catch(() => {}); return }
    const res = launchSession(cwd)
    await ctx.answerCallbackQuery({ text: res.spawned ? 'Starting…' : 'Manual start needed' }).catch(() => {})
    const body = res.spawned
      ? `▶️ Launching a session for this project…\n\n${res.detail}`
      : `To start this session, run:\n\n${res.detail}\n\n(Set TELEGRAM_LAUNCH_CMD on the daemon to enable one-tap start.)`
    await bot.api.sendMessage(String(ctx.chat!.id), body, { message_thread_id: Number(startMatch[1]) }).catch(() => {})
    return
  }

  const sessMatch = /^sess:bind:(.+)$/.exec(data)
  if (sessMatch) {
    if (!access.allowFrom.includes(senderId)) { await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {}); return }
    const sid = sessMatch[1]
    if (!sessions.has(sid)) { await ctx.answerCallbackQuery({ text: 'Session gone.' }).catch(() => {}); return }
    chatBindings.set(String(ctx.chat!.id), sid)
    await ctx.answerCallbackQuery({ text: `Bound → ${sessions.get(sid)!.info.title}` }).catch(() => {})
    await ctx.editMessageText(`✅ This chat now routes to: ${sessions.get(sid)!.info.title}`).catch(() => {})
    return
  }

  const askMatch = /^ask:([a-f0-9]{6}):(\d+)$/.exec(data)
  if (askMatch) {
    if (!access.allowFrom.includes(senderId)) { await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {}); return }
    const [, aid, idxStr] = askMatch
    const p = pendingAsks.get(aid)
    if (!p) { await ctx.answerCallbackQuery({ text: 'This question expired.' }).catch(() => {}); return }
    const label = p.options[Number(idxStr)]
    if (label == null) { await ctx.answerCallbackQuery({ text: 'Unknown option.' }).catch(() => {}); return }
    clearTimeout(p.timer)
    pendingAsks.delete(aid)
    p.resolve(label)
    await ctx.answerCallbackQuery({ text: `✅ ${label}` }).catch(() => {})
    await ctx.editMessageText(`${p.question}\n\n✅ ${label}`).catch(() => {})
    return
  }

  const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(data)
  if (!m) { await ctx.answerCallbackQuery().catch(() => {}); return }
  if (!access.allowFrom.includes(senderId)) { await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {}); return }
  const [, behavior, request_id] = m

  if (behavior === 'more') {
    const details = pendingPermissions.get(request_id)
    if (!details) { await ctx.answerCallbackQuery({ text: 'Details no longer available.' }).catch(() => {}); return }
    const { tool_name, description, input_preview } = details
    let prettyInput: string
    try { prettyInput = JSON.stringify(JSON.parse(input_preview), null, 2) } catch { prettyInput = input_preview }
    const expanded = `🔐 Permission: ${tool_name}\n\ntool_name: ${tool_name}\ndescription: ${description}\ninput_preview:\n${prettyInput}`
    const keyboard = new InlineKeyboard().text('✅ Allow', `perm:allow:${request_id}`).text('❌ Deny', `perm:deny:${request_id}`)
    await ctx.editMessageText(expanded, { reply_markup: keyboard }).catch(() => {})
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }

  deliverPermissionReply(request_id, behavior as 'allow' | 'deny')
  const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
  await ctx.answerCallbackQuery({ text: label }).catch(() => {})
  const msg = ctx.callbackQuery.message
  if (msg && 'text' in msg && msg.text) await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(() => {})
})

bot.on('message:text', async ctx => { await handleInbound(ctx, ctx.message.text, undefined) })

bot.on('message:photo', async ctx => {
  const caption = ctx.message.caption ?? '(photo)'
  await handleInbound(ctx, caption, async () => {
    const photos = ctx.message.photo
    const best = photos[photos.length - 1]
    try {
      const file = await ctx.api.getFile(best.file_id)
      if (!file.file_path) return undefined
      const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
      const res = await fetch(url)
      const buf = Buffer.from(await res.arrayBuffer())
      const ext = file.file_path.split('.').pop() ?? 'jpg'
      const path = join(INBOX_DIR, `${Date.now()}-${best.file_unique_id}.${ext}`)
      mkdirSync(INBOX_DIR, { recursive: true })
      writeFileSync(path, buf)
      return path
    } catch (err) { log(`photo download failed: ${err}`); return undefined }
  })
})

bot.on('message:document', async ctx => {
  const doc = ctx.message.document
  const name = safeName(doc.file_name)
  await handleInbound(ctx, ctx.message.caption ?? `(document: ${name ?? 'file'})`, undefined,
    { kind: 'document', file_id: doc.file_id, size: doc.file_size, mime: doc.mime_type, name })
})

bot.on('message:voice', async ctx => {
  const voice = ctx.message.voice
  await handleInbound(ctx, ctx.message.caption ?? '(voice message)', undefined,
    { kind: 'voice', file_id: voice.file_id, size: voice.file_size, mime: voice.mime_type })
})

bot.on('message:audio', async ctx => {
  const audio = ctx.message.audio
  const name = safeName(audio.file_name)
  await handleInbound(ctx, ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? name ?? 'audio'})`, undefined,
    { kind: 'audio', file_id: audio.file_id, size: audio.file_size, mime: audio.mime_type, name })
})

bot.on('message:video', async ctx => {
  const video = ctx.message.video
  await handleInbound(ctx, ctx.message.caption ?? '(video)', undefined,
    { kind: 'video', file_id: video.file_id, size: video.file_size, mime: video.mime_type, name: safeName(video.file_name) })
})

bot.on('message:video_note', async ctx => {
  const vn = ctx.message.video_note
  await handleInbound(ctx, '(video note)', undefined, { kind: 'video_note', file_id: vn.file_id, size: vn.file_size })
})

bot.on('message:sticker', async ctx => {
  const sticker = ctx.message.sticker
  const emoji = sticker.emoji ? ` ${sticker.emoji}` : ''
  await handleInbound(ctx, `(sticker${emoji})`, undefined, { kind: 'sticker', file_id: sticker.file_id, size: sticker.file_size })
})

bot.catch(err => log(`handler error (polling continues): ${err.error}`))

// ── Socket server ──────────────────────────────────────────────────────────
function startSocketServer(): void {
  const server = createServer(sock => {
    let sessionId: string | null = null
    const send = frame<ShimMsg>(sock, msg => {
      switch (msg.t) {
        case 'hello': {
          sessionId = msg.session.id
          sessions.set(sessionId, { info: msg.session, send, sock })
          log(`session ${sessionId} connected: ${msg.session.title} (${msg.session.cwd})`)
          send({ t: 'welcome', botUsername })
          // Bind this project's topic (create or reattach) in every allowlisted DM.
          sessionByCwd.set(msg.session.cwd, sessionId)
          if (threadingActive()) {
            const access = loadAccess()
            for (const chatId of access.allowFrom) void ensureTopic(chatId, msg.session.cwd, msg.session.title)
          }
          // Replay anything queued while this project was offline.
          flushQueue(msg.session.cwd, sessions.get(sessionId)!)
          break
        }
        case 'call': {
          runTool(sessionId, msg.name, msg.args).then(
            text => send({ t: 'result', cid: msg.cid, ok: true, text }),
            err => send({ t: 'result', cid: msg.cid, ok: false, error: err instanceof Error ? err.message : String(err) }),
          )
          break
        }
        case 'permission_request': {
          if (sessionId) onPermissionRequest(sessionId, msg.request_id, msg.tool_name, msg.description, msg.input_preview)
          break
        }
        case 'activity': {
          // From the activity hook — a short-lived client with no session.
          postActivity(msg.cwd, msg.text)
          break
        }
        case 'bye': {
          if (sessionId) dropSession(sessionId)
          sock.destroy()
          break
        }
      }
    }, err => log(`bad frame from shim: ${err}`))

    sock.on('close', () => { if (sessionId) dropSession(sessionId) })
    sock.on('error', () => { if (sessionId) dropSession(sessionId) })
  })

  server.on('error', err => { log(`socket server error: ${err}`); process.exit(1) })
  server.listen(SOCK_PATH, () => {
    try { chmodSync(SOCK_PATH, 0o600) } catch {}
    log(`listening on ${SOCK_PATH}`)
  })
}

// ── Lifecycle ──────────────────────────────────────────────────────────────
let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  log('shutting down')
  try { if (parseInt(readFileSync(DAEMON_PID_FILE, 'utf8'), 10) === process.pid) rmSync(DAEMON_PID_FILE) } catch {}
  try { unlinkSync(SOCK_PATH) } catch {}
  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(bot.stop()).finally(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)
process.on('unhandledRejection', err => log(`unhandled rejection: ${err}`))
process.on('uncaughtException', err => log(`uncaught exception: ${err}`))

async function main(): Promise<void> {
  await ensureSingleInstance()
  writeFileSync(DAEMON_PID_FILE, String(process.pid))
  loadTopics()
  loadQueue()
  if (!STATIC) setInterval(checkApprovals, 5000).unref()
  startSocketServer()

  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        onStart: info => {
          attempt = 0
          botUsername = info.username
          topicsEnabled = (info as { has_topics_enabled?: boolean }).has_topics_enabled ?? false
          log(`polling as @${info.username} (topic mode: ${topicsEnabled ? 'on' : 'off'}, threading: ${threadingActive() ? 'active' : 'flat'})`)
          void bot.api.setMyCommands([
            { command: 'start', description: 'Welcome and setup guide' },
            { command: 'help', description: 'What this bot can do' },
            { command: 'status', description: 'Check your pairing status' },
            { command: 'sessions', description: 'List and pick a Claude Code session' },
            { command: 'new', description: 'List projects and start a session' },
          ], { scope: { type: 'all_private_chats' } }).catch(() => {})
        },
      })
      return
    } catch (err) {
      if (shuttingDown) return
      if (err instanceof Error && err.message === 'Aborted delay') return
      const is409 = err instanceof GrammyError && err.error_code === 409
      if (is409 && attempt >= 8) {
        log(`409 Conflict persists after ${attempt} attempts — another poller holds the token. Exiting.`)
        process.exit(1)
      }
      const delay = Math.min(1000 * attempt, 15000)
      log(`${is409 ? '409 Conflict' : `polling error: ${err}`}, retrying in ${delay / 1000}s`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
}

void main()
