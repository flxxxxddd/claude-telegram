/**
 * Round-trips that block a session until the user taps a button: a permission
 * request Claude Code raised, and an `ask` question the assistant asked.
 *
 * Both time out. A session waiting forever on a tap that never comes is worse
 * than one told nobody answered — the terminal is still there, and Claude Code
 * falls back to it once the tool call returns.
 */

export type PendingAsk = {
  id: string
  sessionId: string
  options: string[]
  resolve: (choice: string) => void
  chatId: string
  messageId?: number
  timer: ReturnType<typeof setTimeout>
}

export type PendingPermission = {
  /** The short ticket the buttons carry. */
  id: string
  /** Claude Code's own request id, which is what the answer must name. */
  requestId: string
  sessionId: string
  tool: string
  chatId: string
  messageId?: number
  timer: ReturnType<typeof setTimeout>
}

/** How long a question stays tappable. */
export const ASK_TIMEOUT_MS = 30 * 60 * 1000
export const PERMISSION_TIMEOUT_MS = 30 * 60 * 1000

export class PendingStore {
  private asks = new Map<string, PendingAsk>()
  private permissions = new Map<string, PendingPermission>()

  addAsk(ask: Omit<PendingAsk, 'timer'>, onTimeout: (ask: PendingAsk) => void): PendingAsk {
    const timer = setTimeout(() => {
      const live = this.asks.get(ask.id)
      if (!live) return
      this.asks.delete(ask.id)
      onTimeout(live)
    }, ASK_TIMEOUT_MS)
    timer.unref?.()
    const entry: PendingAsk = { ...ask, timer }
    this.asks.set(ask.id, entry)
    return entry
  }

  takeAsk(id: string): PendingAsk | undefined {
    const entry = this.asks.get(id)
    if (!entry) return undefined
    clearTimeout(entry.timer)
    this.asks.delete(id)
    return entry
  }

  addPermission(
    permission: Omit<PendingPermission, 'timer'>,
    onTimeout: (p: PendingPermission) => void,
  ): PendingPermission {
    const timer = setTimeout(() => {
      const live = this.permissions.get(permission.id)
      if (!live) return
      this.permissions.delete(permission.id)
      onTimeout(live)
    }, PERMISSION_TIMEOUT_MS)
    timer.unref?.()
    const entry: PendingPermission = { ...permission, timer }
    this.permissions.set(permission.id, entry)
    return entry
  }

  takePermission(id: string): PendingPermission | undefined {
    const entry = this.permissions.get(id)
    if (!entry) return undefined
    clearTimeout(entry.timer)
    this.permissions.delete(id)
    return entry
  }

  /** Anything still waiting on a session that just went away. */
  dropSession(sessionId: string): { asks: PendingAsk[]; permissions: PendingPermission[] } {
    const asks = [...this.asks.values()].filter(a => a.sessionId === sessionId)
    const permissions = [...this.permissions.values()].filter(p => p.sessionId === sessionId)
    for (const a of asks) this.takeAsk(a.id)
    for (const p of permissions) this.takePermission(p.id)
    return { asks, permissions }
  }

  get pendingAsks(): number {
    return this.asks.size
  }

  get pendingPermissions(): number {
    return this.permissions.size
  }
}
