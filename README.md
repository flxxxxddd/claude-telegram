# claude-telegram

Drive Claude Code from Telegram. Every project gets its own topic, and the whole
turn appears in it as it happens — the prose, the thinking, the commands — not a
summary written afterwards.

```
┌─ 🔵 Working ─────────────────────────────┐
│ ❝ deploy it                              │
│ ┌──────────┬────────────────────────────┐│
│ │ Project  │ claude-telegram            ││
│ │ State    │ 🔵 Working                 ││
│ │ Model    │ opus-5                     ││
│ │ Effort   │ high                       ││
│ │ Context  │ 47k / 200k · 24%           ││
│ │ Branch   │ main                       ││
│ └──────────┴────────────────────────────┘│
│ Updates automatically.  [⚙️ Model · Effort]│
└──────────────────────────────────────────┘
```

- **A topic per project.** Right inside your DM with the bot — no group to
  create. Messages route by topic, so two projects never talk over each other.
- **The whole turn, live.** Read from Claude Code's own transcript and streamed
  as a rich message that grows: paragraphs as they are written, the tool trail
  collapsed into a section you can open.
- **A pinned status.** Model, effort, context, branch and state, edited in place
  at the top of the thread.
- **Buttons for the decisions.** Permission requests and multiple-choice
  questions come through as taps, not as a prompt in a terminal you are not
  sitting at.
- **Nothing is lost while you are away.** Messages typed at an offline project
  are queued and replayed in order when a session opens; an offline topic offers
  to start one.
- **Many sessions, one bot.** A single daemon owns the poller, so every session
  on the machine shares one token instead of fighting over it.

## Install

Needs [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`.

**1. Make a bot.** DM [@BotFather](https://t.me/BotFather), send `/newbot`, and
copy the token it replies with (`123456789:AAHfiq...`, including the digits and
the colon).

**2. Turn on Topic Mode.** In @BotFather: `/mybots` → your bot → **Bot
Settings** → **Topic Mode** → Enable. This is what gives each project its own
thread. Skip it and the bridge still works, one session per chat.

**3. Install the plugin.** In a Claude Code session:

```
/plugin marketplace add flxxxxddd/claude-telegram
/plugin install claude-telegram@claude-telegram
```

Or just the CLI:

```sh
bun add -g claude-code-telegram    # the npm name; `claude-telegram` was taken
```

**4. Set it up.**

```
/cctg:configure
```

or, in a terminal:

```sh
cctg setup
```

This saves the token to `~/.claude/channels/telegram/.env`, asks for an
interface language (English or Russian), and wires the four hooks the mirror
needs.

**5. Start a session with the channel flag.** It has to be on the command line:

```sh
claude --channels plugin:claude-telegram@claude-telegram \
       --dangerously-load-development-channels
```

The second flag is not optional here, and it is worth knowing why. Claude Code
only lets channel plugins on its own approved list push inbound messages; a
plugin you installed yourself is not on it. Without the flag the session starts,
the mirror works and the topic fills up — but everything you type to the bot is
**silently dropped**. The flag lifts that check for the whole session, so it
applies to every channel plugin loaded in it, not just this one.

The alternative, if you would rather not pass it, is an explicit allowlist in
managed settings — `/Library/Application Support/ClaudeCode/managed-settings.json`
on macOS, `/etc/claude-code/managed-settings.json` on Linux, needs root:

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "claude-telegram", "plugin": "claude-telegram" }
  ]
}
```

Setting that key **replaces** Anthropic's default list rather than adding to it,
so any official channel plugin you also use has to be named there too.

Either way, the flag is long enough to be worth an alias:

```sh
alias ctg='claude --channels plugin:claude-telegram@claude-telegram --dangerously-load-development-channels'
```

**6. Pair.** DM your bot. It replies with a six-character code. In your session:

```
/cctg:access pair <code>
```

Then lock it down, so strangers get nothing at all:

```
/cctg:access policy allowlist
```

`cctg doctor` checks every step and names the fix for anything missing.

## Using it

**In Telegram**

| | |
| --- | --- |
| type anything | goes to the session that owns this topic |
| `/status` | what the session is doing right now |
| `/sessions` | pick which session this chat routes to |
| `/new` | open a project topic, or start a session in one |
| `/settings` | model, effort and permission mode for the next launch |
| `/lang` | switch between English and Russian |

**In the terminal**

| | |
| --- | --- |
| `cctg setup` | first run, or `--hooks` to only wire the mirror |
| `cctg status` | connected sessions, topics, queue depths |
| `cctg doctor` | check every link, with the fix for each broken one |
| `cctg daemon start\|stop\|restart` | run the bridge by hand |
| `cctg daemon log -f` | follow the daemon log |

The daemon starts itself when the first session needs it, so `daemon start` is
mostly for watching it come up.

## Tools the assistant gets

| Tool | What it does |
| --- | --- |
| `reply` | Send to a chat. Omit `chat_id` to answer in the session's own topic. Attaches files by absolute path — images preview inline, the rest send as documents (50MB cap). |
| `ask` | Ask a multiple-choice question as buttons and block until one is tapped. Replaces `AskUserQuestion`, which only ever reaches the terminal. |
| `react` | React with an emoji, from Telegram's fixed list. |
| `edit_message` | Rewrite a message the bot sent. Edits do not push a notification. |
| `download_attachment` | Fetch a file from a message into the local inbox, ready to `Read`. |
| `status` | What the bridge knows: sessions, topics, models, state. |

There is no tool for streaming progress. The turn is mirrored automatically, so
the assistant does not have to narrate itself.

## Starting sessions from Telegram

Off unless you ask for it — spawning a shell because a chat message said so
should be a deliberate choice. Set a template and the ▶️ button works:

```sh
export TELEGRAM_LAUNCH_CMD="tmux new-session -d -s cctg_{name} -c {cwd} '{claude}'"
```

`{cwd}` is the project path, `{name}` its last segment, and `{claude}` the full
invocation including the channel flag and that project's stored model and
effort. Without the variable, the button replies with the command to run
yourself.

## Configuration

`~/.claude/channels/telegram/config.json`, or the matching environment variable
for a single run.

| Key | Values | Environment |
| --- | --- | --- |
| `threadMode` | `auto` `topics` `flat` | `TELEGRAM_THREAD_MODE` |
| `mirror` | `full` `activity` `off` | `CCTG_MIRROR` |
| `locale` | `en` `ru` | `CCTG_LOCALE` |
| `streaming` | `true` `false` | |
| `pinnedStatus` | `true` `false` | |
| `launchCmd` | shell template | `TELEGRAM_LAUNCH_CMD` |

`TELEGRAM_STATE_DIR` moves the whole state directory, which is how you run a
second bot with its own token, allowlist and topics on one machine.

## What Telegram cannot do

The Bot API exposes **neither message history nor search**. The bot only sees
messages as they arrive, so there is no way to fetch earlier context — if the
assistant needs it, it will ask you to paste it. Photos are downloaded on
arrival for the same reason: there is no fetching them later.

Telegram also compresses photos. Send a file as a document (long-press → Send as
File) when the original matters.

## License

MIT.
