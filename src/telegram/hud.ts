/**
 * The pinned status message.
 *
 * One per topic, edited in place as the session works, so the reader always has
 * the current model, effort, context and state at the top of the thread without
 * scrolling. `editMessageText` takes a `rich_message`, so the table redraws
 * without ever being reposted.
 *
 * Edits are coalesced: a working turn changes the status several times a
 * second, and Telegram answers that with 429s. The last state within the window
 * wins, and a state change that matters (working → done) is never lost, only
 * delayed.
 */

import type { Database } from 'bun:sqlite'
import type { Api } from 'yaebal'
import type { Locale, Strings } from '../i18n/index.ts'
import { hud as hudStore } from '../store/repos.ts'
import { hudKeyboard } from './keyboards.ts'
import { renderHud, type HudData } from './render.ts'
import type { TopicManager } from './topics.ts'

/** Telegram tolerates roughly one edit per second per message. */
const EDIT_INTERVAL_MS = 1200

type Target = { chatId: string; threadId: number }
type Pending = { data: HudData; handle: string; canInterrupt: boolean }

export class Hud {
  private pending = new Map<string, Pending>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private lastEdit = new Map<string, number>()
  private lastDrawn = new Map<string, string>()

  constructor(
    private api: Api,
    private conn: Database,
    private topics: TopicManager,
    private t: Strings,
    private log: (message: string) => void,
  ) {}

  private key(target: Target): string {
    return `${target.chatId}:${target.threadId}`
  }

  /**
   * Draw the status. Returns immediately — the write happens on the next tick
   * of the coalescing window, so a caller in a hot loop pays nothing.
   */
  schedule(target: Target, locale: Locale, pending: Pending): void {
    const key = this.key(target)
    this.pending.set(key, pending)
    if (this.timers.has(key)) return

    const since = Date.now() - (this.lastEdit.get(key) ?? 0)
    const wait = Math.max(0, EDIT_INTERVAL_MS - since)
    const timer = setTimeout(() => {
      this.timers.delete(key)
      const next = this.pending.get(key)
      this.pending.delete(key)
      if (next) void this.draw(target, locale, next)
    }, wait)
    timer.unref?.()
    this.timers.set(key, timer)
  }

  /** Write the status now, sending and pinning it if this topic has none yet. */
  async draw(target: Target, locale: Locale, { data, handle, canInterrupt }: Pending): Promise<void> {
    const key = this.key(target)
    const doc = renderHud(data, { t: this.t, locale })
    // An identical redraw is a wasted call that Telegram answers with
    // "message is not modified" — skip it rather than burn the rate budget.
    if (this.lastDrawn.get(key) === doc.content) return

    const markup = hudKeyboard(handle, canInterrupt, this.t, locale)
    const existing = hudStore.get(this.conn, target.chatId, target.threadId)
    this.lastEdit.set(key, Date.now())

    try {
      if (existing) {
        await this.api.editMessageText({
          chat_id: target.chatId,
          message_id: existing,
          rich_message: doc.toInputRichMessage(),
          reply_markup: markup,
        })
      } else {
        const sent = await this.api.sendRichMessage({
          chat_id: target.chatId,
          message_thread_id: target.threadId || undefined,
          rich_message: doc.toInputRichMessage(),
          reply_markup: markup,
          disable_notification: true,
        })
        hudStore.set(this.conn, target.chatId, target.threadId, sent.message_id)
        // Pinning is what puts the status in the thread header. It is allowed
        // to fail — an unpinned status message is still useful.
        await this.api.pinChatMessage({
          chat_id: target.chatId,
          message_id: sent.message_id,
          disable_notification: true,
        }).catch(() => undefined)
      }
      this.lastDrawn.set(key, doc.content)
    } catch (err) {
      if (this.topics.noteSendFailure(target.chatId, target.threadId, err)) {
        hudStore.clear(this.conn, target.chatId, target.threadId)
        this.lastDrawn.delete(key)
        return
      }
      // The stored message id is stale (deleted by hand, or too old to edit).
      // Drop it so the next draw posts a fresh status. This is logged because a
      // *persistent* edit failure reposts the status on every change, which
      // fills the topic with pins — silence here made that impossible to find.
      this.log(`status ${existing ? 'edit' : 'post'} failed in ${key}: ${String(err)}`)
      if (existing) {
        hudStore.clear(this.conn, target.chatId, target.threadId)
        this.lastDrawn.delete(key)
      }
    }
  }

  /** Forget a topic's status — used when the topic itself goes away. */
  forget(target: Target): void {
    const key = this.key(target)
    const timer = this.timers.get(key)
    if (timer) clearTimeout(timer)
    this.timers.delete(key)
    this.pending.delete(key)
    this.lastDrawn.delete(key)
    hudStore.clear(this.conn, target.chatId, target.threadId)
  }

  /** Cancel every pending edit — called on shutdown. */
  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.pending.clear()
  }
}
