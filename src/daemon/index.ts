/**
 * The daemon — one process per bot token, and the only thing that talks to
 * Telegram.
 *
 * Telegram allows exactly one `getUpdates` consumer per token. The upstream
 * plugin spawned a poller per Claude Code session, so sessions fought over that
 * slot and only one ever worked. Here a single long-lived process owns the
 * poller, the access rules and every Bot API call; sessions attach to it over a
 * UNIX socket and hold no Telegram state at all.
 */

import type { Server, Socket } from 'node:net'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createBot, type Api, type Bot } from 'yaebal'
import { autoRetry, autoAnswer, i18n } from 'yaebal'
import { botToken, loadConfig, type Config } from '../config.ts'
import { closeDb, db } from '../db.ts'
import { en, ru, strings, type Locale, type Strings } from '../i18n/index.ts'
import { TurnMirror, type TurnSnapshot } from '../mirror/transcript.ts'
import { paths, projectName, transcriptPath } from '../paths.ts'
import { frame, type ClientMsg, type DaemonMsg, type DaemonStatus, type SessionInfo } from '../protocol.ts'
import { loadAccess } from '../store/access.ts'
import { handles, hud as hudStore, kvStore, queue, settings, topics as topicStore } from '../store/repos.ts'
import { Hud } from '../telegram/hud.ts'
import { renderText, renderTurn } from '../telegram/render.ts'
import { TurnStream } from '../telegram/stream.ts'
import { TopicManager } from '../telegram/topics.ts'
import { TypingKeeper } from '../telegram/typing.ts'
import { VERSION } from '../version.ts'
import { installHandlers } from './bot.ts'
import { PendingStore } from './pending.ts'
import { askPermission } from './permissions.ts'
import { runTool } from './tools.ts'
import { SessionRegistry, type SessionEntry } from './sessions.ts'

export class Daemon {
  readonly conn = db()
  readonly config: Config = loadConfig()
  readonly t: Strings = strings(this.config.locale)
  readonly sessions = new SessionRegistry()
  readonly pending = new PendingStore()
  readonly startedAt = Date.now()

  bot!: Bot
  api!: Api
  topics!: TopicManager
  hud!: Hud
  typing!: TypingKeeper
  botUsername = ''
  threadMode: 'topics' | 'flat' = 'flat'

  private server: Server | undefined
  private locales = kvStore<string>(this.conn, 'locale:')
  private kv = kvStore<string>(this.conn, 'daemon:')

  /* ------------------------------------------------------------ lifecycle -- */

  /**
   * Bring the bridge up. Anything that fails here leaves nothing behind — a pid
   * file from a daemon that never started would misreport a live one.
   */
  async start(): Promise<void> {
    try {
      await this.boot()
    } catch (err) {
      await this.shutdown()
      throw err
    }
  }

  private async boot(): Promise<void> {
    const token = botToken()
    if (!token) {
      throw new Error(
        `no bot token. Run \`cctg setup\`, or write TELEGRAM_BOT_TOKEN to ${paths.env}`,
      )
    }
    await this.claimSingleInstance()

    this.bot = createBot(token)
      .install(autoRetry())
      .install(autoAnswer())
      .install(i18n({
        defaultLocale: this.config.locale,
        locales: { en, ru },
        storage: this.locales,
      })) as unknown as Bot
    this.api = this.bot.api

    this.topics = new TopicManager(this.api, this.conn, this.config)
    this.hud = new Hud(this.api, this.conn, this.topics, this.t, msg => this.log(msg))
    this.typing = new TypingKeeper(this.api)

    let me: Awaited<ReturnType<Api['getMe']>>
    try {
      me = await this.api.getMe()
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(
        /401/.test(detail)
          ? `Telegram rejected the token. Check it with @BotFather, then \`cctg setup\` to replace it.`
          : `could not reach Telegram: ${detail}`,
      )
    }
    this.botUsername = me.username ?? ''
    this.threadMode = await this.topics.detect()
    this.log(`bot @${this.botUsername}, threading: ${this.threadMode}`)

    installHandlers(this.bot, this)
    this.startSocket()
    await this.bot.start()
    this.log(`daemon ${VERSION} listening on ${paths.sock}`)
  }

