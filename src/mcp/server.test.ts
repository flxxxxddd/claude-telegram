import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'cli.ts')

type Response = { id?: number; result?: { serverInfo?: { name: string }; tools?: { name: string }[] } }

/**
 * Start the shim, speak MCP to it, and collect what it says back.
 *
 * This is the one test that runs the shim as Claude Code runs it — as a
 * subprocess owning stdio. It exists because the shim once connected its
 * transport and then exited immediately, which every unit test passed straight
 * through and every client reported only as `CONNECTION_CLOSED`.
 */
async function handshake(requests: unknown[]): Promise<Response[]> {
  // A scratch state directory: the shim starts a daemon when it finds none, and
  // a test must never touch the real bot's socket, token or topics. There is no
  // token here, so the daemon it starts exits on its own.
  const state = mkdtempSync(join(tmpdir(), 'cctg-mcp-'))
  const child = spawn('bun', [CLI, 'mcp'], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, TELEGRAM_STATE_DIR: state },
  })
  let buffered = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => (buffered += chunk))

  for (const request of requests) {
    child.stdin.write(`${JSON.stringify(request)}\n`)
    await Bun.sleep(400)
  }
  await Bun.sleep(400)
  child.kill()

  return buffered
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Response)
}

test('the shim completes an MCP handshake and stays open for the next request', async () => {
  const responses = await handshake([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ])

  const initialized = responses.find(r => r.id === 1)
  expect(initialized?.result?.serverInfo?.name).toBe('claude-telegram')

  // The second request is the point: a shim that exits once its transport is
  // connected answers the first and is gone before the second arrives.
  const tools = responses.find(r => r.id === 2)?.result?.tools
  expect(tools?.map(t => t.name).sort()).toEqual(
    ['ask', 'download_attachment', 'edit_message', 'react', 'reply', 'status'],
  )
}, 15_000)
