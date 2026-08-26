/**
 * Where cctg keeps its state, and how it addresses a Claude Code session.
 *
 * The state directory is the contract with everything else: the daemon listens
 * on a socket inside it, the CLI finds the daemon through it, and the plugin's
 * skills edit `access.json` in it. Point `TELEGRAM_STATE_DIR` somewhere else to
 * run a second bot with its own token, allowlist and topics on one machine.
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Claude Code's own config directory — where transcripts and settings live. */
export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

/** Root of every file this project writes. */
export function stateDir(): string {
  return process.env.TELEGRAM_STATE_DIR ?? join(claudeHome(), 'channels', 'telegram')
}

export const paths = {
  get state() { return stateDir() },
  get env() { return join(stateDir(), '.env') },
  get config() { return join(stateDir(), 'config.json') },
  get access() { return join(stateDir(), 'access.json') },
  get db() { return join(stateDir(), 'cctg.db') },
  get sock() { return join(stateDir(), 'daemon.sock') },
  get pid() { return join(stateDir(), 'daemon.pid') },
  get log() { return join(stateDir(), 'daemon.log') },
  get inbox() { return join(stateDir(), 'inbox') },
}

/**
 * Claude Code's transcript directory for a working directory. It slugifies the
 * absolute path by replacing every non-alphanumeric run with `-`, so
 * `/Users/me/Desktop/app` becomes `-Users-me-Desktop-app` (observed in Claude
 * Code 2.1.246). The mirror reads `<that>/<session-id>.jsonl`.
 */
export function projectTranscriptDir(cwd: string): string {
  return join(claudeHome(), 'projects', resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'))
}

/** The transcript file a session writes, derived the same way Claude Code does. */
export function transcriptPath(cwd: string, sessionId: string): string {
  return join(projectTranscriptDir(cwd), `${sessionId}.jsonl`)
}

/** Last path segment of a working directory — the human name of a project. */
export function projectName(cwd: string): string {
  return resolve(cwd).split('/').filter(Boolean).pop() ?? cwd
}