  /**
   * Refuse to start beside a live daemon: two pollers on one token means
   * Telegram hands each update to whichever asked first, and half the messages
   * vanish. A pid file alone is not proof — it survives a crash — so liveness
   * is checked by signalling the process.
   */
  private async claimSingleInstance(): Promise<void> {
    mkdirSync(paths.state, { recursive: true })
    if (existsSync(paths.pid)) {
      const pid = Number(readFileSync(paths.pid, 'utf8').trim())
      if (pid && pid !== process.pid && isAlive(pid)) {
        throw new Error(`a daemon is already running (pid ${pid}). Stop it with \`cctg daemon stop\`.`)
      }
    }
    // A socket left by a crashed daemon blocks bind; removing one that is still
    // accepting connections would be wrong, but the pid check above ruled that
    // out already.
    if (existsSync(paths.sock)) {
      try {
        unlinkSync(paths.sock)
      } catch {
        // Left in place; the bind below will report the real problem.
      }
    }
    writeFileSync(paths.pid, String(process.pid))
  }

  private startSocket(): void {
    this.server = createServer(sock => this.onClient(sock))
    this.server.listen(paths.sock)
    this.server.on('error', err => this.log(`socket error: ${String(err)}`))
  }

  async shutdown(): Promise<void> {
    this.hud?.stop()
    this.typing?.stopAll()
    for (const entry of this.sessions.all()) entry.mirror?.stop()
    this.server?.close()
    try {
      await this.bot?.stop()
    } catch {
      // Already stopped, or never started.
    }
    for (const file of [paths.pid, paths.sock]) {
      try {
        unlinkSync(file)
      } catch {
        // Nothing to clean up.
      }
    }
    closeDb()
  }

  log(message: string): void {
    const line = `[${new Date().toISOString()}] ${message}\n`
    try {
      mkdirSync(paths.state, { recursive: true })
      writeFileSync(paths.log, line, { flag: 'a' })
    } catch {
      // Logging must never take the daemon down.
    }
  }

  /* --------------------------------------------------------------- socket -- */

  private onClient(sock: Socket): void {
    let sessionId: string | undefined
    const send = frame<ClientMsg>(sock, msg => {
      try {
        sessionId = this.onFrame(msg, send, sessionId) ?? sessionId
      } catch (err) {
        this.log(`frame error: ${String(err)}`)
      }
    })
    sock.on('close', () => {
      if (sessionId) this.dropSession(sessionId)
    })
    sock.on('error', () => sock.destroy())
  }

  /** Handle one frame; returns a session id when the frame registered one. */
  private onFrame(
    msg: ClientMsg,
    send: (m: DaemonMsg) => void,
    sessionId: string | undefined,
  ): string | undefined {
    switch (msg.t) {
      case 'hello':
        if (msg.kind === 'session') {
          void this.registerSession(msg.session, send)
          return msg.session.id
        }
        send({ t: 'welcome', botUsername: this.botUsername, version: VERSION, topicsEnabled: this.topics.enabled })
        return undefined

      case 'call':
        void this.runTool(sessionId, msg.name, msg.args)
          .then(text => send({ t: 'result', cid: msg.cid, ok: true, text }))
          .catch((err: unknown) => send({
            t: 'result',
            cid: msg.cid,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }))
        return undefined

      case 'permission_request':
        if (sessionId) void this.onPermissionRequest(sessionId, msg)
        return undefined

      case 'retitle':
        if (sessionId) void this.onTitle(sessionId, msg.title)
        return undefined

      case 'hook':
        this.onHook(msg)
        return undefined

      case 'status':
        send({ t: 'status', status: this.status() })
        return undefined

      case 'stop':
        void this.shutdown().then(() => process.exit(0))
        return undefined

      case 'bye':
        if (sessionId) this.dropSession(sessionId)
        return undefined
    }
  }

