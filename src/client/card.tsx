/**
 * Tool cards for comfyui_run and comfyui_workflow (tool.call.toolview, keys
 * 'comfyui_run' / 'comfyui_workflow'). A pure function of the frozen tool-call
 * block: running calls show a generating state, settled calls render the
 * presentationMeta payload (media wall with size labels, click-to-zoom
 * lightbox, status) that the host threaded into the session log.
 */
import { createElement as h, useEffect, useState } from 'react'
import { Lightbox } from './lightbox.js'

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

function argsSummary(args: Record<string, unknown>): string {
  const parts: string[] = []
  if (typeof args.template === 'string') parts.push(`template=${args.template}`)
  if (args.mode !== undefined && args.mode !== 'sync') parts.push(`mode=${String(args.mode)}`)
  if (parts.length === 0) parts.push('custom workflow')
  return parts.join(' · ')
}

function aspectLabel(width: number, height: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  const g = gcd(width, height)
  const rw = width / g
  const rh = height / g
  return rw <= 32 && rh <= 32 ? `${rw}:${rh}` : ''
}

function MediaItem({ item, t, onOpen }: {
  item: MediaItem
  t: ComfyUICardProps['t']
  onOpen: () => void
}): ReturnType<typeof h> {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const media = item.kind === 'video'
    ? h('video', { src: item.url, controls: true, preload: 'metadata' })
    : item.kind === 'audio'
      ? h('audio', { src: item.url, controls: true, preload: 'metadata' })
      : item.kind === 'image'
        ? failed
          ? h('span', { className: 'dsc-media-other' }, `${item.filename}（${t('cardLoadFailed')}）`)
          : h('img', {
              src: item.url,
              alt: item.filename,
              loading: 'lazy',
              className: 'dsc-media-img dsc-media-img--clickable',
              onClick: onOpen,
              onLoad: (event: { target: { naturalWidth?: number; naturalHeight?: number } }) => {
                const width = event.target.naturalWidth
                const height = event.target.naturalHeight
                if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
                  setSize({ width, height })
                }
              },
              onError: () => setFailed(true),
            })
        : h('span', { className: 'dsc-media-other' }, item.filename)
  const ratio = size === null ? null : aspectLabel(size.width, size.height)
  return h('div', { className: 'dsc-media' },
    media,
    h('div', { className: 'dsc-media-meta' },
      size !== null
        ? h('span', { className: 'dsc-media-size' }, `${size.width}×${size.height}${ratio !== '' ? ` · ${ratio}` : ''}`)
        : null,
      h('a', { href: item.url, download: item.filename, target: '_blank', rel: 'noreferrer' }, t('cardDownload')),
    ),
  )
}

function ResultCard({ title, result, t }: {
  title: string
  result: SyncMeta
  t: ComfyUICardProps['t']
}): ReturnType<typeof h> {
  const failed = result.status === 'interrupted'
  const [lightbox, setLightbox] = useState<number | null>(null)
  const urls = result.media.map((item) => item.url)
  const kinds = result.media.map((item) => item.kind)
  return h('div', { className: 'dsc-card' },
    h('div', { className: 'dsc-card-head' },
      title !== '' ? h('span', { className: 'dsc-badge' }, title) : null,
      h('span', { className: failed ? 'dsc-badge dsc-badge--err' : 'dsc-badge dsc-badge--ok' },
        failed ? t('cardInterrupted') : result.status),
      h('span', { className: 'dsc-meta' }, `${t('cardPrompt')} ${result.promptId}`),
      h('span', { className: 'dsc-meta' }, `${t('cardElapsed')} ${result.elapsedMs} ms`),
    ),
    h('div', { className: 'dsc-meta' }, result.summary),
    result.media.length > 0
      ? h('div', { className: 'dsc-grid' }, result.media.map((item, index) => h(MediaItem, {
          key: `${item.node}-${item.index}`,
          item,
          t,
          onOpen: () => setLightbox(index),
        })))
      : h('div', { className: 'dsc-meta' }, t('cardEmpty')),
    lightbox !== null
      ? h(Lightbox, { t, images: urls, kinds, index: lightbox, onClose: () => setLightbox(null), onIndex: setLightbox })
      : null,
  )
}

function BackgroundCard({ label, promptId, t }: {
  label: string
  promptId: string
  t: ComfyUICardProps['t']
}): ReturnType<typeof h> {
  // The tool returns immediately with a background job; this card polls the
  // job's history entry and, once completed, renders the collected media in
  // place (same wall as a sync result).
  const [result, setResult] = useState<{ status: string; media?: MediaItem[]; error?: string } | null>(null)
  const [lightbox, setLightbox] = useState<number | null>(null)

  useEffect(() => {
    let stopped = false
    let timer: number | undefined
    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(`/comfyui/jobs/media?promptId=${encodeURIComponent(promptId)}`, { headers: { accept: 'application/json' } })
        const data = (await response.json()) as { ok?: boolean; status?: string; media?: MediaItem[]; error?: string }
        if (stopped) return
        if (data.ok !== true || data.status === undefined) return
        if (data.status === 'completed' || data.status === 'failed') {
          setResult({ status: data.status, media: data.media, error: data.error })
          return
        }
        timer = window.setTimeout(() => { void poll() }, 3_000)
      } catch {
        timer = window.setTimeout(() => { void poll() }, 5_000)
      }
    }
    void poll()
    return () => {
      stopped = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [promptId])

  if (result !== null && (result.status === 'completed' || result.status === 'failed')) {
    const media = result.media ?? []
    const urls = media.map((item) => item.url)
    const kinds = media.map((item) => item.kind)
    return h('div', { className: 'dsc-card' },
      h('div', { className: 'dsc-card-head' },
        h('span', { className: result.status === 'failed' ? 'dsc-badge dsc-badge--err' : 'dsc-badge dsc-badge--ok' },
          result.status === 'failed' ? t('cardFailed') : t('cardBackgroundDone')),
        h('span', { className: 'dsc-meta' }, `${label} · ${promptId}`),
      ),
      result.status === 'failed'
        ? h('div', { className: 'dsc-meta dsc-job-error' }, result.error ?? t('cardFailed'))
        : media.length > 0
          ? h('div', { className: 'dsc-grid' }, media.map((item, index) => h(MediaItem, {
              key: `${item.node}-${item.index}`,
              item,
              t,
              onOpen: () => setLightbox(index),
            })))
          : h('div', { className: 'dsc-meta' }, t('cardEmpty')),
      lightbox !== null
        ? h(Lightbox, { t, images: urls, kinds, index: lightbox, onClose: () => setLightbox(null), onIndex: setLightbox })
        : null,
    )
  }

  return h('div', { className: 'dsc-card' },
    h('div', { className: 'dsc-card-head' },
      h('span', { className: 'dsc-badge' }, t('cardBackground')),
      h('span', { className: 'dsc-meta' }, `${label} · ${promptId}`),
    ),
    h('div', { className: 'dsc-meta' }, t('cardCollect')),
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

/** The card component: picks running vs settled rendering from the block. */
export function ComfyUICard({ t, block }: ComfyUICardProps): ReturnType<typeof h> {
  if (isResultNode(block)) {
    return h(SettledCard, { block, t })
  }
  const args = parseArgs(block.argsRaw)
  return h('div', { className: 'dsc-card' },
    h('div', { className: 'dsc-card-head' },
      h('span', { className: 'dsc-badge' }, t('cardGenerating')),
      h('span', { className: 'dsc-meta' }, `${t('cardWorkflow')} ${argsSummary(args)} · ${t('cardMode')} ${String(args.mode ?? 'sync')}`),
    ),
  )
}
