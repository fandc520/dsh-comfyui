/**
 * Minimal ComfyUI HTTP API client: queue a workflow, poll history for
 * completion, read object_info/system_stats, and fetch generated media.
 * Only the endpoints dsh-comfyui needs are implemented; the server's own
 * WebSocket progress channel is deliberately unused (history polling is
 * simpler and works across proxies and remote installs).
 */
import { randomUUID } from 'node:crypto'

/** One media file produced by a workflow output node. */
export interface ComfyUIMediaRef {
  filename: string
  subfolder: string
  type: string
}

/** A media item with its locating information and proxy URL. */
export interface ComfyUIMediaItem extends ComfyUIMediaRef {
  /** Output node id that produced the item. */
  node: string
  /** Index within the node's media collection. */
  index: number
  kind: 'image' | 'video' | 'audio' | 'other'
  /** Same-origin proxy URL (web profile) or a descriptive placeholder. */
  url: string
}

/** One entry of the ComfyUI /history map. */
export interface ComfyUIHistoryEntry {
  prompt?: unknown
  outputs?: Record<string, {
    images?: ComfyUIMediaRef[]
    videos?: ComfyUIMediaRef[]
    gifs?: ComfyUIMediaRef[]
  }>
  status?: {
    status_str?: string
    completed?: boolean
    messages?: unknown[]
  }
}

/** One entry of ComfyUI's /queue: server-side generation tasks. */
export interface ComfyUIQueueItem {
  number: number
  prompt_id: string
}

/** ComfyUI /queue response: the server-side generation queue. */
export interface ComfyUIQueueView {
  queue_running: ComfyUIQueueItem[]
  queue_pending: ComfyUIQueueItem[]
}

/** A unified job from ComfyUI /api/jobs (running + pending + history). */
export interface ComfyUIJob {
  id: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'
  priority: number
  create_time: number | null
  execution_start_time?: number | null
  execution_end_time?: number | null
  execution_error?: { message?: string; exception_message?: string; node_type?: string } | null
  outputs_count: number
  previewable_outputs_count: number
  preview_output?: { filename?: string; subfolder?: string; type?: string; mediaType?: string } | null
  workflow_id?: string | null
  outputs?: Record<string, unknown>
  workflow?: { prompt: unknown; extra_data?: Record<string, unknown> }
}

/** /api/jobs list response. */
export interface ComfyUIJobsResponse {
  jobs: ComfyUIJob[]
  pagination: { offset: number; limit: number | null; total: number; has_more: boolean }
}

/** One entry of a user-data directory listing (/v2/userdata). */
export interface ComfyUIUserDataEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  modified?: number
}

/** Failure talking to the ComfyUI server. */
export class ComfyUIError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'ComfyUIError'
  }
}

function sleep(millis: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ComfyUIError('ComfyUI generation aborted'))
      return
    }
    const timer = setTimeout(resolve, millis)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new ComfyUIError('ComfyUI generation aborted'))
    }, { once: true })
  })
}

function guessContentType(filename: string): string {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.mp4')) return 'video/mp4'
  if (lower.endsWith('.webm')) return 'video/webm'
  if (lower.endsWith('.avi')) return 'video/x-msvideo'
  if (lower.endsWith('.mp3')) return 'audio/mpeg'
  if (lower.endsWith('.wav')) return 'audio/wav'
  if (lower.endsWith('.ogg')) return 'audio/ogg'
  if (lower.endsWith('.flac')) return 'audio/flac'
  if (lower.endsWith('.m4a')) return 'audio/mp4'
  if (lower.endsWith('.aac')) return 'audio/aac'
  if (lower.endsWith('.opus')) return 'audio/opus'
  return 'application/octet-stream'
}

/** The per-process client id ComfyUI uses to correlate queued prompts. */
export const CLIENT_ID = randomUUID()

