import type { LocaleLike } from '@yaebal/i18n'
import type { en } from './en.ts'

/**
 * Russian. `LocaleLike` keeps this structurally checked against `en`, and every
 * key is optional — anything missing falls back to English rather than showing
 * a raw key.
 */
export const ru = {
  start: {
    greet: 'Мост к Claude Code. Напишите сообщение — оно дойдёт до сессии.',
    paired: 'Готово. Ваши сообщения теперь доходят до Claude Code.',
    pairing: 'Код привязки: {code}\n\nВыполните в сессии Claude Code:\n/cctg:access pair {code}',
    denied: 'Доступ запрещён.',
  },
  help: {
    body: 'Пишите сюда — сообщение уйдёт в сессию, которой принадлежит этот топик.',
  },
  hud: {
    title: 'Claude Code',
    project: 'Проект',
    model: 'Модель',
    effort: 'Effort',
    context: 'Контекст',
    branch: 'Ветка',
    account: 'Аккаунт',
    sessionLimit: 'Лимит сессии',
    weeklyLimit: 'Лимит недели',
    session: 'Сессия',
    state: 'Статус',
    updated: 'Закреп обновляется автоматически по событиям сессии.',
    unknown: 'пока нет данных',
  },
  state: {
    idle: 'Ожидание',
    working: 'Работает',
    waiting: 'Ждёт вас',
    done: 'Готово',
    offline: 'Офлайн',
    error: 'Ошибка',
  },
  turn: {
    thinking: 'Думает…',
    tools: 'Прочитал файлы, выполнил команды',
    toolsOne: 'Выполнил 1 шаг',
    toolsMany: { one: 'Выполнил {n} шаг', few: 'Выполнил {n} шага', many: 'Выполнил {n} шагов', other: 'Выполнил {n} шага' },
    interrupted: 'Прервано.',
    complete: 'Турн завершён',
  },
  sessions: {
    none: 'Нет подключённых сессий. Запустите Claude Code с флагом канала или используйте /new.',
    pick: 'Выберите сессию для этого чата:',
    bound: 'Чат теперь ведёт в {title}.',
    current: 'сейчас',
  },
  project: {
    pick: 'Выберите проект:',
    offline: 'Для {name} нет запущенной сессии. Сообщения отсюда встают в очередь.',
    queued: { one: '{n} сообщение в очереди.', few: '{n} сообщения в очереди.', many: '{n} сообщений в очереди.', other: '{n} сообщения в очереди.' },
    start: 'Запустить сессию',
    starting: 'Запускаю сессию в {name}…',
    launchHint: 'Автозапуск выключен. Выполните сами:\n{cmd}\n\n'
      + 'Задайте TELEGRAM_LAUNCH_CMD, чтобы бот делал это за вас.',
    replayed: { one: 'Проиграно {n} отложенное сообщение.', few: 'Проиграно {n} отложенных сообщения.', many: 'Проиграно {n} отложенных сообщений.', other: 'Проиграно {n} отложенных сообщения.' },
  },
  permission: {
    ask: 'Claude хочет использовать {tool}.',
    allow: 'Разрешить',
    deny: 'Запретить',
    allowed: 'Разрешено: {tool}.',
    denied: 'Запрещено: {tool}.',
    expired: 'Этот запрос уже не ждёт ответа.',
  },
  controls: {
    settings: 'Модель · Effort',
    interrupt: 'Прервать',
    interrupted: 'Сигнал прерывания отправлен.',
    cannotInterrupt: 'Эта сессия запущена не из Telegram, прервать её отсюда нельзя.',
    model: 'Модель',
    effort: 'Effort',
    permissionMode: 'Права',
    applies: 'Применится к следующей сессии, запущенной из Telegram.',
    saved: 'Сохранено: {what}.',
    back: 'Назад',
    close: 'Закрыть',
  },
  accounts: {
    none: 'claude-account-manager на этой машине не настроен — выбирать не из чего.',
    pick: 'Под каким аккаунтом запускать сессии отсюда?',
    chosen: 'Новые сессии здесь пойдут под {name}.',
    best: 'Где есть запас',
    spent: 'выжат',
    warning: '{name} — {percent}% лимита сессии.',
    warningReset: 'Сбросится через {reset}.',
    restartOn: 'Перезапустить на {name}',
    inherit: 'Как выставлено в cca',
  },
  lang: {
    pick: 'Выберите язык:',
    changed: 'Язык переключён на русский.',
  },
  errors: {
    noSession: 'К этому чату не привязана ни одна сессия.',
    generic: 'Что-то пошло не так: {detail}',
  },
} as const satisfies LocaleLike<typeof en>
