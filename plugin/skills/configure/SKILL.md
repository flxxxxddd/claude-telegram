---
name: configure
description: Set up or reconfigure the Telegram bridge — save the bot token, pick the interface language, wire the mirror hooks, check that it works. Use when the user pastes a Telegram bot token, asks how to set up Telegram, asks why the bot is not answering, or wants to change the language or streaming behaviour.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(cctg *)
  - Bash(bun *)
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(chmod *)
---

# /cctg:configure — set up the Telegram bridge

Everything here has a command. Prefer running it over editing files by hand;
`cctg` writes with the right permissions and validates as it goes.

**Resolve the state directory first** — it is overridable, and a second bot on
the same machine has its own:

```bash
cctg doctor
```

The last line of `doctor` prints the state directory in use. Every path below
is relative to it.

## The token

The user creates a bot with [@BotFather](https://t.me/BotFather) (`/newbot`),
which replies with a token shaped `123456789:AA...`.

```bash
cctg setup
```

This prompts for the token, saves it to `<state>/.env` with mode 600, asks for
an interface language, and offers to wire the mirror hooks. To write the token
without the wizard:

```bash
echo 'TELEGRAM_BOT_TOKEN=<token>' > "$(dirname "$(cctg doctor | tail -1 | awk '{print $NF}')")/.env"
```

`TELEGRAM_BOT_TOKEN` in the environment always wins over the file.

**Never echo a token back into the conversation.** Confirm by its bot id (the
digits before the colon), not the secret.

## Topic mode

Topic mode is what gives every project its own thread inside the user's DM.
It is off by default and only the bot's owner can turn it on:

> @BotFather → `/mybots` → the bot → **Bot Settings** → **Topic Mode** → Enable

Then `cctg daemon restart`. `cctg doctor` reports whether it took effect.
Without it the bridge still works — one chat carries one session at a time, and
`/sessions` switches between them.

## The mirror hooks

The turn mirror is driven by four Claude Code hooks. Installing the plugin wires
them automatically. For a manual install:

```bash
cctg setup --hooks
```

It backs `settings.json` up before its first edit and merges rather than
rewrites.

## Settings

`<state>/config.json` holds the durable choices. Each is also an environment
variable, which wins for one run.

| Key | Values | What it does |
| --- | --- | --- |
| `threadMode` | `auto` `topics` `flat` | `auto` uses topics when the bot has them. `TELEGRAM_THREAD_MODE` |
| `mirror` | `full` `activity` `off` | `full` streams the whole turn from the transcript. `CCTG_MIRROR` |
| `locale` | `en` `ru` | Default interface language. `CCTG_LOCALE` |
| `streaming` | `true` `false` | Stream a live draft, or post the turn once at the end. |
| `pinnedStatus` | `true` `false` | Keep a pinned status message per topic. |
| `launchCmd` | shell template | Lets Telegram start sessions. `TELEGRAM_LAUNCH_CMD` |
| `projects` | paths | Extra directories offered by `/new`. |

## Starting sessions from Telegram

Off unless `launchCmd` is set — spawning a shell because a chat message asked
should be a deliberate choice. The template substitutes `{cwd}`, `{name}` and
`{claude}` (the full `claude` invocation, including the channel flag and the
project's stored model/effort):

```bash
export TELEGRAM_LAUNCH_CMD="tmux new-session -d -s cctg_{name} -c {cwd} '{claude}'"
```

Without it, the ▶️ button replies with the exact command to run by hand.

## Checking it works

```bash
cctg doctor    # every link in the chain, with the fix for each broken one
cctg status    # connected sessions, their topics, queued messages
cctg daemon log -f
```

A session only reaches the bridge when it was started with the channel flag:

```bash
claude --channels plugin:claude-telegram@claude-telegram
```
