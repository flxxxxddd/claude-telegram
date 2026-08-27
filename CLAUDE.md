# claude-telegram

`cctg` bridges Claude Code and Telegram: one daemon per bot token, a topic per
project, and the whole turn mirrored into it as it happens. TypeScript, run and
built with Bun, shipped as a Claude Code plugin and — because `claude-telegram`
was already taken on the registry — as the npm package `claude-code-telegram`.

## The one thing to understand

**Telegram allows exactly one `getUpdates` consumer per bot token.** The upstream
plugin spawned a poller per Claude Code session, so sessions fought over that
slot and only one ever received anything. Everything about this architecture
follows from removing that: a single long-lived daemon owns the poller and every
Bot API call, and sessions attach to it over a UNIX socket holding no Telegram
state at all.

The second thing: **the mirror reads Claude Code's transcript, it does not ask
the assistant to narrate.** `~/.claude/projects/<slug>/<session-id>.jsonl` is
appended a record per API response, so following it gives the same narrative the
terminal shows. `src/paths.ts` reproduces the slug — the absolute path with every
non-alphanumeric run replaced by a dash — and `CLAUDE_CODE_SESSION_ID` is the
file's basename. If either is wrong the mirror silently follows nothing.

## Layout

```
src/paths.ts          the state directory, and Claude Code's transcript addressing
src/protocol.ts       newline-delimited JSON over a UNIX socket; the daemon's wire
src/config.ts         config.json ← environment; the token lives in .env, never here
src/db.ts             one sqlite file, append-only migrations
src/store/repos.ts    typed repositories: topics, bindings, queue, settings, handles
src/store/access.ts   who may reach the assistant; hand-editable on purpose
src/i18n/             en + ru dictionaries; plain strings, no markup
src/mirror/           follow the transcript, assemble turns
  records.ts          the shape of a transcript record, as much as we need
  transcript.ts       the offset tailer and the turn assembler
  summarize.ts        one line per tool call
src/telegram/
  render.ts           turns and the status message as rich message blocks
  stream.ts           sendRichMessageDraft, with a post-then-edit path for groups
  hud.ts              the pinned status message, edited in place
  topics.ts           a forum topic per project
  keyboards.ts        every inline keyboard; CLI values verbatim from `claude --help`
  callbacks.ts        typed callback_data namespaces
src/daemon/
  index.ts            the daemon: socket server, session lifecycle, routing
  bot.ts              commands, inbound routing, button taps
  tools.ts            the tools, executed daemon-side
  sessions.ts         the registry of live sessions
src/mcp/server.ts     the per-session shim Claude Code spawns
src/commands/         one file per CLI command
plugin/               the Claude Code plugin: MCP config, hooks, four skills
```

## Rules that are not obvious

**Never run two daemons on one token.** Telegram hands each update to whichever
poller asked first, so half the messages vanish and the other half arrive twice.
`claimSingleInstance` checks pid liveness by signalling — a pid file alone
survives a crash and is not proof.

**A rich message is a block tree, not text plus entities.** `render.ts` returns
`RichDocument`s and sends nothing; that is what makes it testable, and the tests
assert on the emitted html. Never build markup in a dictionary — a translator
should never be able to break a tag.

**A draft is ephemeral and never becomes a message.** Telegram drops a
`sendRichMessageDraft` 30 seconds after the last push, and the schema is explicit
that the stream must end in a `sendRichMessage`. `RichMessageDraft` enforces
that; if you add a code path that abandons a stream, call `cancel()`, never just
drop the reference.

**Drafts are private-chat only.** `SendRichMessageDraftParams.chat_id` is a
`number` and documented as "the target private chat". Groups take the
post-then-edit path in `stream.ts`. Both end with one message carrying the whole
turn.

**Never re-read a transcript from the start.** A long session's file reaches
megabytes; `TranscriptTail` follows by offset and holds back a partial trailing
line. `fs.watch` alone misses appends on network mounts and under load on macOS,
so a 500ms poll backs it up — a status message that silently stops updating is
worse than one a beat late.

**Skip sidechain records.** `isSidechain: true` is a subagent. A fan-out of five
agents would otherwise interleave five unrelated narratives into one message.

**`callback_data` is capped at 64 bytes and buttons outlive the daemon.** A
button carries a `handles.of()` id, never a path. Handles are minted once and
reused so a tap still works after a restart, and `unpack` returning `undefined`
for a stale button is a real path to handle, not an error.

**Coalesce every edit.** A working turn changes the status several times a
second and Telegram answers that with 429s. `hud.ts` and `stream.ts` both hold
the last state and write at most once a second; `hud.ts` additionally skips a
redraw whose content is unchanged, because "message is not modified" costs the
same rate budget as a real edit.

