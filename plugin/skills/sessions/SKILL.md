---
name: sessions
description: Inspect and route Telegram sessions — see what is connected, which topic belongs to which project, what is queued, and which session a chat talks to. Use when the user asks what the bridge is doing, why a message went to the wrong project, or how to point a chat at a different session.
user-invocable: true
allowed-tools:
  - Read
  - Bash(cctg *)
---

# /cctg:sessions — what is connected, and where messages go

```bash
cctg status
```

Reports the daemon, every connected session with its project, model and topic,
and every topic with its queue depth.

## How a message finds a session

**With topic mode on** — the normal case — routing is by topic. Each project
owns one topic in the chat; a message typed in it goes to a session running in
that directory. If none is running the message is held in the queue and replayed
in order when a session for that project connects, and the topic shows a
▶️ button to start one.

**With topic mode off**, a chat carries one session at a time. `/sessions` in
Telegram lists what is connected as buttons; tapping one binds the chat to it.
A chat with no binding adopts whichever session answers it first, so the next
message does not silently move to a different project.

## Common answers

**"My message went to the wrong project."** The chat has no topic and is bound
to another session. Send `/sessions` in Telegram and tap the right one — or turn
topic mode on in @BotFather so routing stops depending on a binding at all.

**"The bot says no session is connected."** The session was started without the
channel flag. It needs:

```bash
claude --channels plugin:claude-telegram@claude-telegram
```

**"Nothing appears in Telegram while Claude works."** The mirror hooks are not
wired. `cctg doctor` says so; `cctg setup --hooks` fixes it.

**"Messages are queued but never delivered."** The queue is keyed by the
project's absolute path. A session started in a subdirectory of the project is a
different key. `cctg status` prints both paths — compare them.

## Starting a session from Telegram

`/new` in Telegram lists known projects. An offline one offers ▶️. Whether that
actually spawns anything depends on `TELEGRAM_LAUNCH_CMD`; without it the bot
replies with the command to run by hand. See `/cctg:configure`.