  status(): DaemonStatus {
    return {
      pid: process.pid,
      version: VERSION,
      startedAt: this.startedAt,
      botUsername: this.botUsername,
      topicsEnabled: this.topics.enabled,
      threadMode: this.threadMode,
      sessions: this.sessions.views(),
    }
  }

  /* ------------------------------------------------------------- sessions -- */

  /** Register a session, give it a topic, and replay anything it missed. */
  async registerSession(info: SessionInfo, send: (m: DaemonMsg) => void): Promise<void> {
    const entry = this.sessions.add(info, send)
    send({ t: 'welcome', botUsername: this.botUsername, version: VERSION, topicsEnabled: this.topics.enabled })
    this.log(`session ${info.id} (${info.cwd}) connected`)

    const chatId = this.homeChat()
    if (chatId) {
      entry.chatId = chatId
      entry.threadId = await this.topics.ensure(chatId, info.cwd, info.title)
    }

    if (this.config.mirror !== 'off') this.attachMirror(entry)
    this.drawHud(entry, 'idle')
    this.replayQueue(entry)
  }

  private dropSession(id: string): void {
    const entry = this.sessions.remove(id)
    if (!entry) return
    this.log(`session ${id} disconnected`)
    if (entry.chatId) this.typing.stop(entry.chatId, entry.threadId)
    entry.state = 'offline'
    this.drawHud(entry, 'offline')

    // Anything still waiting on this session will never be answered.
    const { asks, permissions } = this.pending.dropSession(id)
    for (const ask of asks) ask.resolve('')
    for (const p of permissions) {
      void this.api.sendMessage({
        chat_id: p.chatId,
        text: this.t.t(this.localeFor(p.chatId), 'permission.expired'),
      }).catch(() => undefined)
    }
  }

  /* --------------------------------------------------------------- mirror -- */

  private attachMirror(entry: SessionEntry): void {
    const path = transcriptPath(entry.info.cwd, entry.info.id)
    const mirror = new TurnMirror(entry.info.id, entry.info.cwd, path, {
      onUpdate: snap => {
        entry.model = snap.model ?? entry.model
        entry.effort = snap.effort ?? entry.effort
        entry.contextTokens = snap.contextTokens || entry.contextTokens
        entry.branch = snap.branch ?? entry.branch
        entry.lastPrompt = snap.prompt ?? entry.lastPrompt
        if (this.config.mirror === 'full' && this.config.streaming) entry.stream?.update(snap)
        this.drawHud(entry, 'working')
      },
      onTitle: title => void this.onTitle(entry.info.id, title),
    })
    mirror.start()
    entry.mirror = mirror
  }

  /** A hook frame: the session told us where it is in its turn. */
  private onHook(msg: Extract<ClientMsg, { t: 'hook' }>): void {
    const entry = this.resolveHookSession(msg)
    if (!entry) return

    switch (msg.event) {
      case 'UserPromptSubmit':
        void this.beginTurn(entry)
        break
      case 'PostToolUse':
        entry.mirror?.poke()
        break
      case 'Notification':
        this.drawHud(entry, 'waiting')
        break
      case 'Stop':
        void this.endTurn(entry)
        break
      case 'SessionEnd':
        this.dropSession(entry.info.id)
        break
    }
  }

  /**
   * Find the session a hook belongs to, correcting its registered id if the
   * shim guessed. The hook payload is authoritative: it comes from Claude Code
   * itself and names the transcript the mirror has to follow.
   */
  private resolveHookSession(msg: Extract<ClientMsg, { t: 'hook' }>): SessionEntry | undefined {
    const known = this.sessions.get(msg.session_id)
    if (known) return known

    // Newest connection first: if two sessions share a directory, the one that
    // just attached is the one whose first hook this is.
    const candidate = this.sessions.forProject(msg.cwd)[0]
    if (!candidate) return undefined
    const rebound = this.sessions.rebind(candidate.info.id, msg.session_id)
    if (rebound && this.config.mirror !== 'off') this.attachMirror(rebound)
    return rebound
  }

