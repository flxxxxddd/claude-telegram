/**
 * Every Telegram-side handler: commands, inbound routing and button taps.
 *
 * Handlers stay thin — they gate access, work out which session a message
 * belongs to, and hand off. The daemon owns the state; this file owns the
 * conversation.
 */

import type { Bot, Context } from 'yaebal'
import type { Locale } from '../i18n/index.ts'
import { paths } from '../paths.ts'
import { gateDm, gateGroup, loadAccess, mintPairingCode, pruneExpired, saveAccess } from '../store/access.ts'
import { bindings, handles, queue, settings } from '../store/repos.ts'
import {
  askCb,
  closeCb,
  langCb,
  permissionCb,
  projectCb,
  sessionCb,
  settingsCb,
} from '../telegram/callbacks.ts'
import {
  EFFORTS,
  MODELS,
  PERMISSION_MODES,
  isEffort,
  isModel,
  isPermissionMode,
  langKeyboard,
  projectsKeyboard,
  sessionsKeyboard,
  settingsPageKeyboard,
  settingsRootKeyboard,
  startKeyboard,
} from '../telegram/keyboards.ts'
import { renderHud, renderText } from '../telegram/render.ts'
import { launch } from './launcher.ts'
import type { Daemon } from './index.ts'
import { answerPermission } from './permissions.ts'

type Ctx = Context

const chatIdOf = (ctx: Ctx): string => String(ctx.chat?.id ?? '')
const threadIdOf = (ctx: Ctx): number | undefined => ctx.messageThreadId
const isPrivate = (ctx: Ctx): boolean => ctx.chat?.type === 'private'

