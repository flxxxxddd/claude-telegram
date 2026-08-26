---
name: doctor
description: Diagnose the Telegram bridge when it is not working — no messages arriving, no status message, topics not being created, the daemon not starting. Use when the user says the Telegram bot is silent, broken, or behaving oddly.
user-invocable: true
allowed-tools:
  - Read
  - Bash(cctg *)
  - Bash(ls *)
  - Bash(tail *)
---

# /cctg:doctor — why the bridge is not working

Start here. It checks every link and names the fix for each broken one:

```bash
cctg doctor
```

Then read the log, which is where the daemon puts everything it could not say
in a chat:

```bash
cctg daemon log | tail -50
```

## Reading the symptoms

**"no bot token"** — `/cctg:configure`.

**"no daemon is running"** — the first Claude Code session with the channel flag
starts one. If it never appears, run `cctg daemon start` in a terminal and read
what it prints; the usual cause is another daemon already holding the socket,
which it will say outright.

**"topic mode is off"** — expected until the user enables it in @BotFather. The
bridge works without it, one session per chat.

**"0 sessions connected"** — the session is running without
`--channels plugin:claude-telegram@claude-telegram`. That flag has to be on the
command line; it cannot be set afterwards.

**"mirror hooks are not wired"** — `cctg setup --hooks`.

**Bot answers commands but the turn never appears.** The hooks fire but the
daemon cannot find the transcript. Compare `cctg status`'s reported path for the
session against the real one:

```bash
ls ~/.claude/projects/
```

The directory name is the project path with every non-alphanumeric run replaced
by a dash. A mismatch means the session's `cwd` differs from what the hook
reports — usually a symlinked path.

**Messages arrive twice, or not at all.** Two daemons are polling one token.
Telegram gives each update to whoever asked first, so half of them vanish.
`cctg daemon stop` twice, then `cctg daemon start`.

**Everything works but nothing is pinned.** The bot needs permission to pin. In
a DM that is automatic; in a group it is an admin right.

## When you have to look at the raw state

```bash
cctg doctor | tail -1     # the state directory
```

It holds `.env` (the token), `config.json` (settings), `access.json` (who is
allowed), `cctg.db` (topics, bindings, queue, settings, history) and
`daemon.log`. Deleting `cctg.db` is safe — topics are recreated on next use, and
only queued messages are lost.