  private async beginTurn(entry: SessionEntry): Promise<void> {
    entry.state = 'working'
    if (entry.chatId) this.typing.start(entry.chatId, entry.threadId)
    this.drawHud(entry, 'working')
    if (this.config.mirror !== 'full' || !this.config.streaming || !entry.chatId) return

    entry.stream?.cancel()
    const stream = new TurnStream(
      this.api,
      { chatId: entry.chatId, threadId: entry.threadId, isPrivate: isPrivateChat(entry.chatId) },
      this.t,
      this.localeFor(entry.chatId),
    )
    entry.stream = stream
    await stream.begin()
  }

  private async endTurn(entry: SessionEntry): Promise<void> {
    const snap = entry.mirror?.finish()
    if (entry.chatId) this.typing.stop(entry.chatId, entry.threadId)
    entry.state = 'done'

    if (snap && entry.stream) {
      // An interrupted turn leaves nothing to persist; committing the draft
      // would put a bare "turn complete" in the topic.
      if (hasContent(snap)) await entry.stream.finish(snap)
      else entry.stream.cancel()
    } else if (snap && entry.chatId && this.config.mirror === 'full' && hasContent(snap)) {
      // Streaming is off, so the whole turn — prose and tool trail — lands as
      // one message at the end.
      await this.sendTurn(entry.chatId, entry.threadId, snap)
    }
    entry.stream = undefined
    this.drawHud(entry, 'done')
  }

  /** Post a finished turn as one rich message. */
  private async sendTurn(chatId: string, threadId: number | undefined, snap: TurnSnapshot): Promise<void> {
    const doc = renderTurn({ ...snap, complete: true }, { t: this.t, locale: this.localeFor(chatId) })
    try {
      await this.api.sendRichMessage({
        chat_id: chatId,
        message_thread_id: threadId,
        rich_message: doc.toInputRichMessage(),
      })
    } catch (err) {
      this.topics.noteSendFailure(chatId, threadId, err)
    }
  }

  private async onTitle(sessionId: string, title: string): Promise<void> {
    const entry = this.sessions.get(sessionId)
    if (!entry || entry.info.title === title) return
    entry.info.title = title
    if (entry.chatId) await this.topics.rename(entry.chatId, entry.info.cwd, title)
  }

  /* ------------------------------------------------------------------ hud -- */

  drawHud(entry: SessionEntry, state: SessionEntry['state']): void {
    entry.state = state
    if (!this.config.pinnedStatus || !entry.chatId) return
    // Thread 0 is the chat itself, which is where a flat-mode session posts.
    // Without this a bot with topic mode off would have no status at all.
    this.hud.schedule(
      { chatId: entry.chatId, threadId: entry.threadId ?? 0 },
      this.localeFor(entry.chatId),
      {
        data: {
          state,
          project: projectName(entry.info.cwd),
          prompt: entry.lastPrompt,
          model: entry.model,
          effort: entry.effort,
          contextTokens: entry.contextTokens,
          branch: entry.branch,
          queued: queue.depth(this.conn, entry.info.cwd) || undefined,
        },
        handle: handles.of(this.conn, entry.info.cwd),
        canInterrupt: entry.info.launched,
      },
    )
  }

  /* ---------------------------------------------------------------- queue -- */

  private replayQueue(entry: SessionEntry): void {
    const held = queue.drain(this.conn, entry.info.cwd)
    if (!held.length) return
    for (const params of held) entry.send({ t: 'inbound', params })
    if (entry.chatId) {
      void this.sendRich(
        entry.chatId,
        entry.threadId,
        this.t.t(this.localeFor(entry.chatId), 'project.replayed', { n: held.length }),
      )
    }
  }

  /* -------------------------------------------------------------- helpers -- */

  /**
   * The chat a session posts into: the one that most recently talked to the
   * bot, falling back to the allowlist.
   *
   * Reading the allowlist alone was wrong in two ways. Under the `open` policy
   * it is empty, so a session never got a chat at all; and with two people
   * paired, every session posted to whoever happened to be listed first. The
   * chat someone is actually using is the one they want a session in.
   */
  homeChat(): string | undefined {
    const recent = this.kv.get('home-chat')
    if (recent) return recent
    const access = loadAccess()
    return access.allowedUsers[0] ?? access.allowedChats[0]
  }