export function installHandlers(bot: Bot, d: Daemon): void {
  const say = (ctx: Ctx, text: string) => d.sendRich(chatIdOf(ctx), threadIdOf(ctx), text)
  const tr = (ctx: Ctx) => d.localeFor(chatIdOf(ctx))

  /* ------------------------------------------------------------ commands -- */

  bot.command('start', async ctx => {
    const locale = tr(ctx)
    if (!(await allowed(d, ctx as Ctx))) return
    await say(ctx as Ctx, d.t.t(locale, 'start.greet'))
  })

  bot.command('help', async ctx => {
    if (!(await allowed(d, ctx as Ctx))) return
    await say(ctx as Ctx, d.t.t(tr(ctx), 'help.body'))
  })

  bot.command('status', async ctx => {
    if (!(await allowed(d, ctx as Ctx))) return
    const c = ctx
    const chatId = chatIdOf(c)
    const locale = tr(c)
    const cwd = d.projectFor(chatId, threadIdOf(c))
    const entry = cwd
      ? d.sessions.forProject(cwd)[0]
      : d.sessions.get(bindings.get(d.conn, chatId) ?? '') ?? d.sessions.mostRecent()

    if (!entry) {
      await say(c, d.t.t(locale, 'errors.noSession'))
      return
    }
    const doc = renderHud({
      state: entry.state,
      project: projectLabel(entry.info.cwd),
      prompt: entry.lastPrompt,
      model: entry.model,
      effort: entry.effort,
      contextTokens: entry.contextTokens,
      branch: entry.branch,
      queued: queue.depth(d.conn, entry.info.cwd) || undefined,
    }, { t: d.t, locale })
    await d.api.sendRichMessage({
      chat_id: chatId,
      message_thread_id: threadIdOf(c),
      rich_message: doc.toInputRichMessage(),
    })
  })

  bot.command('sessions', async ctx => {
    if (!(await allowed(d, ctx as Ctx))) return
    const c = ctx
    const chatId = chatIdOf(c)
    const locale = tr(c)
    const views = d.sessions.views()
    if (!views.length) {
      await say(c, d.t.t(locale, 'sessions.none'))
      return
    }
    await d.api.sendRichMessage({
      chat_id: chatId,
      message_thread_id: threadIdOf(c),
      rich_message: renderText(d.t.t(locale, 'sessions.pick')).toInputRichMessage(),
      reply_markup: sessionsKeyboard(views, bindings.get(d.conn, chatId), d.t, locale),
    })
  })

  bot.command('new', async ctx => {
    if (!(await allowed(d, ctx as Ctx))) return
    const c = ctx
    const chatId = chatIdOf(c)
    const locale = tr(c)
    const projects = d.knownProjects(chatId)
    if (!projects.length) {
      await say(c, d.t.t(locale, 'sessions.none'))
      return
    }
    await d.api.sendRichMessage({
      chat_id: chatId,
      message_thread_id: threadIdOf(c),
      rich_message: renderText(d.t.t(locale, 'project.pick')).toInputRichMessage(),
      reply_markup: projectsKeyboard(projects.map(p => ({
        handle: handles.of(d.conn, p.cwd),
        name: p.name,
        online: p.online,
      }))),
    })
  })

  bot.command('settings', async ctx => {
    if (!(await allowed(d, ctx as Ctx))) return
    const c = ctx
    const chatId = chatIdOf(c)
    const locale = tr(c)
    const cwd = d.projectFor(chatId, threadIdOf(c))
      ?? d.sessions.get(bindings.get(d.conn, chatId) ?? '')?.info.cwd
      ?? d.sessions.mostRecent()?.info.cwd
    if (!cwd) {
      await say(c, d.t.t(locale, 'errors.noSession'))
      return
    }
    const handle = handles.of(d.conn, cwd)
    await d.api.sendRichMessage({
      chat_id: chatId,
      message_thread_id: threadIdOf(c),
      rich_message: renderText(d.t.t(locale, 'controls.applies')).toInputRichMessage(),
      reply_markup: settingsRootKeyboard(handle, d.settingsFor(cwd), d.t, locale),
    })
  })

  bot.command('lang', async ctx => {
    if (!(await allowed(d, ctx as Ctx))) return
    const c = ctx
    const locale = tr(c)
    await d.api.sendRichMessage({
      chat_id: chatIdOf(c),
      message_thread_id: threadIdOf(c),
      rich_message: renderText(d.t.t(locale, 'lang.pick')).toInputRichMessage(),
      reply_markup: langKeyboard(locale),
    })
  })

  /* --------------------------------------------------------- button taps -- */

  bot.callbackQuery(permissionCb, async ctx => {
    const { id, allow } = ctx.queryData
    const locale = d.localeFor(String(ctx.chat?.id ?? ''))
    const answered = answerPermission(d, id, allow ? 'allow' : 'deny')
    if (!answered) {
      await ctx.answerCallbackQuery({ text: d.t.t(locale, 'permission.expired'), show_alert: true })
      return
    }
    const key = allow ? 'permission.allowed' : 'permission.denied'
    await ctx.answerCallbackQuery({ text: d.t.t(locale, key, { tool: answered.tool }) })
    // Strip the buttons so the decision cannot be tapped twice.
    await ctx.editReplyMarkup({}).catch(() => undefined)
  })

  bot.callbackQuery(askCb, async ctx => {
    const { id, choice } = ctx.queryData
    const pendingAsk = d.pending.takeAsk(id)
    if (!pendingAsk) {
      await ctx.answerCallbackQuery({ text: d.t.t(d.localeFor(String(ctx.chat?.id ?? '')), 'permission.expired') })
      return
    }
    const answer = pendingAsk.options[choice] ?? ''
    pendingAsk.resolve(answer)
    await ctx.answerCallbackQuery({ text: answer })
    await ctx.editReplyMarkup({}).catch(() => undefined)
  })

  bot.callbackQuery(sessionCb, async ctx => {
    const chatId = String(ctx.chat?.id ?? '')
    const locale = d.localeFor(chatId)
    const entry = d.sessions.get(ctx.queryData.id)
    if (!entry) {
      await ctx.answerCallbackQuery({ text: d.t.t(locale, 'errors.noSession') })
      return
    }
    bindings.set(d.conn, chatId, entry.info.id)
    await ctx.answerCallbackQuery({ text: d.t.t(locale, 'sessions.bound', { title: entry.info.title }) })
  })

  bot.callbackQuery(projectCb, async ctx => {
    const chatId = String(ctx.chat?.id ?? '')
    const locale = d.localeFor(chatId)
    const cwd = handles.get(d.conn, ctx.queryData.h)
    if (!cwd) {
      await ctx.answerCallbackQuery({ text: d.t.t(locale, 'permission.expired') })
      return
    }

    if (ctx.queryData.action === 'interrupt') {
      const entry = d.sessions.forProject(cwd)[0]
      const ok = entry?.info.launched && interrupt(entry.info.pid)
      await ctx.answerCallbackQuery({
        text: ok ? d.t.t(locale, 'controls.interrupted') : d.t.t(locale, 'controls.cannotInterrupt'),
        show_alert: !ok,
      })
      return
    }

    const threadId = await d.topics.ensure(chatId, cwd)
    const online = d.sessions.forProject(cwd).length > 0
    if (online || ctx.queryData.action === 'open') {
      await ctx.answerCallbackQuery({})
      if (!online) await offlineNotice(d, chatId, threadId, cwd, locale)
      return
    }

    const result = launch(cwd, d.config, d.settingsFor(cwd))
    await ctx.answerCallbackQuery({})
    await d.sendRich(
      chatId,
      threadId,
      result.spawned
        ? d.t.t(locale, 'project.starting', { name: projectLabel(cwd) })
        : d.t.t(locale, 'project.launchHint', { cmd: result.command }),
    )
  })

  bot.callbackQuery(settingsCb, async ctx => {
    const chatId = String(ctx.chat?.id ?? '')
    const locale = d.localeFor(chatId)
    const { h, page, value } = ctx.queryData
    const cwd = handles.get(d.conn, h)
    if (!cwd) {
      await ctx.answerCallbackQuery({ text: d.t.t(locale, 'permission.expired') })
      return
    }

    if (value !== undefined && page !== 'root') {
      const saved = applySetting(d, cwd, page, value)
      await ctx.answerCallbackQuery({ text: d.t.t(locale, 'controls.saved', { what: saved }) })
      await ctx.editReplyMarkup({ reply_markup: settingsRootKeyboard(h, d.settingsFor(cwd), d.t, locale) })
        .catch(() => undefined)
      return
    }

    const current = d.settingsFor(cwd)
    const markup = page === 'root'
      ? settingsRootKeyboard(h, current, d.t, locale)
      : settingsPageKeyboard(
        h,
        page,
        page === 'model' ? MODELS : page === 'effort' ? EFFORTS : PERMISSION_MODES,
        page === 'model' ? current.model : page === 'effort' ? current.effort : current.permission_mode,
        d.t,
        locale,
      )
    await ctx.answerCallbackQuery({})
    await ctx.editReplyMarkup({ reply_markup: markup }).catch(() => undefined)
  })

  bot.callbackQuery(langCb, async ctx => {
    const chatId = String(ctx.chat?.id ?? '')
    d.setLocale(chatId, ctx.queryData.locale as Locale)
    await ctx.answerCallbackQuery({ text: d.t.t(ctx.queryData.locale as Locale, 'lang.changed') })
    await ctx.editReplyMarkup({ reply_markup: langKeyboard(ctx.queryData.locale as Locale) })
      .catch(() => undefined)
  })

  bot.callbackQuery(closeCb, async ctx => {
    await ctx.answerCallbackQuery({})
    await ctx.delete().catch(() => undefined)
  })

  /* ---------------------------------------------------------- inbound msg -- */

  bot.on('message:text', async ctx => {
    const c = ctx
    if (ctx.message?.text?.startsWith('/')) return
    await routeInbound(d, ctx, ctx.message?.text ?? '')
  })

  bot.on('message:photo', async ctx => {
    await routeInbound(d, ctx, ctx.message?.caption ?? '')
  })

  bot.on('message:document', async ctx => {
    await routeInbound(d, ctx, ctx.message?.caption ?? '')
  })
}

