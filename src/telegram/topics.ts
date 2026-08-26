/**
 * A forum topic per project.
 *
 * `createForumTopic` works "in a forum supergroup chat **or a private chat with
 * a user**" (Bot API), so every project gets its own thread right inside the
 * owner's DM — no group to create, no invite to accept. The bot only gets that
 * ability once Topic Mode is switched on in BotFather, which `getMe` reports as
 * `has_topics_enabled`, so the mode is detected rather than assumed.
 *
 * Without topics the bridge still works: one chat binds to one session at a
 * time and `/sessions` switches it.
 */

import type { Database } from 'bun:sqlite'
import type { Api } from 'yaebal'
import type { Config } from '../config.ts'
import { projectName } from '../paths.ts'
import { topics } from '../store/repos.ts'

/** A topic name Telegram will accept: 1–128 characters, no newlines. */
export function topicName(cwd: string, title?: string): string {
  const name = title?.trim() || projectName(cwd)
  return name.replace(/\s+/g, ' ').slice(0, 128) || 'claude'
}

/** Telegram's fixed palette for topic icons; one colour per project, stably. */
const ICON_COLORS = [0x6fb9f0, 0xffd67e, 0xcb86db, 0x8eee98, 0xff93b2, 0xfb6f5f] as const

export function iconColorFor(cwd: string): number {
  let hash = 0
  for (const ch of cwd) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return ICON_COLORS[hash % ICON_COLORS.length] as number
}

/**
 * A topic id Telegram has since forgotten — the user deleted the thread. The
 * daemon drops its record so the next message opens a fresh one instead of
 * failing on a dead id forever.
 */
function isMissingTopic(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /TOPIC_(DELETED|ID_INVALID)|message thread not found|TOPIC_CLOSED/i.test(msg)
}

export class TopicManager {
  /** Whether the bot may open topics at all; set once at boot. */
  enabled = false

  constructor(
    private api: Api,
    private conn: Database,
    private config: Config,
  ) {}

  /**
   * Decide the threading mode. `topics` and `flat` are honoured as written;
   * `auto` turns topics on exactly when the bot can actually create them, so a
   * bot without Topic Mode degrades instead of erroring on every message.
   */
  async detect(): Promise<'topics' | 'flat'> {
    if (this.config.threadMode === 'flat') {
      this.enabled = false
      return 'flat'
    }
    let supported = false
    try {
      supported = (await this.api.getMe()).has_topics_enabled === true
    } catch {
      supported = false
    }
    this.enabled = this.config.threadMode === 'topics' ? true : supported
    return this.enabled ? 'topics' : 'flat'
  }

  /** The topic a project owns in a chat, creating it on first use. */
  async ensure(chatId: string, cwd: string, title?: string): Promise<number | undefined> {
    if (!this.enabled) return undefined
    const known = topics.get(this.conn, chatId, cwd)
    if (known) return known.thread_id

    const name = topicName(cwd, title)
    try {
      const topic = await this.api.createForumTopic({
        chat_id: chatId,
        name,
        icon_color: iconColorFor(cwd),
      })
      topics.put(this.conn, { chat_id: chatId, cwd, thread_id: topic.message_thread_id, name })
      return topic.message_thread_id
    } catch {
      // A chat that cannot host topics (the user turned Topic Mode off after
      // boot, or this is a group where the bot lacks the right) falls back to
      // the flat thread rather than dropping the message.
      return undefined
    }
  }

  /** Rename a project's topic — used when Claude Code assigns a session title. */
  async rename(chatId: string, cwd: string, title: string): Promise<void> {
    const known = topics.get(this.conn, chatId, cwd)
    const name = topicName(cwd, title)
    if (!known || known.name === name) return
    try {
      await this.api.editForumTopic({ chat_id: chatId, message_thread_id: known.thread_id, name })
      topics.put(this.conn, { ...known, name })
    } catch (err) {
      if (isMissingTopic(err)) topics.forget(this.conn, chatId, known.thread_id)
    }
  }

  /** Which project a topic belongs to, for routing an inbound message. */
  projectFor(chatId: string, threadId: number | undefined): string | null {
    if (!this.enabled || threadId === undefined) return null
    return topics.byThread(this.conn, chatId, threadId)?.cwd ?? null
  }

  /** Every project that has a topic in this chat. */
  projectsIn(chatId: string): { cwd: string; threadId: number; name: string }[] {
    return topics.all(this.conn)
      .filter(t => t.chat_id === chatId)
      .map(t => ({ cwd: t.cwd, threadId: t.thread_id, name: t.name }))
  }

  /** Report a send failure so a deleted topic is not retried forever. */
  noteSendFailure(chatId: string, threadId: number | undefined, err: unknown): boolean {
    if (threadId === undefined || !isMissingTopic(err)) return false
    topics.forget(this.conn, chatId, threadId)
    return true
  }
}