  /**
   * Remember a chat that passed the access gate, and give any session still
   * without one a topic in it — otherwise the first session of the day stays
   * invisible until it is restarted.
   */
  async adoptChat(chatId: string): Promise<void> {
    if (this.kv.get('home-chat') === chatId) return
    this.kv.set('home-chat', chatId)
    for (const entry of this.sessions.all()) {
      if (entry.chatId) continue
      entry.chatId = chatId
      entry.threadId = await this.topics.ensure(chatId, entry.info.cwd, entry.info.title)
      this.drawHud(entry, entry.state)
    }
  }

  /**
   * The raw token, needed only to build a file-download URL — Telegram serves
   * `api.telegram.org/file/bot<token>/<path>` and there is no method wrapper.
   */
  tokenForDownloads(): string {
    const token = botToken()
    if (!token) throw new Error('no bot token available')
    return token
  }

  /** The language a chat has chosen, or the configured default. */
  localeFor(chatId: string): Locale {
    const stored = this.locales.get(chatId)
    return stored === 'ru' || stored === 'en' ? stored : this.config.locale
  }

  setLocale(chatId: string, locale: Locale): void {
    this.locales.set(chatId, locale)
  }

  /** Send plain prose as a rich paragraph, tolerating a vanished topic. */
  async sendRich(chatId: string, threadId: number | undefined, text: string | null): Promise<void> {
    if (!text?.trim()) return
    try {
      await this.api.sendRichMessage({
        chat_id: chatId,
        message_thread_id: threadId,
        rich_message: renderText(text).toInputRichMessage(),
      })
    } catch (err) {
      if (this.topics.noteSendFailure(chatId, threadId, err)) {
        hudStore.clear(this.conn, chatId, threadId ?? 0)
        return
      }
      // Rich messages can be refused by a chat that has them disabled; plain
      // text is always accepted, and a delivered message beats a pretty one.
      await this.api.sendMessage({ chat_id: chatId, message_thread_id: threadId, text })
        .catch(() => undefined)
    }
  }

  /** The project a topic belongs to, or the one a chat is bound to. */
  projectFor(chatId: string, threadId: number | undefined): string | null {
    return this.topics.projectFor(chatId, threadId)
  }

  /** Known projects: those with a topic here, plus any the config lists. */
  knownProjects(chatId: string): { cwd: string; name: string; online: boolean }[] {
    const seen = new Map<string, string>()
    for (const t of topicStore.all(this.conn)) {
      if (t.chat_id === chatId) seen.set(t.cwd, t.name)
    }
    for (const entry of this.sessions.all()) seen.set(entry.info.cwd, projectName(entry.info.cwd))
    for (const cwd of this.config.projects) seen.set(cwd, projectName(cwd))
    return [...seen].map(([cwd, name]) => ({
      cwd,
      name,
      online: this.sessions.forProject(cwd).length > 0,
    }))
  }

  /** Per-project settings, used when launching and shown in the panel. */
  settingsFor(cwd: string) {
    return settings.get(this.conn, cwd)
  }

  /* ------------------------------------------------------- tools + prompts -- */

  private runTool(
    sessionId: string | undefined,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    return runTool(this, sessionId, name, args)
  }

  private onPermissionRequest(
    sessionId: string,
    msg: Extract<ClientMsg, { t: 'permission_request' }>,
  ): Promise<void> {
    return askPermission(this, sessionId, msg)
  }
}

/**
 * Did the turn produce anything worth posting? A turn that ended with no prose
 * and no tool calls — an interrupt, or a prompt the model declined — would
 * otherwise post a bare "turn complete" into the topic.
 */
function hasContent(snap: TurnSnapshot): boolean {
  return snap.prose.length > 0 || snap.tools.length > 0
}

/** Does a pid still exist? Signal 0 checks without delivering anything. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A private chat's id is the user's id, so it is always positive. */
export function isPrivateChat(chatId: string): boolean {
  return !chatId.startsWith('-')
}
