# Telegram

Connect a Telegram bot to your Claude Code with an MCP server.

The MCP server logs into Telegram as a bot and provides tools to Claude to reply, react, or edit messages. When you message the bot, the server forwards the message to your Claude Code session.

## Prerequisites

- [Bun](https://bun.sh) — the MCP server runs on Bun. Install with `curl -fsSL https://bun.sh/install | bash`.

## Quick Setup
> Default pairing flow for a single-user DM bot. See [ACCESS.md](./ACCESS.md) for groups and multi-user setups.

**1. Create a bot with BotFather.**

Open a chat with [@BotFather](https://t.me/BotFather) on Telegram and send `/newbot`. BotFather asks for two things:

- **Name** — the display name shown in chat headers (anything, can contain spaces)
- **Username** — a unique handle ending in `bot` (e.g. `my_assistant_bot`). This becomes your bot's link: `t.me/my_assistant_bot`.

BotFather replies with a token that looks like `123456789:AAHfiqksKZ8...` — that's the whole token, copy it including the leading number and colon.

**2. Install the plugin.**

These are Claude Code commands — run `claude` to start a session first.

Install the plugin:
```
/plugin install telegram@claude-plugins-official
```

**3. Give the server the token.**

```
/telegram:configure 123456789:AAHfiqksKZ8...
```

Writes `TELEGRAM_BOT_TOKEN=...` to `~/.claude/channels/telegram/.env`. You can also write that file by hand, or set the variable in your shell environment — shell takes precedence.

> To run multiple bots on one machine (different tokens, separate allowlists), point `TELEGRAM_STATE_DIR` at a different directory per instance.

**4. Relaunch with the channel flag.**

The server won't connect without this — exit your session and start a new one:

```sh
claude --channels plugin:telegram@claude-plugins-official
```

**5. Pair.**

With Claude Code running from the previous step, DM your bot on Telegram — it replies with a 6-character pairing code. If the bot doesn't respond, make sure your session is running with `--channels`. In your Claude Code session:

```
/telegram:access pair <code>
```

Your next DM reaches the assistant.

> Unlike Discord, there's no server invite step — Telegram bots accept DMs immediately. Pairing handles the user-ID lookup so you never touch numeric IDs.

**6. Lock it down.**

Pairing is for capturing IDs. Once you're in, switch to `allowlist` so strangers don't get pairing-code replies. Ask Claude to do it, or `/telegram:access policy allowlist` directly.

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, groups, mention detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: IDs are **numeric user IDs** (get yours from [@userinfobot](https://t.me/userinfobot)). Default policy is `pairing`. `ackReaction` only accepts Telegram's fixed emoji whitelist.

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a chat. Takes `chat_id` + `text`, optionally `reply_to` (message ID) for native threading and `files` (absolute paths) for attachments. Images (`.jpg`/`.png`/`.gif`/`.webp`) send as photos with inline preview; other types send as documents. Max 50MB each. Auto-chunks text; files send as separate messages after the text. Returns the sent message ID(s). |
| `react` | Add an emoji reaction to a message by ID. **Only Telegram's fixed whitelist** is accepted (👍 👎 ❤ 🔥 👀 etc). |
| `edit_message` | Edit a message the bot previously sent. Useful for "working…" → result progress updates. Only works on the bot's own messages. |
| `ask` | Ask the user a multiple-choice question as inline buttons and **block until they tap**. Use instead of the terminal `AskUserQuestion` tool, which never reaches Telegram. Returns the chosen option label. |
| `stream` | Stream output into one message by editing it in place (debounced ~1 edit/sec). First call returns a `stream_id`; pass it on later calls with the full updated text; use `action:"final"` for the last update. |

## Architecture — daemon + multi-session (this fork)

Upstream spawns the server once **per Claude Code session** and each instance polls
Telegram directly. Telegram allows only one `getUpdates` consumer per bot token, so
sessions fight over the slot and only one works at a time.

This fork splits the server in two:

- **`daemon.ts`** — one long-lived process per bot token. It owns the single poller,
  all access control / pairing, and every Bot API call. Auto-spawned (detached) by
  the first session that finds none running; single-instance guarded via the socket.
- **`server.ts`** — a thin MCP shim Claude Code spawns per session. It holds no
  Telegram state: it connects to the daemon over a UNIX socket
  (`$TELEGRAM_STATE_DIR/daemon.sock`), registers the session, forwards tool calls,
  and relays inbound messages + permission answers back as MCP notifications.
- **`protocol.ts`** — shared IPC types (newline-delimited JSON framing).

**Routing.** Inbound messages route to a bound session. `/sessions` lists connected
sessions as inline buttons — tap one to route the current chat to it. A chat with no
binding auto-binds to the most recently connected session. Permission requests route
back to the exact session that raised them.

See **[DESIGN.md](./DESIGN.md)** for the full design and roadmap (topic threading is
Phase 3).

**Bot commands (DM):** `/start` `/help` `/status` `/sessions` (pick which session a
chat routes to) `/new` (list projects; start an offline one).

**Offline queue.** Messages typed into a project topic while its session is offline
are held (persisted in `queue.json`) and replayed in order when a session for that
project reconnects.

**Start from Telegram.** An offline topic shows a **▶️ Start session** button (also
via `/new`). Actual spawning runs only when `TELEGRAM_LAUNCH_CMD` is set (a shell
template with `{cwd}`/`{name}`, e.g. `tmux new-session -d -s tg_{name} -c {cwd}
'claude --channels plugin:telegram@claude-plugins-official'`); otherwise the bot
replies with the exact command to run by hand.

## Activity mirror (see what Claude is doing)

By default you only see what Claude explicitly sends. To mirror its tool activity
into the project topic, wire `hooks/activity.ts` into Claude Code's hooks
(`settings.json`) — each tool call posts a one-line summary (coalesced per burst):

```json
{
  "hooks": {
    "PostToolUse": [{ "matcher": "*", "hooks": [
      { "type": "command", "command": "bun /ABS/PATH/claude-telegram-multi/hooks/activity.ts" } ]}],
    "Stop": [{ "hooks": [
      { "type": "command", "command": "bun /ABS/PATH/claude-telegram-multi/hooks/activity.ts" } ]}]
  }
}
```

The hook resolves the daemon socket from `TELEGRAM_STATE_DIR` (same default as the
server) and no-ops silently if no daemon is running.

Inbound messages trigger a typing indicator automatically — Telegram shows
"botname is typing…" while the assistant works on a response.

## Photos

Inbound photos are downloaded to `~/.claude/channels/telegram/inbox/` and the
local path is included in the `<channel>` notification so the assistant can
`Read` it. Telegram compresses photos — if you need the original file, send it
as a document instead (long-press → Send as File).

## No history or search

Telegram's Bot API exposes **neither** message history nor search. The bot
only sees messages as they arrive — no `fetch_messages` tool exists. If the
assistant needs earlier context, it will ask you to paste or summarize.

This also means there's no `download_attachment` tool for historical messages
— photos are downloaded eagerly on arrival since there's no way to fetch them
later.
