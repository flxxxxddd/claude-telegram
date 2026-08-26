/**
 * The inline keyboards. Every button's payload comes from `callbacks.ts`, so a
 * label change can never silently break routing.
 */

import { InlineKeyboard } from 'yaebal'
import type { Locale, Strings } from '../i18n/index.ts'
import { LOCALE_NAMES, LOCALES } from '../i18n/index.ts'
import type { SessionView } from '../protocol.ts'
import { askCb, closeCb, langCb, permissionCb, projectCb, sessionCb, settingsCb } from './callbacks.ts'
import { shortModel } from './render.ts'

/**
 * Values Claude Code's CLI accepts, verbatim from `claude --help` (2.1.246).
 * They are passed through to a session the daemon launches, so a value invented
 * here would fail at spawn time rather than at pick time.
 */
export const MODELS = ['opus', 'sonnet', 'haiku', 'opusplan'] as const
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const PERMISSION_MODES = ['manual', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'] as const

export type Model = (typeof MODELS)[number]
export type Effort = (typeof EFFORTS)[number]
export type PermissionMode = (typeof PERMISSION_MODES)[number]

export const isModel = (v: string): v is Model => (MODELS as readonly string[]).includes(v)
export const isEffort = (v: string): v is Effort => (EFFORTS as readonly string[]).includes(v)
export const isPermissionMode = (v: string): v is PermissionMode =>
  (PERMISSION_MODES as readonly string[]).includes(v)

/** Allow / deny for one permission request. */
export function permissionKeyboard(id: string, t: Strings, locale: Locale): InlineKeyboard {
  return new InlineKeyboard()
    .text(`✅ ${t.t(locale, 'permission.allow')}`, permissionCb.pack({ id, allow: true })).style('success')
    .text(`⛔ ${t.t(locale, 'permission.deny')}`, permissionCb.pack({ id, allow: false })).style('danger')
}

/** One button per option of an `ask` question, one per row so labels fit. */
export function askKeyboard(id: string, options: string[]): InlineKeyboard {
  const kb = new InlineKeyboard()
  options.forEach((label, i) => {
    kb.text(label.slice(0, 64), askCb.pack({ id, choice: i })).row()
  })
  return kb
}

/** Pick which session a chat routes to. */
export function sessionsKeyboard(sessions: SessionView[], current: string | null, t: Strings, locale: Locale): InlineKeyboard {
  const kb = new InlineKeyboard()
  for (const s of sessions) {
    const mark = s.id === current ? `● ` : ''
    const suffix = s.id === current ? ` · ${t.t(locale, 'sessions.current')}` : ''
    kb.text(`${mark}${s.title}${suffix}`.slice(0, 64), sessionCb.pack({ id: s.id })).row()
  }
  return kb
}

/** Pick a project to open or start. */
export function projectsKeyboard(
  projects: { handle: string; name: string; online: boolean }[],
): InlineKeyboard {
  const kb = new InlineKeyboard()
  for (const p of projects) {
    kb.text(`${p.online ? '🟢' : '⚫'} ${p.name}`.slice(0, 64), projectCb.pack({ h: p.handle, action: 'open' })).row()
  }
  return kb
}

/** The button an offline topic carries. */
export function startKeyboard(handle: string, t: Strings, locale: Locale): InlineKeyboard {
  return new InlineKeyboard()
    .text(`▶️ ${t.t(locale, 'project.start')}`, projectCb.pack({ h: handle, action: 'start' })).style('primary')
}

/** The control strip under the pinned status message. */
export function hudKeyboard(handle: string, canInterrupt: boolean, t: Strings, locale: Locale): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text(`⚙️ ${t.t(locale, 'controls.settings')}`, settingsCb.pack({ h: handle, page: 'root' }))
  if (canInterrupt) {
    kb.text(`⏹ ${t.t(locale, 'controls.interrupt')}`, projectCb.pack({ h: handle, action: 'interrupt' })).style('danger')
  }
  return kb
}

/** The settings panel's landing page. */
export function settingsRootKeyboard(
  handle: string,
  current: { model: string | null; effort: string | null; permission_mode: string | null },
  t: Strings,
  locale: Locale,
): InlineKeyboard {
  const dash = '—'
  return new InlineKeyboard()
    .text(`${t.t(locale, 'controls.model')}: ${shortModel(current.model ?? undefined) ?? dash}`,
      settingsCb.pack({ h: handle, page: 'model' })).row()
    .text(`${t.t(locale, 'controls.effort')}: ${current.effort ?? dash}`,
      settingsCb.pack({ h: handle, page: 'effort' })).row()
    .text(`${t.t(locale, 'controls.permissionMode')}: ${current.permission_mode ?? dash}`,
      settingsCb.pack({ h: handle, page: 'permission' })).row()
    .text(`✖ ${t.t(locale, 'controls.close')}`, closeCb.pack({}))
}

/** One page of the settings panel: the choices, then a way back. */
export function settingsPageKeyboard(
  handle: string,
  page: 'model' | 'effort' | 'permission',
  values: readonly string[],
  current: string | null,
  t: Strings,
  locale: Locale,
): InlineKeyboard {
  const kb = new InlineKeyboard().columns(2)
  for (const value of values) {
    kb.text(`${value === current ? '● ' : ''}${value}`, settingsCb.pack({ h: handle, page, value }))
  }
  return kb.columns().row()
    .text(`← ${t.t(locale, 'controls.back')}`, settingsCb.pack({ h: handle, page: 'root' }))
}

/** Language switcher. */
export function langKeyboard(current: Locale): InlineKeyboard {
  const kb = new InlineKeyboard()
  for (const locale of LOCALES) {
    kb.text(`${locale === current ? '● ' : ''}${LOCALE_NAMES[locale]}`, langCb.pack({ locale }))
  }
  return kb
}
