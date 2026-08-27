/**
 * Permission requests, answered from Telegram.
 *
 * When Claude Code needs approval for a tool it raises a channel permission
 * request. The daemon renders it as a message with allow/deny buttons and
 * routes the answer back to the exact session that asked — never to whichever
 * session happens to be most recent, which would approve a command in the wrong
 * project.
 */

import { permissionKeyboard } from '../telegram/keyboards.ts'
import { renderPermission } from '../telegram/render.ts'
import type { ClientMsg } from '../protocol.ts'
import type { Daemon } from './index.ts'

export async function askPermission(
  d: Daemon,
  sessionId: string,
  msg: Extract<ClientMsg, { t: 'permission_request' }>,
): Promise<void> {
  const entry = d.sessions.get(sessionId)
  const chatId = entry?.chatId ?? d.homeChat()
  if (!chatId) {
    // Nobody to ask. Say nothing and let Claude Code fall back to the terminal,
    // which is still sitting there waiting.
    d.log(`permission ${msg.request_id} raised with no chat to ask in`)
    return
  }

  const locale = d.localeFor(chatId)
  if (entry) d.drawHud(entry, 'waiting')

  // A ticket of our own: Claude Code's request id has no documented bound, and
  // a long one would overflow the 64-byte button payload — leaving a request
  // nobody can answer.
  const ticket = crypto.randomUUID().slice(0, 8)
  const doc = renderPermission(msg.tool_name, msg.input_preview, { t: d.t, locale })
  try {
    const sent = await d.api.sendRichMessage({
      chat_id: chatId,
      message_thread_id: entry?.threadId,
      rich_message: doc.toInputRichMessage(),
      reply_markup: permissionKeyboard(ticket, d.t, locale),
    })
    d.pending.addPermission(
      { id: ticket, requestId: msg.request_id, sessionId, tool: msg.tool_name, chatId, messageId: sent.message_id },
      expired => {
        void d.api.editMessageReplyMarkup({ chat_id: expired.chatId, message_id: expired.messageId ?? 0 })
          .catch(() => undefined)
      },
    )
  } catch (err) {
    d.log(`permission ${msg.request_id} could not be shown: ${String(err)}`)
  }
}

/**
 * Deliver a tapped answer back to the session that raised the request, and
 * report the tool it was about so the toast can name it. A request that is no
 * longer pending — it timed out, or the session ended — reports nothing.
 */
export function answerPermission(
  d: Daemon,
  ticket: string,
  behavior: 'allow' | 'deny',
): { tool: string } | null {
  const pending = d.pending.takePermission(ticket)
  if (!pending) return null
  const entry = d.sessions.get(pending.sessionId)
  if (!entry) return null
  entry.send({ t: 'permission_reply', request_id: pending.requestId, behavior })
  d.drawHud(entry, 'working')
  return { tool: pending.tool }
}
