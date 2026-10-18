/**
 * Tool cards for comfyui_run and comfyui_workflow (tool.call.toolview, keys
 * 'comfyui_run' / 'comfyui_workflow'). Running calls show the workflow name
 * and live progress (polled from /comfyui/queue); settled calls show status
 * and the output files as links. The media itself is NOT rendered here: the
 * model pastes it into its reply (see CLAUDE.md contract 18) — dsh 0.2
 * collapses finished tool rows and PTC mode shows no card at all, so an image
 * wall here was either invisible or a duplicate of the reply.
 */
import { createElement as h, useEffect, useState } from 'react'

interface MediaItem {
  filename: string
  subfolder: string
  type: string
  node: string
  index: number
  kind: 'image' | 'video' | 'audio' | 'other'
  url: string
}

interface SyncMeta {
  kind: 'sync'
  promptId: string
  status: 'completed' | 'interrupted'
  elapsedMs: number
  media: MediaItem[]
  summary: string
}

interface BackgroundMeta {
  kind: 'background'
  jobId: string
  promptId: string
  label: string
}

type RunMeta = SyncMeta | BackgroundMeta

/** Settled tool-result node (structural slice of the wire ToolCallBlock). */
interface ToolResultNode {
  kind: 'tool-result'
  call?: { name: string; argsRaw: string } | null
  isError?: boolean
  error?: { name?: string; code?: string }
  meta?: unknown
}

/** Running tool-call node (structural slice). */
interface RunningToolCall {
  callId: string
  name: string
  argsRaw: string
}

type Block = ToolResultNode | RunningToolCall

/** Discriminate the settled result node from a running call. */
function isResultNode(block: Block): block is ToolResultNode {
  return (block as ToolResultNode).kind === 'tool-result'
}

