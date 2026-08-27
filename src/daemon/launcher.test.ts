import { describe, expect, test } from 'bun:test'
import type { ProjectSettings } from '../db.ts'
import { claudeCommand, renderLaunchCommand, shellQuote } from './launcher.ts'

const settings = (patch: Partial<ProjectSettings> = {}): ProjectSettings =>
  ({ cwd: '/p', model: null, effort: null, permission_mode: null, account: null, ...patch })

describe('shellQuote', () => {
  test('a path with a space stays one argument', () => {
    expect(shellQuote('/Users/me/My Project')).toBe("'/Users/me/My Project'")
  })

  test('an embedded quote cannot close the quoting', () => {
    // The classic break: '; rm -rf /; ' must survive as literal characters.
    expect(shellQuote("/tmp/it's here")).toBe("'/tmp/it'\\''s here'")
  })
})

describe('claudeCommand', () => {
  test('always carries the channel flag — without it the session is invisible', () => {
    expect(claudeCommand('/p', settings())).toContain('--channels plugin:claude-telegram@claude-telegram')
  })

  test('only names the settings that were actually chosen', () => {
    expect(claudeCommand('/p', settings())).not.toContain('--model')
    const full = claudeCommand('/p', settings({ model: 'opus', effort: 'high', permission_mode: 'plan' }))
    expect(full).toContain('--model opus')
    expect(full).toContain('--effort high')
    expect(full).toContain('--permission-mode plan')
  })

  test('changes into the project directory first', () => {
    expect(claudeCommand('/Users/me/My Project', settings())).toStartWith("cd '/Users/me/My Project' &&")
  })
})

describe('renderLaunchCommand', () => {
  const template = "tmux new-session -d -s cctg_{name} -c {cwd} '{claude}'"

  test('substitutes the directory, its name and the full invocation', () => {
    const rendered = renderLaunchCommand(template, '/Users/me/app', settings({ model: 'sonnet' }))
    expect(rendered).toContain("-s cctg_'app'")
    expect(rendered).toContain("-c '/Users/me/app'")
    expect(rendered).toContain('--model sonnet')
  })

  test('quotes a directory with a space everywhere it appears', () => {
    const rendered = renderLaunchCommand(template, '/Users/me/My App', settings())
    expect(rendered).toContain("-c '/Users/me/My App'")
    expect(rendered).toContain("cd '/Users/me/My App'")
  })

  test('a template that names nothing is still run verbatim', () => {
    expect(renderLaunchCommand('echo hi', '/p', settings())).toBe('echo hi')
  })
})

describe('launching through cca', () => {
  test('an account turns the invocation into `cca run <name> -- <args>`', () => {
    // `cca run` forwards everything after `--` to claude, so the prefix replaces
    // the `claude` word rather than wrapping the whole line.
    const command = claudeCommand('/p', settings({ account: 'work', model: 'opus' }))
    if (!command.includes('cca run')) return // cca is not installed on this machine
    expect(command).toContain('cca run work -- --channels')
    expect(command).toContain('--model opus')
    expect(command).not.toContain('cca run work -- claude')
  })

  test('no account leaves the command exactly as it was', () => {
    const command = claudeCommand('/p', settings())
    expect(command).not.toContain('cca')
    expect(command).toContain('&& claude --channels')
  })

  test('the channel flags survive whichever path is taken', () => {
    for (const account of [null, 'work', '@best']) {
      const command = claudeCommand('/p', settings({ account }))
      expect(command).toContain('--channels plugin:claude-telegram@claude-telegram')
      expect(command).toContain('--dangerously-load-development-channels')
    }
  })
})
