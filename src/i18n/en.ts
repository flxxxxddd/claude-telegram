import type { Dict } from '@yaebal/i18n'

/**
 * The default locale, and the shape every other locale is checked against.
 * Keys are plain strings with `{param}` placeholders — rich blocks are built in
 * `telegram/render.ts`, so a translator never has to touch markup.
 */
export const en = {
  start: {
    greet: 'Claude Code bridge. Send a message and it reaches your session.',
    paired: 'Paired. Your messages now reach Claude Code.',
    pairing: 'Pairing code: {code}\n\nRun this in your Claude Code session:\n/cctg:access pair {code}',
    denied: 'Not allowed.',
  },
  help: {
    body: 'Send text to talk to the session bound to this chat.\n\n'
      + '/status — what the session is doing\n'
      + '/sessions — pick which session this chat routes to\n'
      + '/new — open a project topic and start a session\n'
      + '/settings — model, effort and permissions\n'
      + '/lang — switch language',
  },
  hud: {
    title: 'Claude Code',
    project: 'Project',
    model: 'Model',
    effort: 'Effort',
    context: 'Context',
    branch: 'Branch',
    session: 'Session',
    state: 'State',
    updated: 'Updates automatically as the session works.',
    unknown: 'not reported yet',
  },
  state: {
    idle: 'Idle',
    working: 'Working',
    waiting: 'Waiting for you',
    done: 'Done',
    offline: 'Offline',
    error: 'Error',
  },
  turn: {
    thinking: 'Thinking…',
    tools: 'Read files, ran commands',
    toolsOne: 'Ran 1 step',
    toolsMany: { one: 'Ran {n} step', other: 'Ran {n} steps' },
    interrupted: 'Interrupted.',
    complete: 'Turn complete',
  },
  sessions: {
    none: 'No sessions connected. Start Claude Code with the channel flag, or use /new.',
    pick: 'Pick the session this chat routes to:',
    bound: 'This chat now routes to {title}.',
    current: 'now',
  },
  project: {
    pick: 'Pick a project:',
    offline: 'No session is running for {name}. Messages you send here are queued.',
    queued: { one: '{n} message queued.', other: '{n} messages queued.' },
    start: 'Start session',
    starting: 'Starting a session in {name}…',
    launchHint: 'Automatic start is off. Run this yourself:\n{cmd}\n\n'
      + 'Set TELEGRAM_LAUNCH_CMD to let the bot do it.',
    replayed: { one: 'Replayed {n} queued message.', other: 'Replayed {n} queued messages.' },
  },
  permission: {
    ask: 'Claude wants to use {tool}.',
    allow: 'Allow',
    deny: 'Deny',
    allowed: 'Allowed {tool}.',
    denied: 'Denied {tool}.',
    expired: 'That request is no longer waiting.',
  },
  controls: {
    settings: 'Model · Effort',
    interrupt: 'Interrupt',
    interrupted: 'Interrupt sent.',
    cannotInterrupt: 'This session was not started from Telegram, so it cannot be interrupted from here.',
    model: 'Model',
    effort: 'Effort',
    permissionMode: 'Permissions',
    applies: 'Applies to the next session started from Telegram.',
    saved: 'Saved: {what}.',
    back: 'Back',
    close: 'Close',
  },
  lang: {
    pick: 'Pick a language:',
    changed: 'Language set to English.',
  },
  errors: {
    noSession: 'No session is connected for this chat.',
    generic: 'Something went wrong: {detail}',
  },
} as const satisfies Dict
