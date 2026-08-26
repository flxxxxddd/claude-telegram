#!/usr/bin/env bun
/**
 * Plugin-local entry point for the Claude Code hook, so a plugin install can
 * point at `${CLAUDE_PLUGIN_ROOT}/hooks/hook.ts` without needing `cctg` on the
 * PATH. `cctg hook` runs the same code.
 */

import { runHook } from '../src/commands/hook.ts'

await runHook()
process.exit(0)
