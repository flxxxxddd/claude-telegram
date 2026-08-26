/**
 * Keeping the "typing…" indicator alive.
 *
 * `sendChatAction` lasts about five seconds, so a turn that runs for minutes
 * needs it re-sent. `@yaebal/typing` does this around a handler; here the work
 * happens outside any handler — a session on another process is what takes the
 * time — so the keeper is driven by the turn's start and end instead.
 */

import type { Api } from 'yaebal'

const REFRESH_MS = 4000

export class TypingKeeper {
  private timers = new Map<string, ReturnType<typeof setInterval>>()

  constructor(private api: Api) {}

  private key(chatId: string, threadId?: number): string {
    return `${chatId}:${threadId ?? 0}`
  }

  /** Show the indicator until `stop` for this chat and thread. */
  start(chatId: string, threadId?: number): void {
    const key = this.key(chatId, threadId)
    if (this.timers.has(key)) return
    const send = () => {
      void this.api.sendChatAction({
        chat_id: chatId,
        message_thread_id: threadId,
        action: 'typing',
      }).catch(() => undefined)
    }
    send()
    const timer = setInterval(send, REFRESH_MS)
    timer.unref?.()
    this.timers.set(key, timer)
  }

  stop(chatId: string, threadId?: number): void {
    const key = this.key(chatId, threadId)
    const timer = this.timers.get(key)
    if (!timer) return
    clearInterval(timer)
    this.timers.delete(key)
  }

  stopAll(): void {
    for (const timer of this.timers.values()) clearInterval(timer)
    this.timers.clear()
  }
}
