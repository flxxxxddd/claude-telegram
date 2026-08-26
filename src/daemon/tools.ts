/**
 * The tools the assistant can call, executed daemon-side.
 *
 * The shim declares these to Claude Code and forwards the arguments; every Bot
 * API call happens here, so a session never holds a token or a poller.
 */

import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { media } from 'yaebal'
import { REACTION_WHITELIST } from '../store/access.ts'
import { paths } from '../paths.ts'
import { askKeyboard } from '../telegram/keyboards.ts'
import { renderText } from '../telegram/render.ts'
import type { Daemon } from './index.ts'

/** Telegram refuses an upload over 50MB from a bot. */
const MAX_UPLOAD = 50 * 1024 * 1024
const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : undefined
}

export async function runTool(
  d: Daemon,
  sessionId: string | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'reply':
      return reply(d, sessionId, args)
    case 'react':
      return react(d, args)
    case 'edit_message':
      return editMessage(d, args)
    case 'ask':
      return ask(d, sessionId, args)
    case 'download_attachment':
      return downloadAttachment(d, args)
    case 'status':
      return JSON.stringify(d.status(), null, 2)
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}

/** Where a session posts when the caller did not name a chat. */
function defaultTarget(d: Daemon, sessionId: string | undefined): { chatId?: string; threadId?: number } {
  const entry = sessionId ? d.sessions.get(sessionId) : undefined
  return { chatId: entry?.chatId, threadId: entry?.threadId }
}

async function reply(d: Daemon, sessionId: string | undefined, args: Record<string, unknown>): Promise<string> {
  const target = defaultTarget(d, sessionId)
  const chatId = str(args.chat_id) ?? target.chatId
  if (!chatId) throw new Error('no chat_id, and this session has no chat of its own yet')
  const text = str(args.text) ?? ''
  const files = Array.isArray(args.files) ? args.files.filter((f): f is string => typeof f === 'string') : []
  if (!text && !files.length) throw new Error('reply needs text, files, or both')

  const threadId = num(args.message_thread_id) ?? target.threadId
  const replyTo = num(args.reply_to)
  const sent: number[] = []

  if (text) {
    const message = await d.api.sendRichMessage({
      chat_id: chatId,
      message_thread_id: threadId,
      rich_message: renderText(text).toInputRichMessage(),
      ...(replyTo ? { reply_parameters: { message_id: replyTo } } : {}),
    })
    sent.push(message.message_id)
  }

  for (const path of files) {
    const message = await sendFile(d, chatId, threadId, path)
    if (message) sent.push(message)
  }
  return `sent ${sent.join(', ')}`
}

/** Images go as photos so they preview inline; everything else as a document. */
async function sendFile(
  d: Daemon,
  chatId: string,
  threadId: number | undefined,
  path: string,
): Promise<number | undefined> {
  const abs = resolve(path)
  if (!existsSync(abs)) throw new Error(`no such file: ${abs}`)
  const size = statSync(abs).size
  if (size > MAX_UPLOAD) throw new Error(`${basename(abs)} is ${(size / 1e6).toFixed(1)}MB; Telegram caps bot uploads at 50MB`)

  const file = media.path(abs)
  const common = { chat_id: chatId, message_thread_id: threadId }
  const message = PHOTO_EXTENSIONS.has(extname(abs).toLowerCase())
    ? await d.api.sendPhoto({ ...common, photo: file })
    : await d.api.sendDocument({ ...common, document: file })
  return message.message_id
}

async function react(d: Daemon, args: Record<string, unknown>): Promise<string> {
  const chatId = str(args.chat_id)
  const messageId = num(args.message_id)
  const emoji = str(args.emoji)
  if (!chatId || !messageId || !emoji) throw new Error('react needs chat_id, message_id and emoji')
  if (!(REACTION_WHITELIST as readonly string[]).includes(emoji)) {
    throw new Error(`Telegram only accepts reactions from its fixed list; ${emoji} is not on it`)
  }
  await d.api.setMessageReaction({
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: 'emoji', emoji: emoji as never }],
  })
  return 'reacted'
}

async function editMessage(d: Daemon, args: Record<string, unknown>): Promise<string> {
  const chatId = str(args.chat_id)
  const messageId = num(args.message_id)
  const text = str(args.text)
  if (!chatId || !messageId || !text) throw new Error('edit_message needs chat_id, message_id and text')
  await d.api.editMessageText({
    chat_id: chatId,
    message_id: messageId,
    rich_message: renderText(text).toInputRichMessage(),
  })
  return 'edited'
}

/**
 * Ask the user a multiple-choice question as buttons and block until one is
 * tapped. Claude Code's own `AskUserQuestion` only ever reaches the terminal,
 * so a session driven from Telegram would otherwise stall on a prompt nobody
 * can see.
 */
async function ask(d: Daemon, sessionId: string | undefined, args: Record<string, unknown>): Promise<string> {
  const question = str(args.question)
  const options = Array.isArray(args.options)
    ? args.options.filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
    : []
  if (!question) throw new Error('ask needs a question')
  if (options.length < 2) throw new Error('ask needs at least two options')
  if (!sessionId) throw new Error('ask can only be called from a registered session')

  const target = defaultTarget(d, sessionId)
  const chatId = str(args.chat_id) ?? target.chatId
  if (!chatId) throw new Error('no chat to ask in')

  const id = crypto.randomUUID().slice(0, 8)
  const message = await d.api.sendRichMessage({
    chat_id: chatId,
    message_thread_id: target.threadId,
    rich_message: renderText(question).toInputRichMessage(),
    reply_markup: askKeyboard(id, options),
  })

  return new Promise<string>(resolve => {
    d.pending.addAsk(
      { id, sessionId, options, chatId, messageId: message.message_id, resolve },
      pendingAsk => {
        // Nobody tapped. Returning a plain answer beats leaving the session
        // blocked on a promise that will never settle.
        void d.api.editMessageReplyMarkup({ chat_id: pendingAsk.chatId, message_id: pendingAsk.messageId ?? 0 })
          .catch(() => undefined)
        pendingAsk.resolve('')
      },
    )
  }).then(choice => (choice ? choice : 'nobody answered within the timeout; ask in the terminal instead'))
}

/** Fetch a Telegram file into the local inbox so the assistant can read it. */
async function downloadAttachment(d: Daemon, args: Record<string, unknown>): Promise<string> {
  const fileId = str(args.file_id)
  if (!fileId) throw new Error('download_attachment needs file_id')
  const file = await d.api.getFile({ file_id: fileId })
  if (!file.file_path) throw new Error('Telegram returned no path for that file')

  mkdirSync(paths.inbox, { recursive: true })
  const target = `${paths.inbox}/${Date.now()}-${basename(file.file_path)}`
  const url = `https://api.telegram.org/file/bot${d.tokenForDownloads()}/${file.file_path}`
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`download failed: ${response.status}`)
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(target))
  return target
}
