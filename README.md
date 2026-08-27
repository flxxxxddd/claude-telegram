<div align="center">

# claude-telegram

**Drive Claude Code from Telegram.**
A topic per project, the whole turn mirrored as it happens, and buttons for the questions that need you.

[![npm](https://img.shields.io/npm/v/claude-code-telegram?style=flat-square&logo=npm&labelColor=000000)](https://www.npmjs.com/package/claude-code-telegram)
[![CI](https://img.shields.io/github/actions/workflow/status/flxxxxddd/claude-telegram/ci.yml?branch=main&style=flat-square&labelColor=000000&label=ci)](https://github.com/flxxxxddd/claude-telegram/actions)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square&labelColor=000000)](./LICENSE)

</div>

---

You are away from the machine. Claude Code is halfway through a deploy. Right now
you find out how it went by walking back to the laptop.

This puts the session in your pocket: its prose, its thinking, and every command
it runs, arriving in Telegram as they happen — not a summary written afterwards,
because nothing is summarising anything. The bridge reads Claude Code's own
transcript, so what you see is what the terminal sees.

```
┌─ 🔵 Working ──────────────────────────────────┐
│ ❝ deploy it                                   │
│ ┌────────────────┬────────────────────────────┤
│ │ Project        │ codexgram                  │
│ │ State          │ 🔵 Working                 │
│ │ Model          │ opus-5                     │
│ │ Effort         │ high                       │
│ │ Context        │ 47k / 200k · 24%           │
│ │ Branch         │ main                       │
│ │ Account        │ flxprrr                    │
│ │ Session limit  │ 🟡 79% · 3h 55m            │
│ │ Weekly limit   │ 🟢 16% · 151h              │
│ └────────────────┴────────────────────────────┤
│ Updates automatically.    [⚙️ Model · Effort]  │
└───────────────────────────────────────────────┘
```

That block is pinned to the top of the project's thread and edited in place, so
the thing you most want to know — *when will this stop working* — never scrolls
away.

## What you get

**A topic per project.** Inside your DM with the bot; no group to create.
Telegram's `createForumTopic` works in a private chat, so each project gets its
own thread and two projects never talk over each other. Claude Code names the
session and the topic is renamed to match.

**The whole turn, live.** Prose arrives as paragraphs while it is written, the
thinking shows as an animated placeholder, and the tool trail collapses into a
section you can open:

> Runbook read. The changes only touch the Hub, so the rollout is scoped to one
> service. Running the mandatory checks now.
>
> <details><summary>Ran 6 steps</summary>
>
> `read RUNBOOK.md` · `$ bun test` · `$ bunx tsc --noEmit` · `$ git status --short`
> </details>

**Buttons for the decisions.** Permission requests and multiple-choice questions
come through as taps, not as a prompt in a terminal you are not sitting at. The
`ask` tool replaces `AskUserQuestion`, which only ever reaches the terminal.

**Nothing is lost while you are away.** A message typed at an offline project is
queued and replayed in order when a session opens; the topic offers ▶️ to start
one.

**Many sessions, one bot.** Telegram allows exactly one poller per token, so a
single daemon owns it and every session on the machine attaches to that.

**It knows which account it is spending.** If you use
[claude-account-manager](https://github.com/flxxxxddd/claude-account-manager),
the status carries the login and both rate-limit windows, `/accounts` picks
which account a project launches as, and when the running one is nearly spent
the topic gets one message with a button that moves you to an account with room.

## Install

Needs [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`.

### 1. Make a bot

DM [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token
(`123456789:AAHfiq...`, digits and colon included).

### 2. Turn on Topic Mode

@BotFather → `/mybots` → your bot → **Bot Settings** → **Topic Mode** → Enable.

This is what gives each project its own thread. Skip it and the bridge still
works, one session per chat, switched with `/sessions`.

### 3. Install the plugin

```
/plugin marketplace add flxxxxddd/claude-telegram
/plugin install claude-telegram@claude-telegram
```

Or from a terminal:

```sh
claude plugin marketplace add flxxxxddd/claude-telegram
claude plugin install claude-telegram@claude-telegram
```

The CLI alone, without the plugin, is on npm as `claude-code-telegram` — the
name `claude-telegram` was already taken there:

```sh
bun add -g claude-code-telegram
```

### 4. Set it up

```sh
cctg setup
```

Saves the token to `~/.claude/channels/telegram/.env` (mode 600), asks for an
interface language, and reports anything still missing. Or run
`/cctg:configure` and have Claude do it.

### 5. Start a session

Both flags are required, and both take the **same tagged entry**:

```sh
claude --channels plugin:claude-telegram@claude-telegram \
       --dangerously-load-development-channels plugin:claude-telegram@claude-telegram
```

Worth an alias — you will type it every day:

```sh
alias ctg='claude --channels plugin:claude-telegram@claude-telegram --dangerously-load-development-channels plugin:claude-telegram@claude-telegram'
```

<details>
<summary><b>Why the second flag, and how to stop needing it</b></summary>

Claude Code allowlists channel plugins separately, and only for the **inbound**
direction. A plugin you installed yourself is not on that list. Without the flag
the session starts, the mirror works and the topic fills up — while everything
you type to the bot is dropped, after one line at startup and silence after
that. It is the most confusing state this thing can be in.

The flag is declared `<servers...>`, not a boolean: passing it bare fails with
`option '--dangerously-load-development-channels <servers...>' argument missing`.
It lifts the check for every channel plugin in that session, and Claude Code
asks you to confirm at each startup.

To stop needing it, allowlist the plugin in **managed settings** — root-owned,
`/Library/Application Support/ClaudeCode/managed-settings.json` on macOS,
`/etc/claude-code/managed-settings.json` on Linux:

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "claude-telegram", "plugin": "claude-telegram" }
  ]
}
```

Note that `allowedChannelPlugins` **replaces** Anthropic's default list rather
than extending it, so any official channel plugin you also use must be named
there too.

</details>

### 6. Pair

DM your bot. It replies with a six-character code. In your session:

```
/cctg:access pair A7K2M9
```

Then close the door behind you, so a stranger gets nothing at all — not even a
pairing code:

```
/cctg:access policy allowlist
```

### Check it

```sh
cctg doctor
```

```
cctg doctor
────────────────────────────────────────────────────────────
✓ token present (8846898724)
✓ daemon 0.1.4 running as @neverlane_bot (pid 95774)
✓ topic mode is on — every project gets its own thread
✓ 1 session(s) connected
✓ 1 user(s), 0 chat(s) allowed · policy allowlist
✓ the plugin is installed
✓ mirror hooks come from the plugin
✓ state database at ~/.claude/channels/telegram/cctg.db (5 topics)
```

Every check that fails names its own fix.

## Using it

### In Telegram

| | |
| --- | --- |
| *type anything* | goes to the session that owns this topic |
| `/status` | what the session is doing right now |
| `/sessions` | pick which session this chat talks to |
| `/new` | open a project, or start a session in one |
| `/settings` | model, effort and permission mode |
| `/accounts` | which Claude.ai account sessions here use |
| `/lang` | English or Russian |
| `/help` | all of the above |

The commands are published to Telegram's menu in both languages, so `/`
autocompletes them.

### In the terminal

| | |
| --- | --- |
| `cctg setup` | first run; `--hooks` to only wire the mirror |
| `cctg status` | sessions, their accounts and limits, topics, queues |
| `cctg doctor` | every link in the chain, with the fix for each break |
| `cctg daemon start` | run the bridge (detached; `--foreground` to watch it) |
| `cctg daemon stop` · `restart` | |
| `cctg daemon log -f` | follow the log |

The daemon starts itself when the first session needs it, so `daemon start` is
mostly for watching it come up.

```
$ cctg status

daemon 0.1.4
────────────────────────────────────────────────────────────
  bot        @neverlane_bot
  threading  ✓ topics

sessions (1)
────────────────────────────────────────────────────────────
  codexgram  working
  project    codexgram
  model      claude-opus-5
  topic      1339932
  connected  4m ago
  account    flxprrr  79% · 3h 55m  ·  16% · 151h 15m
```

## Tools the assistant gets

| Tool | What it does |
| --- | --- |
| `reply` | Send to a chat. Omit `chat_id` to answer in this session's own topic. Attaches files by absolute path — images preview inline, the rest go as documents (50MB cap). |
| `ask` | Ask a multiple-choice question as buttons and block until one is tapped. Use instead of `AskUserQuestion`, which only reaches the terminal. |
| `react` | React with an emoji, from Telegram's fixed list. |
| `edit_message` | Rewrite a message the bot sent. Edits push no notification. |
| `download_attachment` | Fetch a file into the local inbox, ready to `Read`. |
| `status` | What the bridge knows: sessions, topics, models, state. |

There is deliberately **no** tool for streaming progress. The turn is mirrored
already, so the assistant is told not to narrate itself.

## Starting sessions from Telegram

Off unless you ask for it — spawning a shell because a chat message said so
should be a deliberate choice. Set a template and ▶️ works:

```sh
export TELEGRAM_LAUNCH_CMD="tmux new-session -d -s cctg_{name} -c {cwd} '{claude}'"
```

`{cwd}` is the project path, `{name}` its last segment, and `{claude}` the whole
invocation — channel flags, the project's model and effort, and the `cca run`
prefix if an account is chosen. Without the variable, the button replies with
the command to run yourself.

## With claude-account-manager

If [`cca`](https://github.com/flxxxxddd/claude-account-manager) is installed,
this picks it up on its own. Nothing to configure.

- **The status carries the account** it is spending, and both windows, marked
  🟢 🟡 🔴 by how close each is to stopping you.
- **`/accounts`** lists your logins with their tightest window and sets which one
  a project launches as — or *whichever has room*, which becomes `cca run --best`.
- **At 90%** of the session window the topic gets one message with a button that
  both switches the project to an account with room and starts a session on it.

Read from cca's own cache, so it costs no network and no lock. A machine without
cca sees exactly the table it always saw.

## Configuration

`~/.claude/channels/telegram/config.json`, or the matching environment variable
to override a single run.

| Key | Values | Environment |
| --- | --- | --- |
| `threadMode` | `auto` `topics` `flat` | `TELEGRAM_THREAD_MODE` |
| `mirror` | `full` `activity` `off` | `CCTG_MIRROR` |
| `locale` | `en` `ru` | `CCTG_LOCALE` |
| `streaming` | `true` `false` | |
| `pinnedStatus` | `true` `false` | |
| `launchCmd` | shell template | `TELEGRAM_LAUNCH_CMD` |

`TELEGRAM_STATE_DIR` moves the whole state directory — that is how you run a
second bot with its own token, allowlist and topics on one machine.

## How it works

```
                    ┌──────────────────────────────────────┐
   Telegram  ◀────▶ │  daemon — one per bot token          │
                    │  the single getUpdates poller        │
                    │  access control · topics · routing   │
                    │  reads each session's transcript     │
                    └───────────────┬──────────────────────┘
                                    │  newline-JSON over a UNIX socket
              ┌─────────────────────┼─────────────────────┐
        ┌─────┴──────┐        ┌─────┴──────┐        ┌─────┴──────┐
        │  MCP shim  │        │  MCP shim  │        │  MCP shim  │
        │  session A │        │  session B │        │  session C │
        └────────────┘        └────────────┘        └────────────┘
```

Telegram allows exactly one `getUpdates` consumer per token. The plugin this
forked from spawned a poller per session, so sessions fought over that slot and
only one ever received anything. Here one long-lived daemon owns the poller and
every Bot API call; the per-session shims hold no Telegram state at all.

The mirror does not ask the assistant to narrate. It follows
`~/.claude/projects/<slug>/<session-id>.jsonl`, which Claude Code appends a
record to per API response — the same narrative the terminal renders.

## What Telegram cannot do

The Bot API exposes **neither message history nor search**. The bot only sees
messages as they arrive, so there is no fetching earlier context — if the
assistant needs it, it will ask you to paste it. Photos are downloaded on
arrival for the same reason.

Telegram also compresses photos. Send a file as a document (long-press → Send as
File) when the original matters.

## Development

```sh
bun install
bun test                  # the tailer, the renderer, the store, access, callbacks
bunx tsc --noEmit
bun run build             # → dist/cli.js and plugin/dist/cctg.js
bun run src/cli.ts doctor
```

`TELEGRAM_STATE_DIR=/tmp/cctg-test` isolates a scratch state directory, so
experiments never touch a real token, allowlist or topic set.

[CLAUDE.md](./CLAUDE.md) records the things the code cannot tell you: why there
is exactly one daemon, why the mirror reads a transcript, and the handful of
rules that are each a bug someone would otherwise reintroduce.

## License

MIT.