/* ---------------------------------------------------------------- helpers -- */

const projectLabel = (cwd: string): string => cwd.split('/').filter(Boolean).pop() ?? cwd

/**
 * Whether this message may be acted on at all. An unknown DM under the
 * `pairing` policy gets a code; under `allowlist` it gets silence, so a stranger
 * cannot even tell a bot is listening.
 */
async function allowed(d: Daemon, ctx: Ctx): Promise<boolean> {
  const chatId = chatIdOf(ctx)
  const userId = String(ctx.from?.id ?? '')
  const access = loadAccess()
  if (pruneExpired(access)) saveAccess(access)

  if (!isPrivate(ctx)) {
    const mentioned = mentionsBot(ctx, d.botUsername)
    return gateGroup(access, chatId, mentioned).ok
  }

  const gate = gateDm(access, userId)
  if (gate.ok) return true
  if (gate.reason === 'unknown-user') {
    const code = mintPairingCode(access, userId, chatId)
    saveAccess(access)
    d.log(`pairing code ${code} minted for user ${userId}`)
    await d.sendRich(chatId, undefined, d.t.t(d.config.locale, 'start.pairing', { code }))
  }
  return false
}

/** Groups only get an answer when the bot is spoken to. */
function mentionsBot(ctx: Ctx, username: string): boolean {
  const text = ctx.message?.text ?? ctx.message?.caption ?? ''
  if (username && text.includes(`@${username}`)) return true
  return ctx.message?.reply_to_message?.from?.is_bot === true
}

