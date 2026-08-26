/**
 * Streaming a turn into Telegram as it happens.
 *
 * Telegram's own mechanism for this is `sendRichMessageDraft`: an ephemeral
 * preview that animates between pushes and expires 30 seconds after the last
 * one. It never becomes a message on its own, so the stream must end in a real
 * `sendRichMessage` — `RichMessageDraft` enforces exactly that, and keeps the
 * draft alive between slow pushes.
 *
 * Drafts are private-chat only. In a group the same turn is streamed the older
 * way: post once, then edit in place. Both paths end with one persisted message
 * carrying the whole turn, so the reader cannot tell which was used except by
 * the animation.
 */

import { RichMessageDraft, type RichDocument } from '@yaebal/rich'
import type { Api, Message } from 'yaebal'
import type { Locale, Strings } from '../i18n/index.ts'
import type { TurnSnapshot } from '../mirror/transcript.ts'
import { renderThinking, renderTurn } from './render.ts'

/** Telegram tolerates roughly one edit per second per message. */
const PUSH_INTERVAL_MS = 1100

/** `draft_id` must be non-zero and differ between concurrent streams. */
let nextDraftId = 1

export type StreamTarget = {
  chatId: string
  threadId?: number
  /** Drafts only exist in private chats; anything else edits a real message. */
  isPrivate: boolean
}

export class TurnStream {
  private draft: RichMessageDraft | undefined
  private message: Message | undefined
  private lastPush = 0
  private queued: RichDocument | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private lastContent = ''

  constructor(
    private api: Api,
    private target: StreamTarget,
    private t: Strings,
    private locale: Locale,
  ) {}

  /** Show that the turn has started, before there is anything to say. */
  async begin(): Promise<void> {
    if (this.closed) return
    const doc = renderThinking({ t: this.t, locale: this.locale })
    if (this.target.isPrivate) {
      this.draft = new RichMessageDraft(this.api, Number(this.target.chatId), nextDraftId++, {
        messageThreadId: this.target.threadId,
        onError: () => undefined,
      })
      await this.draft.rewrite(doc).catch(() => this.fallback())
    } else {
      await this.post(doc)
    }
  }

  /** Redraw with the turn as it now stands. Coalesced to the push interval. */
  update(snap: TurnSnapshot): void {
    if (this.closed) return
    const doc = renderTurn(snap, { t: this.t, locale: this.locale })
    if (doc.content === this.lastContent) return
    this.queued = doc
    if (this.timer) return
    const wait = Math.max(0, PUSH_INTERVAL_MS - (Date.now() - this.lastPush))
    this.timer = setTimeout(() => {
      this.timer = undefined
      const next = this.queued
      this.queued = undefined
      if (next) void this.push(next)
    }, wait)
    this.timer.unref?.()
  }

  /**
   * Persist the finished turn. This is the only call that leaves a message in
   * the chat — everything before it was a preview.
   */
  async finish(snap: TurnSnapshot): Promise<Message | undefined> {
    if (this.closed) return undefined
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const doc = renderTurn({ ...snap, complete: true }, { t: this.t, locale: this.locale })

    if (this.draft) {
      try {
        return await this.draft.send(doc, this.extra())
      } catch {
        // The draft expired or the chat rejected it; the turn still has to land.
        this.draft = undefined
      }
    }
    if (this.message) {
      const edited = await this.edit(doc)
      if (edited) return this.message
    }
    return this.post(doc)
  }

  /** Abandon the stream without persisting anything. */
  cancel(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.draft?.cancel()
    this.draft = undefined
  }

  private extra(): Record<string, unknown> {
    return this.target.threadId ? { message_thread_id: this.target.threadId } : {}
  }

  private async push(doc: RichDocument): Promise<void> {
    this.lastPush = Date.now()
    this.lastContent = doc.content
    if (this.draft && !this.draft.closed) {
      await this.draft.rewrite(doc).catch(() => this.fallback())
      return
    }
    if (this.message) {
      await this.edit(doc)
      return
    }
    await this.post(doc)
  }

  /** A draft that stopped working leaves the stream on the edit path. */
  private fallback(): void {
    this.draft?.cancel()
    this.draft = undefined
  }

  private async post(doc: RichDocument): Promise<Message | undefined> {
    try {
      this.message = await this.api.sendRichMessage({
        chat_id: this.target.chatId,
        message_thread_id: this.target.threadId,
        rich_message: doc.toInputRichMessage(),
      })
      this.lastContent = doc.content
      return this.message
    } catch {
      return undefined
    }
  }

  private async edit(doc: RichDocument): Promise<boolean> {
    if (!this.message) return false
    try {
      await this.api.editMessageText({
        chat_id: this.target.chatId,
        message_id: this.message.message_id,
        rich_message: doc.toInputRichMessage(),
      })
      this.lastContent = doc.content
      return true
    } catch {
      return false
    }
  }
}
