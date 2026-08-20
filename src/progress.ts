/**
 * Live generation progress, fed by ComfyUI's WebSocket. The server broadcasts
 * `progress` events ({value, max, node, prompt_id}) to every connected client,
 * so one shared socket tracks progress for all queue tasks — including ones
 * the plugin did not submit. Progress is best-effort: a remote server behind
 * an authenticating proxy (or one that never connects) simply shows queue
 * tasks without a progress bar. Reconnects on drop until dispose.
 */

export interface RunProgress {
  value: number
  max: number
  node: number | null
}

export class ProgressTracker {
  private readonly progress = new Map<string, RunProgress>()
  private socket: WebSocket | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = true

  /** Current progress for one prompt, if the server reported any. */
  get(promptId: string): RunProgress | undefined {
    return this.progress.get(promptId)
  }

  /** Start listening on the server's /ws endpoint. Idempotent per url. */
  attach(wsUrl: string): void {
    this.stopped = false
    this.connect(wsUrl)
  }

  private connect(wsUrl: string): void {
    if (this.stopped) return
    let socket: WebSocket
    try {
      socket = new WebSocket(wsUrl)
    } catch {
      this.scheduleRetry(wsUrl)
      return
    }
    this.socket = socket
    socket.addEventListener('message', (event) => this.onMessage(event.data))
    socket.addEventListener('close', () => {
      if (this.socket === socket) this.socket = null
      this.scheduleRetry(wsUrl)
    })
    socket.addEventListener('error', () => {
      try {
        socket.close()
      } catch {
        // close already in flight
      }
    })
  }

  private onMessage(data: unknown): void {
    let message: { type?: unknown; data?: Record<string, unknown> } | null = null
    try {
      message = JSON.parse(String(data)) as { type?: unknown; data?: Record<string, unknown> }
    } catch {
      return
    }
    if (message?.type !== 'progress' || !isObject(message.data)) return
    const promptId = message.data.prompt_id
    const value = message.data.value
    const max = message.data.max
    if (typeof promptId !== 'string' || promptId === '' || typeof value !== 'number' || typeof max !== 'number') return
    this.progress.set(promptId, {
      value,
      max,
      node: typeof message.data.node === 'number' ? message.data.node : null,
    })
  }

  private scheduleRetry(wsUrl: string): void {
    if (this.stopped || this.retryTimer !== null) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect(wsUrl)
    }, 3_000)
  }

  dispose(): void {
    this.stopped = true
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.socket !== null) {
      try {
        this.socket.close()
      } catch {
        // already closed
      }
      this.socket = null
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
