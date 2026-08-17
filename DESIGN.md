# claude-telegram-multi — Design

Rewrite of the official `telegram` channel plugin (v0.0.7) into a **daemon-backed,
multi-session** bridge with **streaming** output and **Telegram threading**.

## Why

The upstream `server.ts` is spawned by Claude Code once **per session** and polls
Telegram directly. Telegram allows exactly one `getUpdates` consumer per bot token,
so the code has to kill stale pollers (PID file + 409 handling) and only one session
can ever receive messages. That's the wall the "multi" fork removes.

## Target architecture

```
                    ┌─────────────────────────────────────┐
   Telegram  <────> │  daemon.ts  (one per bot token)      │
   (getUpdates,     │  - single poller / Bot(TOKEN)        │
    Bot API)        │  - access control + pairing          │
                    │  - session registry + routing table  │
                    │  - listens on UNIX socket            │
                    └───────────────┬─────────────────────┘
                                    │  newline-delimited JSON
                                    │  over $STATE_DIR/daemon.sock
          ┌─────────────────────────┼─────────────────────────┐
          │                         │                         │
   ┌──────┴───────┐          ┌──────┴───────┐          ┌──────┴───────┐
   │ server.ts    │          │ server.ts    │          │ server.ts    │
   │ (MCP shim)   │          │ (MCP shim)   │          │ (MCP shim)   │
   │ session A    │          │ session B    │          │ session C    │
   └──────────────┘          └──────────────┘          └──────────────┘
     Claude Code A             Claude Code B             Claude Code C
```

- **daemon.ts** — long-lived. Owns the bot, polls once, does all Telegram I/O,
  access control, pairing, and routing. Auto-spawned (detached) by the first shim
  that finds no daemon listening; survives session exits. Idempotent single-instance
  via `daemon.pid` + socket liveness check.
- **server.ts** — becomes a thin MCP stdio shim Claude Code spawns per session.
  Connects to the daemon socket, registers the session (id, cwd, title, pid),
  forwards tool calls, and relays daemon→session events (inbound messages,
  ask-answers, permission replies) as MCP notifications. No Telegram code.
- **protocol.ts** — shared IPC message types.

## Routing (multi-session)

Inbound Telegram message → which session?

1. **Threading mode (preferred):** `createForumTopic` works "in a forum supergroup
   chat **or a private chat with a user**" (Bot API), so each session gets its own
   **topic right inside the user's DM** — no group required. Requires the bot to
   have Topic Mode enabled in BotFather; detected at boot via
   `getMe().has_topics_enabled`. The daemon creates a topic per session per
   allowlisted DM, injects that topic's `message_thread_id` into the session's
   outbound messages, and routes inbound by the topic the user typed in. Controlled
   by `TELEGRAM_THREAD_MODE=auto|topics|flat` (auto = on iff the bot supports it).
2. **Flat / DM fallback:** no topics. Daemon keeps a `boundSession` per chat.
   `/sessions` lists connected sessions as inline buttons; tapping one binds the DM
   to it. Unbound DM auto-binds to the most recently connected session.

## Streaming

MCP channels deliver discrete tool calls, not token streams, so "streaming" =
progressive **edit** of a single Telegram message as Claude works:

- New tool `stream`: `{action:'start'|'append'|'final', chat_id, stream_id, text}`.
  `start` sends a placeholder and returns a `stream_id`; `append`/`final` edit it
  (debounced to respect Telegram edit rate limits, ~1 edit/sec). `final` unlocks a
  fresh push message so the device pings on completion.
- The daemon owns debouncing/coalescing so bursts don't hit 429s.

## Fix: questions/permissions must show in Telegram

Two hook surfaces:

- **Permission requests** already render as inline buttons via
  `claude/channel/permission`. They only *looked* broken because a second poller
  stole updates — fixed structurally once the daemon is the sole poller.
- **AskUserQuestion** is a terminal-only client tool; it never reaches the channel.
  Fix: expose an MCP `ask` tool that renders the question + options as an inline
  keyboard in Telegram and blocks until the user taps one, returning the choice.
  MCP `instructions` tell Claude to prefer `ask` over AskUserQuestion in Telegram
  sessions. Per user directive: **do not use terminal AskUserQuestion** for
  Telegram-driven work until `ask` lands.

## Phases

1. **Daemon core + IPC** — extract Bot/access/pairing into daemon.ts; socket server;
   auto-spawn; single-instance. server.ts becomes shim relaying reply/react/
   download/edit. Behavior parity with upstream for a single DM session.
2. **Multi-session routing** — session registry, `/sessions` picker, DM binding.
3. **Threading mode** — forum topics, one per session, auto create/claim.
4. **Streaming** — `stream` tool + debounced edits.
5. **`ask` tool** — inline-keyboard questions round-trip.

Backward-compatible env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_STATE_DIR`,
`TELEGRAM_ACCESS_MODE=static`. New: `TELEGRAM_THREAD_MODE=topics|dm`,
`TELEGRAM_FORUM_CHAT_ID=<supergroup id>`.