/** Deliver a message to the session that owns this thread, or hold it. */
async function routeInbound(d: Daemon, ctx: Ctx, text: string): Promise<void> {
  if (!(await allowed(d, ctx))) return
  const chatId = chatIdOf(ctx)
  const threadId = threadIdOf(ctx)
  const locale = d.localeFor(chatId)
  const params = inboundParams(ctx, text)

  const cwd = d.projectFor(chatId, threadId)
  const entry = cwd
    ? d.sessions.forProject(cwd)[0]
    : d.sessions.get(bindings.get(d.conn, chatId) ?? '') ?? d.sessions.mostRecent()

  if (!entry) {
    if (cwd) {
      queue.push(d.conn, cwd, params)
      await offlineNotice(d, chatId, threadId, cwd, locale)
    } else {
      await d.sendRich(chatId, threadId, d.t.t(locale, 'errors.noSession'))
    }
    return
  }

  // A chat with no topic and no binding adopts whichever session answered it,
  // so the next message does not silently move to a different project.
  if (!cwd) bindings.set(d.conn, chatId, entry.info.id)

  const access = loadAccess()
  const messageId = ctx.message?.message_id
  if (access.ackReaction && messageId !== undefined) {
    void d.api.setMessageReaction({
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji: access.ackReaction as never }],
    }).catch(() => undefined)
  }
  d.typing.start(chatId, threadId)
  entry.send({ t: 'inbound', params })
}

/** Tell the user their message is held, and offer to start the session. */
async function offlineNotice(
  d: Daemon,
  chatId: string,
  threadId: number | undefined,
  cwd: string,
  locale: Locale,
): Promise<void> {
  const depth = queue.depth(d.conn, cwd)
  const text = [
    d.t.t(locale, 'project.offline', { name: projectLabel(cwd) }),
    depth ? d.t.t(locale, 'project.queued', { n: depth }) : '',
  ].filter(Boolean).join('\n')

  await d.api.sendRichMessage({
    chat_id: chatId,
    message_thread_id: threadId,
    rich_message: renderText(text).toInputRichMessage(),
    reply_markup: startKeyboard(handles.of(d.conn, cwd), d.t, locale),
  }).catch(() => undefined)
}

/**
 * The `<channel>` block Claude Code renders for an inbound message. The shape
 * is the channel protocol's, not ours — `content` plus a flat `meta` map.
 */
function inboundParams(ctx: Ctx, text: string): Record<string, unknown> {
  const from = ctx.from
  const message = ctx.message
  const photo = message?.photo
  const document = message?.document
  return {
    content: text,
    meta: {
      chat_id: chatIdOf(ctx),
      ...(message?.message_id !== undefined ? { message_id: String(message.message_id) } : {}),
      ...(message?.message_thread_id !== undefined ? { thread_id: String(message.message_thread_id) } : {}),
      user: from?.username ?? String(from?.id ?? ''),
      user_id: String(from?.id ?? ''),
      ts: new Date((message?.date ?? 0) * 1000).toISOString(),
      ...(photo?.length ? { attachment_kind: 'photo', attachment_file_id: photo[photo.length - 1]?.file_id } : {}),
      ...(document ? {
        attachment_kind: 'document',
        attachment_file_id: document.file_id,
        ...(document.file_name ? { attachment_name: document.file_name } : {}),
        ...(document.mime_type ? { attachment_mime: document.mime_type } : {}),
      } : {}),
      inbox: paths.inbox,
    },
  }
}

/** Store one settings choice and report what it was, for the toast. */
function applySetting(d: Daemon, cwd: string, page: 'model' | 'effort' | 'permission', value: string): string {
  if (page === 'model' && isModel(value)) settings.patch(d.conn, cwd, { model: value })
  else if (page === 'effort' && isEffort(value)) settings.patch(d.conn, cwd, { effort: value })
  else if (page === 'permission' && isPermissionMode(value)) settings.patch(d.conn, cwd, { permission_mode: value })
  return value
}

/**
 * Interrupt a running turn. Only sessions the daemon launched are interruptible
 * — signalling a terminal the user owns would look like a crash to them.
 */
function interrupt(pid: number): boolean {
  try {
    process.kill(pid, 'SIGINT')
    return true
  } catch {
    return false
  }
}
