/**
 * Talking to a running daemon from a one-shot command.
 *
 * The CLI is not a session: it connects, asks one thing, and leaves. A daemon
 * that is not running is a normal answer here rather than an error — `cctg
 * status` has to be able to say "nothing is running".
 */

import { connect } from 'node:net'
import { paths } from '../paths.ts'
import { frame, type ClientMsg, type DaemonMsg, type DaemonStatus } from '../protocol.ts'

const TIMEOUT_MS = 3000

/** Ask the daemon for its status, or `null` when none is listening. */
export function askStatus(): Promise<DaemonStatus | null> {
  return request<DaemonStatus>({ t: 'status' }, msg => (msg.t === 'status' ? msg.status : undefined))
}

/** Ask the daemon to exit. Resolves to false when there was none. */
export function askStop(): Promise<boolean> {
  return new Promise(resolve => {
    const sock = connect(paths.sock)
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(value)
    }
    sock.on('connect', () => {
      sock.write(`${JSON.stringify({ t: 'stop' } satisfies ClientMsg)}\n`, () => setTimeout(() => finish(true), 150))
    })
    sock.on('error', () => finish(false))
    setTimeout(() => finish(false), TIMEOUT_MS)
  })
}

function request<T>(msg: ClientMsg, pick: (reply: DaemonMsg) => T | undefined): Promise<T | null> {
  return new Promise(resolve => {
    const sock = connect(paths.sock)
    let settled = false
    const finish = (value: T | null): void => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(value)
    }
    const send = frame<DaemonMsg>(sock, reply => {
      const value = pick(reply)
      if (value !== undefined) finish(value)
    })
    sock.on('connect', () => {
      send({ t: 'hello', kind: 'cli' })
      send(msg)
    })
    sock.on('error', () => finish(null))
    setTimeout(() => finish(null), TIMEOUT_MS)
  })
}