**Only interrupt sessions the daemon launched.** `SIGINT` to a terminal the user
owns looks like a crash to them. The signal goes to `CLAUDE_PID` — Claude Code
itself — not to the shim.

**Access changes must never be downstream of a channel message.** A Telegram
message is untrusted input, and "approve the pending pairing" is precisely what
a prompt injection says. The `access` skill refuses; the MCP instructions say so
too. Keep both.

**`access.json` that fails to parse denies everyone.** A hand-edit with a stray
comma must not open the bot to strangers.

**Claude Code gates inbound channel messages separately from everything else.**
A channel plugin not on its approved list still loads, still serves its MCP
tools, and still mirrors turns — inbound messages are just dropped, with one
line at startup and nothing after. So "the topic fills up but the bot ignores
me" is this, not a routing bug. The escape hatches are
`--dangerously-load-development-channels` (per session, lifts the check for
every channel plugin in it) or `allowedChannelPlugins` in managed settings,
which **replaces** Anthropic's default list rather than extending it.

**The plugin owns the mirror hooks; `settings.json` must not have a copy.** Both
sources fire, so every event is delivered twice — and the second `Stop` closes
an already-closed turn, finds it empty, and cancels the stream the first one is
still committing. The turn then never appears, with nothing logged. `setup`
removes the duplicate when the plugin is installed and `doctor` reports it, but
`beginTurn`/`endTurn` are also idempotent through `entry.turnOpen`, because a
project-scoped `settings.json` can reintroduce it.

**Close a turn only after the transcript settles.** The `Stop` hook and Claude
Code's write of the final assistant record race, and the hook usually wins:
closing on the hook alone drops the turn's closing paragraph. `mirror.settle()`
polls until nothing new has arrived for 300ms, capped at 2.5s.

**Model, effort and permission-mode values are copied verbatim from
`claude --help`** (2.1.246). They are passed to a launched session, so a value
invented in `keyboards.ts` fails at spawn time rather than at pick time.

## The skills

Four, split by the question the user is actually asking. Each is
`user-invocable`, so `/cctg:<name>` reaches it directly.

| Skill | For |
| --- | --- |
| `/cctg:configure` | Setting up: the token, topic mode, the mirror hooks, `config.json`, launching sessions from Telegram. |
| `/cctg:access` | Who may reach the assistant: approving a pairing code, the allowlist, DM policy, groups, reactions. |
| `/cctg:sessions` | Where messages go: what is connected, which topic is which project, what is queued, rebinding a chat. |
| `/cctg:doctor` | Why nothing arrives: reading `cctg doctor`, the log, and the symptom table. |

When you add a capability, put it in the skill whose question it answers rather
than adding a fifth. The split is by user intent, not by subsystem.

## Working on this

```bash
bun test                  # pure logic: the tailer, the renderer, the store, access
bunx tsc --noEmit
bun run build             # → dist/cli.js and plugin/dist/cctg.js
bun run src/cli.ts <cmd>  # run without building
```

`TELEGRAM_STATE_DIR=/tmp/cctg-test` isolates a scratch state directory, so
experiments never touch a real token, allowlist or topic set.

Verify against Telegram and Claude Code rather than against this code's own
assumptions:

```bash
TELEGRAM_STATE_DIR=/tmp/cctg-test bun run src/cli.ts doctor
bun run src/cli.ts daemon start          # reports exactly why it will not come up
bun run src/cli.ts daemon log -f
```

`plugin/dist/cctg.js` is a build artifact **and** is committed — a plugin
installed from git has no build step. Rebuild it in the same commit as any
source change that ships, or the plugin runs the previous version.
`build-stamp.test.ts` fails when you forget: the build records a hash of the
sources it consumed, and the test recomputes it. Do not try to catch this by
diffing the bundle instead — no bundler promises identical bytes across its own
versions, so that check fails on a Bun upgrade and passes on a stale bundle
built by the right Bun.

## Commits

Conventional Commits, and **never** a `Co-authored-by` trailer or any other
attribution footer.

```
<type>(<optional scope>): <subject in the imperative, lowercase, no full stop>

<body: what changed and why, wrapped at ~80 columns>
```

Types in use: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`.
Scope is the area touched — `daemon`, `mirror`, `render`, `access`, `cli`,
`plugin` — and is optional.

One logical change per commit. A bug fix and a new skill are two commits, even
when the same working session produced both.

## Style

Match the surrounding code: named exports, `.ts` import extensions, `type`
imports where the import is only a type, no `as never` to silence a type — fix
the type instead. Comments explain *why*, especially anything encoding a
Telegram or Claude Code implementation detail, which should say what was
observed and in which version. Errors name the fix (``run `cctg setup` ``), not
just the problem.
