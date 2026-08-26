/**
 * Locale wiring. The bot picks a language from Telegram's `language_code` on
 * first contact and remembers an explicit choice per chat in `cctg.db`, so a
 * Russian user gets Russian on their very first `/start`.
 */

import { createI18n } from '@yaebal/i18n'
import { en } from './en.ts'
import { ru } from './ru.ts'

export { en, ru }

export const LOCALES = ['en', 'ru'] as const
export type Locale = (typeof LOCALES)[number]

export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', ru: 'Русский' }

/** A translator usable outside middleware — the daemon, the HUD, the CLI. */
export function strings(defaultLocale: Locale = 'en') {
  return createI18n({ defaultLocale, locales: { en, ru } })
}

export type Strings = ReturnType<typeof strings>