export interface ComfyUICardProps {
  t: (key: string, ...rest: unknown[]) => string
  block: Block
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** The output files as links (the images themselves are in the model's reply). */
function MediaLinks({ media, t }: { media: MediaItem[]; t: ComfyUICardProps['t'] }): ReturnType<typeof h> {
  if (media.length === 0) return h('div', { className: 'dsc-meta' }, t('cardEmpty'))
  return h('div', { className: 'dsc-files' },
    h('span', { className: 'dsc-meta' }, t('cardInReply')),
    media.map((item) => h('a', {
      key: `${item.node}-${item.index}-${item.filename}`,
      className: 'dsc-file',
      href: item.url,
      target: '_blank',
      rel: 'noreferrer',
      title: item.filename,
    }, item.filename)),
  )
}

/** Where one of our prompts stands in ComfyUI's queue. */
type QueueState =
  | { phase: 'pending'; ahead: number }
  | { phase: 'running'; value: number; max: number }

interface QueueEntry { promptId: string; ours: boolean; progress: { value: number; max: number } | null }

/**
 * Poll /comfyui/queue (every 2 s while `active`) for one prompt's queue
 * position and sampler progress. A running sync call does not know its
 * prompt id yet, so without one this follows the first prompt of ours that
 * is running (else pending) — sync calls block, so that is the call's own.
 */
function useQueueState(promptId: string | undefined, active: boolean): QueueState | null {
  const [state, setState] = useState<QueueState | null>(null)
  useEffect(() => {
    if (!active) return undefined
    let stopped = false
    let timer: number | undefined
    const poll = async (): Promise<void> => {
      try {
        const response = await fetch('/comfyui/queue', { headers: { accept: 'application/json' } })
        const data = (await response.json()) as { ok?: boolean; running?: QueueEntry[]; pending?: QueueEntry[] }
        if (stopped) return
        const running = data.running ?? []
        const pending = data.pending ?? []
        const match = (entry: QueueEntry): boolean => promptId !== undefined ? entry.promptId === promptId : entry.ours
        const run = running.find(match)
        const waitIndex = pending.findIndex(match)
        if (run !== undefined) {
          setState({ phase: 'running', value: run.progress?.value ?? 0, max: run.progress?.max ?? 0 })
        } else if (waitIndex >= 0) {
          setState({ phase: 'pending', ahead: running.length + waitIndex })
        } else {
          setState(null)
        }
      } catch {
        // Best-effort: keep the last known state and try again.
      }
      if (!stopped) timer = window.setTimeout(() => { void poll() }, 2_000)
    }
    void poll()
    return () => {
      stopped = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [promptId, active])
  return state
}

function ProgressLine({ state, t }: { state: QueueState | null; t: ComfyUICardProps['t'] }): ReturnType<typeof h> {
  if (state === null) return h('div', { className: 'dsc-meta' }, t('cardWaiting'))
  if (state.phase === 'pending') return h('div', { className: 'dsc-meta' }, t('cardQueued', { n: state.ahead }))
  const percent = state.max > 0 ? Math.min(100, Math.round((state.value / state.max) * 100)) : 0
  return h('div', { className: 'dsc-progress' },
    h('div', { className: 'dsc-progress-track' }, h('div', { className: 'dsc-progress-fill', style: { width: `${percent}%` } })),
    h('span', { className: 'dsc-meta' }, state.max > 0 ? t('cardStep', { value: state.value, max: state.max }) : t('cardWaiting')),
  )
}

/** A saved workflow's name by id, for the running card of comfyui_workflow run. */
function useWorkflowName(id: string | undefined): string | undefined {
  const [name, setName] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (id === undefined) return undefined
    let stopped = false
    void fetch('/comfyui/workflows', { headers: { accept: 'application/json' } })
      .then(async (response) => (await response.json()) as { workflows?: Array<{ id: string; name: string }> })
      .then((data) => {
        const found = data.workflows?.find((workflow) => workflow.id === id)
        if (!stopped && found !== undefined) setName(found.name)
      })
      .catch(() => undefined)
    return () => { stopped = true }
  }, [id])
  return name
}

function ResultCard({ title, result, t }: {
  title: string
  result: SyncMeta
  t: ComfyUICardProps['t']
}): ReturnType<typeof h> {
  const failed = result.status === 'interrupted'
  return h('div', { className: 'dsc-card' },
    h('div', { className: 'dsc-card-head' },
      title !== '' ? h('span', { className: 'dsc-badge' }, title) : null,
      h('span', { className: failed ? 'dsc-badge dsc-badge--err' : 'dsc-badge dsc-badge--ok' },
        failed ? t('cardInterrupted') : result.status),
      h('span', { className: 'dsc-meta' }, `${t('cardPrompt')} ${result.promptId}`),
      h('span', { className: 'dsc-meta' }, `${t('cardElapsed')} ${result.elapsedMs} ms`),
    ),
    h('div', { className: 'dsc-meta' }, result.summary),
    h(MediaLinks, { media: result.media, t }),
  )
}

/** Transient-failure retry budget for the jobs/media poll (backoff steps). */
const POLL_MAX_FAILURES = 20
/** 'unknown' grace polls (~5 min at 3 s) before treating history as evicted.
 * The route answers 'queued' while ComfyUI still holds the prompt, so this
 * only counts polls where the job is in neither history nor the queue. */
const POLL_UNKNOWN_GRACE = 100

function BackgroundCard({ label, promptId, t }: {
  label: string
  promptId: string
  t: ComfyUICardProps['t']
}): ReturnType<typeof h> {
  // The tool returns immediately with a background job; this card polls the
  // job's history entry and, once completed, renders the collected media in
  // place (same wall as a sync result). Transient route failures (ComfyUI
  // restarting, proxy hiccup) retry with backoff instead of silently freezing
  // at "collecting"; an evicted history (server restart / clear) falls back to
  // the plugin's asset index — which records every completed run's media with
  // healed proxy URLs — and settles instead of polling forever.
  const [result, setResult] = useState<{ status: string; media?: MediaItem[]; error?: string; recovered?: boolean } | null>(null)
  const queue = useQueueState(promptId, result === null)

  useEffect(() => {
    let stopped = false
    let timer: number | undefined
    let failures = 0
    let unknowns = 0
    const schedule = (delay: number, fn: () => void): void => {
      timer = window.setTimeout(fn, delay)
    }
    const recoverFromAssets = async (): Promise<MediaItem[] | null> => {
      try {
        const response = await fetch('/comfyui/assets', { headers: { accept: 'application/json' } })
        const data = (await response.json()) as { ok?: boolean; assets?: Array<{ promptId: string; media?: MediaItem[] }> }
        if (stopped || data.ok !== true || !Array.isArray(data.assets)) return null
        const asset = data.assets.find((entry) => entry.promptId === promptId)
        const media = asset?.media ?? []
        return media.length > 0 ? media : null
      } catch {
        return null
      }
    }
    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(`/comfyui/jobs/media?promptId=${encodeURIComponent(promptId)}`, { headers: { accept: 'application/json' } })
        const data = (await response.json()) as { ok?: boolean; status?: string; media?: MediaItem[]; error?: string }
        if (stopped) return
        if (data.ok !== true || data.status === undefined) {
          throw new Error(data.error ?? 'invalid jobs/media response')
        }
        failures = 0
        if (data.status === 'completed' || data.status === 'failed') {
          setResult({ status: data.status, media: data.media, error: data.error })
          return
        }
        if (data.status === 'unknown') {
          // In neither history nor the queue: evicted (server restart /
          // clear) or lost. A completed run is in the asset index, so try
          // that before giving up.
          unknowns += 1
          const recovered = await recoverFromAssets()
          if (stopped) return
          if (recovered !== null) {
            setResult({ status: 'completed', media: recovered, recovered: true })
            return
          }
          if (unknowns > POLL_UNKNOWN_GRACE) {
            setResult({ status: 'completed', media: [] })
            return
          }
          schedule(3_000, () => { void poll() })
          return
        }
        // queued / running: the job is alive, so the eviction grace restarts.
        unknowns = 0
        schedule(3_000, () => { void poll() })
      } catch (error) {
        if (stopped) return
        failures += 1
        if (failures > POLL_MAX_FAILURES) {
          const message = error instanceof Error ? error.message : String(error)
          setResult({ status: 'failed', error: t('cardPollStalled', { n: POLL_MAX_FAILURES, message }) })
          return
        }
        schedule(Math.min(3_000 * failures, 30_000), () => { void poll() })
      }
    }
    void poll()
    return () => {
      stopped = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [promptId, t])

  if (result !== null && (result.status === 'completed' || result.status === 'failed')) {
    const media = result.media ?? []
    return h('div', { className: 'dsc-card' },
      h('div', { className: 'dsc-card-head' },
        h('span', { className: result.status === 'failed' ? 'dsc-badge dsc-badge--err' : 'dsc-badge dsc-badge--ok' },
          result.status === 'failed' ? t('cardFailed') : t('cardBackgroundDone')),
        h('span', { className: 'dsc-meta' }, `${label} · ${promptId}`),
      ),
      result.status !== 'failed' && result.recovered === true
        ? h('div', { className: 'dsc-meta' }, t('cardRecovered'))
        : null,
      result.status === 'failed'
        ? h('div', { className: 'dsc-meta dsc-job-error' }, result.error ?? t('cardFailed'))
        : h(MediaLinks, { media, t }),
    )
  }

  return h('div', { className: 'dsc-card' },
    h('div', { className: 'dsc-card-head' },
      h('span', { className: 'dsc-badge' }, t('cardBackground')),
      h('span', { className: 'dsc-meta' }, `${label} · ${promptId}`),
    ),
    h(ProgressLine, { state: queue, t }),
  )
}

/** meta of a comfyui_workflow call (action: run / list / get). */
type WorkflowMeta = {
  action: 'run'
  id: string
  workflowName?: string
  result?: SyncMeta
  background?: BackgroundMeta
} | {
  action: 'list'
  workflows?: unknown[]
  comfyuiWorkflows?: unknown[]
} | {
  action: 'get'
  id?: string
  name?: string
}

function SettledCard({ block, t }: { block: ToolResultNode; t: ComfyUICardProps['t'] }): ReturnType<typeof h> {
  if (block.isError === true) {
    return h('div', { className: 'dsc-card' },
      h('div', { className: 'dsc-card-head' },
        h('span', { className: 'dsc-badge dsc-badge--err' }, t('cardFailed')),
      ),
      h('div', { className: 'dsc-meta' }, block.error?.name ?? 'error'),
    )
  }
  const meta = block.meta as RunMeta | WorkflowMeta | undefined
  if (meta === undefined || typeof meta !== 'object') {
    return h('div', { className: 'dsc-card' }, h('span', { className: 'dsc-badge' }, block.call?.name ?? 'comfyui'))
  }
  // comfyui_workflow: action-shaped meta.
  if ('action' in meta) {
    if (meta.action === 'run') {
      if (meta.background !== undefined) {
        return h(BackgroundCard, { label: meta.workflowName ?? '', promptId: meta.background.promptId, t })
      }
      if (meta.result !== undefined) {
        return h(ResultCard, { title: meta.workflowName ?? '', result: meta.result, t })
      }
    }
    if (meta.action === 'list') {
      const runs = meta.workflows?.length ?? 0
      const graphs = meta.comfyuiWorkflows?.length ?? 0
      return h('div', { className: 'dsc-card' },
        h('div', { className: 'dsc-card-head' }, h('span', { className: 'dsc-badge' }, 'comfyui_workflow')),
        h('div', { className: 'dsc-meta' }, t('cardListed', { runs, graphs })),
      )
    }
    if (meta.action === 'get') {
      return h('div', { className: 'dsc-card' },
        h('div', { className: 'dsc-card-head' }, h('span', { className: 'dsc-badge' }, 'comfyui_workflow')),
        h('div', { className: 'dsc-meta' }, meta.name ?? meta.id ?? 'get'),
      )
    }
    return h('div', { className: 'dsc-card' }, h('span', { className: 'dsc-badge' }, 'comfyui_workflow'))
  }
  // comfyui_run: kind-shaped meta.
  if (meta.kind === 'background') {
    return h(BackgroundCard, { label: meta.label, promptId: meta.promptId, t })
  }
  return h(ResultCard, { title: '', result: meta, t })
}

/** A call still running: what is generating, and how far along it is. */
function RunningCard({ block, t }: { block: RunningToolCall; t: ComfyUICardProps['t'] }): ReturnType<typeof h> {
  const args = parseArgs(block.argsRaw)
  const isRun = block.name === 'comfyui_run' || args.action === 'run'
  const workflowId = block.name === 'comfyui_workflow' && typeof args.id === 'string' ? args.id : undefined
  const savedName = useWorkflowName(isRun ? workflowId : undefined)
  // Async calls return at once; their progress lives on the background card.
  const queue = useQueueState(undefined, isRun && args.mode !== 'async')
  if (!isRun) {
    return h('div', { className: 'dsc-card' },
      h('div', { className: 'dsc-card-head' },
        h('span', { className: 'dsc-badge' }, block.name),
        typeof args.action === 'string' ? h('span', { className: 'dsc-meta' }, args.action) : null,
      ),
    )
  }
  const title = block.name === 'comfyui_run' ? t('cardHandWritten') : savedName ?? workflowId ?? ''
  return h('div', { className: 'dsc-card' },
    h('div', { className: 'dsc-card-head' },
      h('span', { className: 'dsc-badge' }, t('cardGenerating')),
      title !== '' ? h('span', { className: 'dsc-meta' }, `${t('cardWorkflow')} ${title}`) : null,
      h('span', { className: 'dsc-meta' }, `${t('cardMode')} ${String(args.mode ?? 'sync')}`),
    ),
    args.mode === 'async' ? null : h(ProgressLine, { state: queue, t }),
  )
}

/** The card component: picks running vs settled rendering from the block. */
export function ComfyUICard({ t, block }: ComfyUICardProps): ReturnType<typeof h> {
  if (isResultNode(block)) {
    return h(SettledCard, { block, t })
  }
  return h(RunningCard, { block, t })
}
