/**
 * The `/` command menu.
 *
 * Descriptions live here once and reach two places: Telegram's menu button (so
 * typing `/` autocompletes) and `/help` (rendered from the same list). They
 * used to be a hand-kept paragraph in the dictionary, which is a list that
 * silently stops matching the handlers next to it.
 */

export type MenuEntry = {
  name: string
  /** `default` is required by the Bot API; other keys are locale codes. */
  description: { default: string; ru: string }
}

/**
 * Ordered as a new user meets them: what am I looking at, what can it do, then
 * the things that change it.
 */
export const MENU: MenuEntry[] = [
  { name: 'status', description: { default: 'what the session is doing', ru: 'чем занята сессия' } },
  { name: 'sessions', description: { default: 'pick the session this chat talks to', ru: 'выбрать сессию для этого чата' } },
  { name: 'new', description: { default: 'open a project, or start a session in one', ru: 'открыть проект или запустить в нём сессию' } },
  { name: 'settings', description: { default: 'model, effort and permissions', ru: 'модель, effort и права' } },
  { name: 'accounts', description: { default: 'which Claude.ai account sessions use', ru: 'под каким аккаунтом Claude.ai идут сессии' } },
  { name: 'lang', description: { default: 'switch language', ru: 'сменить язык' } },
  { name: 'help', description: { default: 'what all of this does', ru: 'что всё это делает' } },
]

/** The `/help` body for a locale, built from the same list Telegram gets. */
export function menuHelp(locale: 'en' | 'ru'): string {
  return MENU
    .map(entry => `/${entry.name} — ${locale === 'ru' ? entry.description.ru : entry.description.default}`)
    .join('\n')
}

/** Just enough of the Bot API to publish a menu, so tests can stand in for it. */
export type MenuApi = {
  setMyCommands(params: {
    commands: { command: string; description: string }[]
    language_code?: string
  }): Promise<unknown>
}

/**
 * Push the `/` menu, once per locale plus the default.
 *
 * Telegram *replaces* a menu rather than merging, so each locale gets the whole
 * list. `registered` is what actually has a handler: a menu entry without one
 * is a dead end the user only finds by tapping it, so it is dropped with a
 * line in the log rather than published.
 */
export async function pushMenu(
  api: MenuApi,
  registered: readonly string[],
  log: (message: string) => void,
): Promise<void> {
  const live = MENU.filter(entry => {
    if (registered.includes(entry.name)) return true
    log(`menu entry /${entry.name} has no handler — not publishing it`)
    return false
  })

  const push = async (languageCode: string | undefined, pick: (e: MenuEntry) => string): Promise<void> => {
    await api.setMyCommands({
      commands: live.map(entry => ({ command: entry.name, description: pick(entry) })),
      ...(languageCode ? { language_code: languageCode } : {}),
    })
  }

  try {
    await push(undefined, e => e.description.default)
    await push('ru', e => e.description.ru)
  } catch (err) {
    // A menu that failed to publish costs autocompletion, not the bridge.
    log(`could not publish the command menu: ${String(err)}`)
  }
}