/** HTTP client over the ComfyUI REST API. */
export class ComfyUIClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
    private readonly connectTimeoutMs: number,
    private readonly maxMediaBytes: number,
  ) {}

  private endpoint(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}${path}`
  }

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.connectTimeoutMs)
    try {
      const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) }
      if (this.apiKey !== undefined) headers['Authorization'] = `Bearer ${this.apiKey}`
      const response = await fetch(this.endpoint(path), { ...init, headers, signal: controller.signal })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new ComfyUIError(
          `ComfyUI ${path} failed: HTTP ${response.status}${body !== '' ? ` — ${body.slice(0, 300)}` : ''}`,
          response.status,
        )
      }
      const text = await response.text()
      if (text === '') return undefined as T
      try {
        return JSON.parse(text) as T
      } catch {
        throw new ComfyUIError(`ComfyUI ${path} returned non-JSON body`)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Upload a file (multipart body forwarded verbatim) into ComfyUI's input directory. */
  /** Forward a multipart/form-data upload body verbatim (the browser's own
   * form, field "image", as ComfyUI's /upload/image expects it). */
  async uploadFile(body: Uint8Array, contentType: string): Promise<{ name?: string; subfolder?: string; type?: string }> {
    const data = await this.request<{ name?: string; subfolder?: string; type?: string }>('/upload/image', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    })
    return data ?? {}
  }

  /**
   * Put one file into ComfyUI's input directory (images, video, audio alike).
   *
   * /upload/image only accepts multipart/form-data: posting the bytes as a
   * raw body with their own content-type answers HTTP 400, which is why
   * picking a generated file into the load area used to fail instead of
   * copying it. The form is built here so callers can pass plain bytes.
   * `overwrite` keeps a repeated pick from piling up "name (1).png" copies.
   */
  async uploadMedia(
    bytes: Uint8Array,
    filename: string,
    contentType: string,
    opts: { overwrite?: boolean; subfolder?: string; timeoutMs?: number } = {},
  ): Promise<{ name?: string; subfolder?: string; type?: string }> {
    const form = new FormData()
    form.append('image', new Blob([bytes], { type: contentType !== '' ? contentType : 'application/octet-stream' }), filename)
    form.append('overwrite', opts.overwrite === false ? 'false' : 'true')
    if (opts.subfolder !== undefined && opts.subfolder !== '') form.append('subfolder', opts.subfolder)
    // Video files are large; the connect timeout is far too tight for them.
    const data = await this.request<{ name?: string; subfolder?: string; type?: string }>(
      '/upload/image',
      { method: 'POST', body: form },
      opts.timeoutMs ?? Math.max(this.connectTimeoutMs, 120_000),
    )
    return data ?? {}
  }

  /** Queue one API-format workflow and return its prompt id. */
  async queuePrompt(    workflow: unknown,
    options: { promptId?: string; front?: boolean; extraData?: Record<string, unknown> } = {},
  ): Promise<string> {
    const payload: Record<string, unknown> = { prompt: workflow, client_id: CLIENT_ID }
    if (options.promptId !== undefined) payload['prompt_id'] = options.promptId
    if (options.front === true) payload['front'] = true
    if (options.extraData !== undefined && Object.keys(options.extraData).length > 0) {
      payload['extra_data'] = options.extraData
    }
    const data = await this.request<{ prompt_id?: string }>('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (typeof data.prompt_id !== 'string') {
      throw new ComfyUIError('ComfyUI /prompt returned no prompt_id')
    }
    return data.prompt_id
  }

  /** Read one prompt's history entry; undefined while the prompt is unknown or evicted. */
  async getHistory(promptId: string): Promise<ComfyUIHistoryEntry | undefined> {
    const data = await this.request<Record<string, ComfyUIHistoryEntry>>(`/history/${encodeURIComponent(promptId)}`)
    return data[promptId]
  }

  /** The server-side queue: running + pending prompts. */
  async getQueue(): Promise<ComfyUIQueueView> {
    // ComfyUI serializes each queue slot as [number, prompt_id, prompt, ...];
    // only the number and prompt_id are needed here.
    const raw = await this.request<{ queue_running?: unknown; queue_pending?: unknown }>('/queue')
    const parse = (list: unknown): ComfyUIQueueItem[] => {
      if (!Array.isArray(list)) return []
      const items: ComfyUIQueueItem[] = []
      for (const entry of list) {
        if (Array.isArray(entry) && typeof entry[1] === 'string' && entry[1] !== '') {
          items.push({ number: typeof entry[0] === 'number' ? entry[0] : 0, prompt_id: entry[1] })
        }
      }
      return items
    }
    return { queue_running: parse(raw.queue_running), queue_pending: parse(raw.queue_pending) }
  }

  /** Unified job list with status filters, sorting, and pagination. */
  async getJobs(options: {
    status?: Array<ComfyUIJob['status']>
    limit?: number
    offset?: number
    sortBy?: 'created_at' | 'execution_duration'
    sortOrder?: 'asc' | 'desc'
  } = {}): Promise<ComfyUIJobsResponse> {
    const params = new URLSearchParams()
    if (options.status !== undefined && options.status.length > 0) params.set('status', options.status.join(','))
    if (options.limit !== undefined) params.set('limit', String(options.limit))
    if (options.offset !== undefined) params.set('offset', String(options.offset))
    if (options.sortBy !== undefined) params.set('sort_by', options.sortBy)
    if (options.sortOrder !== undefined) params.set('sort_order', options.sortOrder)
    const query = params.toString()
    return this.request<ComfyUIJobsResponse>(`/api/jobs${query !== '' ? `?${query}` : ''}`)
  }

  /** One job by id, including its workflow prompt and outputs. */
  async getJob(jobId: string): Promise<ComfyUIJob | undefined> {
    try {
      return await this.request<ComfyUIJob>(`/api/jobs/${encodeURIComponent(jobId)}`)
    } catch (error) {
      if (error instanceof ComfyUIError && error.status === 404) return undefined
      throw error
    }
  }

  /** Remove specific prompts from the pending queue. */
  async deleteQueueItems(promptIds: string[]): Promise<void> {
    await this.request('/queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delete: promptIds }),
    })
  }

  /** Clear the entire pending queue (running job is unaffected). */
  async clearQueue(): Promise<void> {
    await this.request('/queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    })
  }

  /** Interrupt the running prompt; without an id, interrupt globally. */
  async interruptPrompt(promptId?: string): Promise<void> {
    await this.request('/interrupt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(promptId !== undefined ? { prompt_id: promptId } : {}),
    })
  }

  /** Cancel one job regardless of state (running → interrupt, pending → dequeue). */
  async cancelJob(jobId: string): Promise<{ cancelled: boolean }> {
    return this.request<{ cancelled: boolean }>(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
  }

  /** Best-effort batch cancel; finished or unknown ids are no-ops. */
  async cancelJobs(jobIds: string[]): Promise<{ cancelled: boolean }> {
    return this.request<{ cancelled: boolean }>('/api/jobs/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ job_ids: jobIds }),
    })
  }

  /** Clear or selectively delete history entries. */
  async clearHistory(): Promise<void> {
    await this.request('/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    })
  }

  /** Delete specific history entries. */
  async deleteHistory(promptIds: string[]): Promise<void> {
    await this.request('/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delete: promptIds }),
    })
  }

  /** Ask ComfyUI to unload models / free memory (per /free flags). */
  async freeMemory(options: { unloadModels?: boolean; freeMemory?: boolean } = {}): Promise<void> {
    await this.request('/free', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unload_models: options.unloadModels === true, free_memory: options.freeMemory === true }),
    })
  }

  /** List one user-data subdirectory (e.g. 'workflows') on the ComfyUI server. */
  async listUserData(subdir: string): Promise<ComfyUIUserDataEntry[]> {
    const data = await this.request<ComfyUIUserDataEntry[] | string[]>(
      `/v2/userdata?path=${encodeURIComponent(subdir)}`,
    )
    if (!Array.isArray(data)) return []
    if (typeof data[0] === 'string') {
      return (data as string[]).map((name) => ({ name, path: `${subdir}/${name}`, type: 'file' as const }))
    }
    return data as ComfyUIUserDataEntry[]
  }

  /** Read one user-data file (path relative to the user root, e.g. 'workflows/x.json'). */
  async getUserDataFile(relPath: string): Promise<unknown> {
    // The {file} route matches a single segment only, so the relative path is
    // URL-encoded (the handler unquotes it) — see app/user_manager.py.
    return this.request(`/userdata/${encodeURIComponent(relPath)}`)
  }

  /** Node definitions for workflow construction (comfyui_object_info). */
  async objectInfo(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('/object_info')
  }

  /** Server health/version probe. */
  async systemStats(): Promise<{ system?: { comfyui_version?: string } }> {
    return this.request<{ system?: { comfyui_version?: string } }>('/system_stats')
  }

  /** Ask ComfyUI to interrupt the running prompt. */
  async interrupt(): Promise<void> {
    await this.request<unknown>('/interrupt', { method: 'POST' })
  }

  /** Download one generated media file through GET /view. */
  async fetchView(ref: ComfyUIMediaRef): Promise<{ bytes: Uint8Array; contentType: string }> {
    const params = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.connectTimeoutMs)
    try {
      const headers: Record<string, string> = {}
      if (this.apiKey !== undefined) headers['Authorization'] = `Bearer ${this.apiKey}`
      const response = await fetch(this.endpoint(`/view?${params.toString()}`), { headers, signal: controller.signal })
      if (!response.ok) {
        throw new ComfyUIError(`ComfyUI /view failed: HTTP ${response.status}`)
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > this.maxMediaBytes) {
        throw new ComfyUIError(`ComfyUI media too large: ${bytes.byteLength} bytes exceeds maxMediaBytes ${this.maxMediaBytes}`)
      }
      return { bytes, contentType: response.headers.get('content-type') ?? guessContentType(ref.filename) }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Poll history until the prompt completes, fails, or the budget/signal ends.
   * Interrupts the server when the signal aborts before throwing.
   */
  async waitForCompletion(opts: {
    promptId: string
    timeoutMs: number
    pollIntervalMs: number
    signal: AbortSignal
  }): Promise<ComfyUIHistoryEntry> {
    const { promptId, timeoutMs, pollIntervalMs, signal } = opts
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (signal.aborted) {
        await this.interrupt().catch(() => undefined)
        throw new ComfyUIError(`ComfyUI generation interrupted (prompt ${promptId})`)
      }
      const entry = await this.getHistory(promptId)
      if (entry !== undefined) {
        const status = entry.status
        if (status?.status_str === 'success' || status?.completed === true || hasMedia(entry)) {
          return entry
        }
        if (status?.status_str === 'error') {
          throw new ComfyUIError(historyErrorMessage(promptId, entry))
        }
      }
      if (Date.now() >= deadline) {
        throw new ComfyUIError(`ComfyUI generation timed out after ${timeoutMs} ms (prompt ${promptId})`)
      }
      await sleep(pollIntervalMs, signal)
    }
  }
}

export function hasMedia(entry: ComfyUIHistoryEntry): boolean {
  for (const output of Object.values(entry.outputs ?? {})) {
    if ((output.images?.length ?? 0) > 0 || (output.videos?.length ?? 0) > 0 || (output.gifs?.length ?? 0) > 0) {
      return true
    }
  }
  return false
}

/** Compose a readable failure message from history status messages. */
export function historyErrorMessage(promptId: string, entry: ComfyUIHistoryEntry): string {
  const details: string[] = []
  for (const message of entry.status?.messages ?? []) {
    if (Array.isArray(message) && typeof message[0] === 'string') {
      const [, payload] = message
      if (typeof payload === 'object' && payload !== null) {
        const record = payload as Record<string, unknown>
        if (typeof record.exception_message === 'string') {
          details.push(record.exception_message.slice(0, 500))
        } else if (typeof record.exception_type === 'string') {
          details.push(record.exception_type)
        }
      }
    }
  }
  return `ComfyUI execution failed (prompt ${promptId}): ${details.join('; ') || 'unknown error'}`
}

/**
 * Build the same-origin proxy URL for one media file.
 *
 * The file is addressed by its own name/subfolder/type rather than by
 * prompt+node+index: the latter has to be resolved through ComfyUI's
 * /history, which lives in memory and is dropped on server restart or a
 * "clear history" click — after which every stored asset URL 404s even though
 * the file is still sitting in the output directory. Addressing the file
 * directly keeps old assets viewable for as long as the file exists.
 */
export function mediaProxyUrl(ref: ComfyUIMediaRef, proxyBase?: string): string {
  const query = new URLSearchParams({ file: ref.filename, subfolder: ref.subfolder ?? '', type: ref.type ?? 'output' })
  return `${proxyBase ?? ''}/comfyui/media?${query.toString()}`
}

/**
 * Collect media items from a completed history entry, in node/output order,
 * capped by maxItems. The URL is the same-origin proxy route when a web
 * server is present, otherwise the bare filename (for headless hosts).
 */
export function collectMedia(opts: {
  /** The run these outputs belong to; kept for call-site clarity and logging. */
  promptId: string
  entry: ComfyUIHistoryEntry
  maxItems: number
  proxyBase: string | undefined
}): ComfyUIMediaItem[] {
  const { entry, maxItems, proxyBase } = opts
  const items: ComfyUIMediaItem[] = []
  const AUDIO_EXT = /\.(mp3|wav|ogg|flac|m4a|aac|opus)$/i
  const VIDEO_EXT = /\.(mp4|webm|mov|mkv|avi)$/i
  for (const [node, output] of Object.entries(entry.outputs ?? {})) {
    const collections: Array<[ComfyUIMediaItem['kind'], ComfyUIMediaRef[] | undefined]> = [
      ['image', output.images],
      ['video', output.videos],
      // GIFs are displayable images (animated), not opaque "other".
      ['image', output.gifs],
    ]
    for (const [kind, refs] of collections) {
      for (const [index, ref] of (refs ?? []).entries()) {
        if (items.length >= maxItems) return items
        // Some nodes emit audio/video filenames through the image/video
        // arrays; classify them by extension so the card renders a player.
        const itemKind = AUDIO_EXT.test(ref.filename) ? 'audio' : VIDEO_EXT.test(ref.filename) ? 'video' : kind
        items.push({
          ...ref,
          node,
          index,
          kind: itemKind,
          url: proxyBase !== undefined ? mediaProxyUrl(ref, proxyBase) : ref.filename,
        })
      }
    }
  }
  return items
}
