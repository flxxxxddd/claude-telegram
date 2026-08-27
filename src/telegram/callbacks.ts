/**
 * Typed `callback_data` namespaces.
 *
 * Telegram caps `callback_data` at 64 bytes, and a button can sit on screen for
 * days — long after the daemon that drew it restarted. So every payload here is
 * compact (base36 numbers, one character per enum member) and carries a handle
 * rather than a path; `store.handles` resolves it back. `unpack` returning
 * `undefined` for a stale button is a real path, not an error.
 */

import { callbackData, field } from 'yaebal'

/**
 * Answer a permission request: allow or deny the tool Claude asked about.
 *
 * `id` is a ticket this daemon mints, not Claude Code's `request_id` — that
 * value is not ours and nothing bounds its length, and an overflow here would
 * mean a request the user cannot answer at all.
 */
export const permissionCb = callbackData('p', {
  id: field.string(),
  allow: Boolean,
})

/** Answer an `ask` question by the index of the option tapped. */
export const askCb = callbackData('a', {
  id: field.string(),
  choice: field.number(),
})

/** Route this chat to a session (flat mode, and `/sessions`). */
export const sessionCb = callbackData('s', {
  id: field.string(),
})

/** Act on a project: open its topic, start a session, or interrupt one. */
export const projectCb = callbackData('j', {
  /** A `store.handles` id standing in for the project's absolute path. */
  h: field.string(),
  action: field.enum(['open', 'start', 'interrupt'] as const),
})

/** The settings panel: which page, and the value picked on it. */
export const settingsCb = callbackData('g', {
  h: field.string(),
  page: field.enum(['root', 'model', 'effort', 'permission'] as const),
  value: field.string().optional(),
})

/** Switch the interface language for this chat. */
export const langCb = callbackData('l', {
  locale: field.enum(['en', 'ru'] as const),
})

/**
 * Choose the cca account sessions in this project launch as.
 *
 * The account travels as a handle, not as its name: profile names are
 * user-chosen and a long one overflows the 64-byte cap, which `pack` reports by
 * throwing — taking the whole keyboard down rather than one button.
 */
export const accountCb = callbackData('c', {
  /** Handle for the project's path. */
  h: field.string(),
  /** Handle for the profile name, or one of the sentinels below. */
  a: field.string(),
  /** Also start a session on it — the limit warning's button does. */
  launch: field.boolean().default(false),
})

/** Use whichever account has room; passed to `cca run --best`. */
export const ACCOUNT_BEST = '*'
/** Clear the choice and run as whatever cca's own active profile is. */
export const ACCOUNT_INHERIT = ''

/** Dismiss a panel without changing anything. */
export const closeCb = callbackData('x', {})
