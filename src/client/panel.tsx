/**
 * The ComfyUI panel (shell.overlay, id 'comfyui.panel'): a floating panel
 * with three tabs — workflow library management, generated asset preview,
 * and the live ComfyUI queue. Draggable by its header and resizable via the
 * corner handle; geometry persists in localStorage. Renders null while closed
 * (the overlay layer is click-through, so nothing blocks the app underneath).
 */
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { getJson, postJson, postRaw } from './api.ts'
import { panelStore, usePanelOpen, usePanelTab } from './panel-store.ts'
import { ComfyUIIcon } from './trigger.tsx'
import { Lightbox } from './lightbox.js'

/** Panel geometry: pixel position/size once the user dragged or resized. */
interface PanelGeom {
  x?: number
  y?: number
  width?: number
  height?: number
}

const GEOM_KEY = 'dsh-comfyui-panel-geom'

function loadGeom(): PanelGeom {
  try {
    const raw = localStorage.getItem(GEOM_KEY)
    if (raw === null) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const geom: PanelGeom = {}
    if (typeof parsed.x === 'number') geom.x = parsed.x
    if (typeof parsed.y === 'number') geom.y = parsed.y
    if (typeof parsed.width === 'number' && parsed.width >= 300) geom.width = parsed.width
    if (typeof parsed.height === 'number' && parsed.height >= 200) geom.height = parsed.height
    return geom
  } catch {
    return {}
  }
}

function saveGeom(geom: PanelGeom): void {
  try {
    localStorage.setItem(GEOM_KEY, JSON.stringify(geom))
  } catch {
    // storage unavailable — geometry just won't persist
  }
}

/** Default panel width from styles.ts (`.dsc-panel` width var), used only to
 * estimate the panel extent while clamping a saved position. */
const PANEL_WIDTH_FALLBACK = 400
/** Approx. height of the drag-handle band (`.dsc-panel-head`). */
const HEAD_BAND = 48
/** Minimum margin kept between the panel and the viewport edge. */
const EDGE = 8

/**
 * Clamp a top-left corner so the drag-handle band always stays inside the
 * viewport. The failure this prevents: once the header is pushed past the top
 * edge (or a saved position from a larger monitor no longer fits), there is no
 * grab surface left and the panel cannot be moved back at all.
 */
function clampPos(x: number, y: number, width: number, vw: number, vh: number): { x: number; y: number } {
  const maxX = Math.max(EDGE, vw - width - EDGE)
  const maxY = Math.max(EDGE, vh - HEAD_BAND - EDGE)
  return { x: Math.min(Math.max(x, EDGE), maxX), y: Math.min(Math.max(y, EDGE), maxY) }
}

/** Snap persisted geometry back within reach of the cursor. Geometry that
 * never carried an explicit position (the CSS-anchored default) is returned
 * unchanged; geometry already inside the safe area keeps its object identity
 * so callers can skip pointless re-renders. */
function healGeom(geom: PanelGeom, vw: number, vh: number): PanelGeom {
  if (geom.x === undefined || geom.y === undefined) return geom
  const pos = clampPos(geom.x, geom.y, geom.width ?? PANEL_WIDTH_FALLBACK, vw, vh)
  if (pos.x === geom.x && pos.y === geom.y) return geom
  return { ...geom, x: pos.x, y: pos.y }
}

interface PointerEventLike {
  pointerId: number
  clientX: number
  clientY: number
  button: number
  target: EventTarget | null
  currentTarget: EventTarget | null
}

export interface ComfyUIPanelProps {
  t: (key: string, ...rest: unknown[]) => string
}

interface MediaItem {
  filename: string
  subfolder: string
  type: string
  node: string
  index: number
  kind: 'image' | 'video' | 'audio' | 'other'
  url: string
}

interface WorkflowEntry {
  id: string
  name: string
  description: string
  workflow: Record<string, unknown>
  parameters?: WorkflowParameter[]
  tags?: string[]
  /** Skill-pack directory name; present when this workflow has a pack. */
  skillDir?: string
  /** Whether the agent must read the pack before running this workflow. */
  requireSkill?: boolean
  updatedAt: string
}

/** One file inside a workflow's skill pack. */
interface SkillPackFile {
  path: string
  size: number
  updatedAt: string
}

/** A workflow's skill pack as the routes report it. */
interface SkillPack {
  slug: string
  dir: string
  summary: string
  files: SkillPackFile[]
  /** Sub-directories present in the pack, including empty ones. */
  dirs: string[]
  totalBytes: number
  workflowId: string
  workflowName: string
  required: boolean
}

interface SkillPackResponse {
  ok?: boolean
  enabled?: boolean
  root?: string
  /** Suggested directory names; the host owns the list. */
  presetDirs?: string[]
  pack?: SkillPack | null
  error?: string
}

/** Fallback suggestions when the config route has not answered yet; the
 * authoritative list comes from the host (`presetDirs`). */
const SKILL_FALLBACK_DIRS = ['references', 'scripts', 'assets']

/** Imported binaries land in assets/; the editor previews these instead of
 * trying to read them as text. */
const SKILL_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']

function isSkillImage(path: string): boolean {
  const dot = path.lastIndexOf('.')
  return dot !== -1 && SKILL_IMAGE_EXTENSIONS.includes(path.slice(dot).toLowerCase())
}

/** Preset workflow classification tags (users can add custom ones). Stored as
 * plain text, so the tag identity is the label itself. */
const PRESET_TAGS = ['图生图', '文生图', '文生视频', '图生视频', '参考生视频', '文生音频', '参考生音频']

/** A workflow saved on the ComfyUI server (userdata/workflows). */
interface ComfyUIWorkflowEntry {
  name: string
  size?: number
  modified?: number
  /** Whether at least one runnable API workflow was extracted from this graph. */
  extracted: boolean
  /** Runnable API workflows extracted from this graph. */
  derived: Array<{ libraryId: string; name: string }>
}

/** One connected component of a ComfyUI-side graph. */
interface ComponentInfo {
  index: number
  size: number
  groups: string[]
  nodeTypes: string[]
}

/** Canvas analysis result for the extract dialog. */
interface GraphAnalysis {
  components: ComponentInfo[]
  isolated: Array<{ id: number; type: string }>
  bypassedCount: number
  mode: 'single' | 'multi'
}

type ExtractMode = 'all' | 'split' | 'main'

/** Extract-dialog state: the graph file being extracted. */
interface ExtractState {
  file: string
  analysis: GraphAnalysis | null
  error: string | null
  mode: ExtractMode
}

/** Read-only view state for a ComfyUI-side workflow. */
interface WorkflowViewState {
  file: string
  graph: Record<string, unknown>
}

interface AssetEntry {
  promptId: string
  ts: string
  workflowName: string | null
  source: string
  media: MediaItem[]
}

type JobStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'
/** History filter: 'all' shows every terminal task; others narrow it. */
type JobFilter = 'all' | 'completed' | 'failed' | 'cancelled'

/** One unified job from ComfyUI /api/jobs, as served by /comfyui/jobs. */
interface JobView {
  id: string
  status: JobStatus
  createTime: number | null
  executionStartTime: number | null
  executionEndTime: number | null
  executionError: { message?: string; exception_message?: string; node_type?: string } | null
  outputsCount: number
  previewOutput: { filename?: string; subfolder?: string; type?: string; mediaType?: string } | null
  workflowId: string | null
  workflowName: string | null
  ours: boolean
  progress: { value: number; max: number } | null
}

interface JobsView {
  ok: boolean
  error?: string
  jobs: JobView[]
  total: number
  hasMore: boolean
}

const JOB_FILTERS: Array<{ key: JobFilter; label: string }> = [
  { key: 'all', label: 'jobFilterAll' },
  { key: 'completed', label: 'jobFilterCompleted' },
  { key: 'failed', label: 'jobFilterFailed' },
  { key: 'cancelled', label: 'jobFilterCancelled' },
]

/** One adjustable parameter of a saved workflow (mirrors host WorkflowParameter). */
interface WorkflowParameter {
  id: string
  name: string
  label: string
  type: 'string' | 'number' | 'boolean'
  nodeId: string
  inputKey: string
  default: string | number | boolean
  description?: string
  random?: boolean
  /** Declared numeric type of the node input; absent = unknown (decimals ok). */
  numberKind?: 'int' | 'float'
  min?: number
  max?: number
  step?: number
  options?: Array<string | number>
  upload?: 'image' | 'video' | 'audio' | 'media'
  subfolder?: string
}

/** Editing state for a workflow: the JSON field is text while being edited. */
interface WorkflowDraft {
  id?: string
  name?: string
  description?: string
  tags?: string[]
  inputs?: string
  workflow: string | Record<string, unknown>
  parameters?: WorkflowParameter[]
  updatedAt?: string
}

function shortId(promptId: string): string {
  return promptId.length > 10 ? `${promptId.slice(0, 10)}…` : promptId
}

/** Open a job's preview image URL (via the media proxy) when it has one. */
function previewUrlOf(job: JobView): string | null {
  const preview = job.previewOutput
  if (preview === undefined || preview === null || preview.filename === undefined || preview.filename === null) return null
  return `/comfyui/media?file=${encodeURIComponent(preview.filename)}&subfolder=${encodeURIComponent(preview.subfolder ?? '')}&type=${encodeURIComponent(preview.type ?? 'output')}`
}

/** Opens a generated image in a large overlay with prev/next navigation. */

/** Whether a node input is fed by a link ([nodeId, slot]) rather than a widget value. */
function isLinkValue(value: unknown): boolean {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number'
}

/** Short description of a node input's current value, for the advanced
 * picker's dropdown. */
function inputValueKind(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return 'object'
  return typeof value
}

/** Read a parameter default as a boolean. Defaults saved before the editor
 * had a checkbox are strings ("true"/"false"), so they are coerced here rather
 * than silently reading as `true` for every non-empty string. */
function asBool(value: string | number | boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  return /^(true|1|yes|on)$/i.test(value.trim())
}

/** Tooltip for a number field: the declared type and bounds, when known. */
function numberRangeHint(param: WorkflowParameter): string {
  const parts: string[] = [param.numberKind ?? 'number']
  if (param.min !== undefined || param.max !== undefined) parts.push(`${param.min ?? '-∞'} ~ ${param.max ?? '∞'}`)
  if (param.step !== undefined) parts.push(`step ${param.step}`)
  return parts.join(' · ')
}

function newParamId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
}

/** Parse the draft workflow into a plain object (empty on invalid JSON). */
function parseDraftWorkflow(workflow: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof workflow !== 'string') return workflow
  try {
    const parsed = JSON.parse(workflow) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Custom dropdown for loader-node file lists: each option shows a small
 * server-side thumbnail (images only; <select> cannot render images).
 */
function UploadSelect(props: {
  value: string
  options: Array<string | number>
  kind: 'image' | 'video' | 'audio'
  onChange: (value: string) => void
  onRefresh?: () => Promise<Array<string | number> | undefined>
}): ReturnType<typeof h> {
  const [open, setOpen] = useState(false)
  const [live, setLive] = useState<Array<string | number> | null>(null)
  const ref = useRef<HTMLDivElement | null>(null)
  // Keep the latest refresh callback without re-running the open-effect.
  const refreshRef = useRef(props.onRefresh)
  refreshRef.current = props.onRefresh

  useEffect(() => {
    if (!open) return
    const onDoc = (event: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // Pull the live file list from the server every time the menu opens, so
  // files uploaded elsewhere show up without reloading the workflow editor.
  useEffect(() => {
    if (!open) return
    const fn = refreshRef.current
    if (fn === undefined) return
    let cancelled = false
    void fn().then((latest) => {
      if (!cancelled && latest !== undefined) setLive(latest)
    })
    return () => { cancelled = true }
  }, [open])

  const options = live ?? props.options
  const thumbUrl = (name: string | number): string | null =>
    props.kind === 'image' ? `/comfyui/media?file=${encodeURIComponent(String(name))}&type=input` : null
  const current = options.some((option) => String(option) === props.value) ? props.value : String(props.value)

  return h('div', { ref, className: 'dsc-upload-select' },
    h('button', {
      className: 'dsc-upload-select-btn',
      onClick: () => setOpen(!open),
      title: String(current),
    },
      thumbUrl(props.value) !== null
        ? h('img', { className: 'dsc-upload-select-thumb', src: thumbUrl(props.value) ?? '', alt: '', loading: 'lazy' })
        : null,
      h('span', { className: 'dsc-upload-select-name' }, String(current)),
    ),
    open
      ? h('div', { className: 'dsc-upload-select-pop' },
          options.map((option) => {
            const name = String(option)
            return h('div', {
              key: name,
              className: `dsc-upload-select-item${name === props.value ? ' dsc-upload-select-item--active' : ''}`,
              onClick: () => { props.onChange(name); setOpen(false) },
            },
              thumbUrl(option) !== null
                ? h('img', { className: 'dsc-upload-select-thumb', src: thumbUrl(option) ?? '', alt: '', loading: 'lazy' })
                : null,
              h('span', { className: 'dsc-upload-select-name' }, name),
            )
          }),
        )
      : null,
  )
}

/** Merge a freshly fetched option list with the previous one (latest first,
 * deduped) so the dropdown never drops options mid-session. */
function mergeOptions(prev: Array<string | number>, latest: Array<string | number>): Array<string | number> {
  const seen = new Set<string>()
  const out: Array<string | number> = []
  for (const item of [...latest, ...prev]) {
    const key = String(item)
    if (!seen.has(key)) { seen.add(key); out.push(item) }
  }
  return out
}

/** Copy text to the clipboard; falls back to a hidden textarea when the
 * clipboard API is unavailable (non-secure LAN http). */
function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard !== undefined) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => copyViaTextarea(text))
  }
  return Promise.resolve(copyViaTextarea(text))
}

function copyViaTextarea(text: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  document.body.removeChild(textarea)
  return ok
}

/** Read a file's pixel size in the browser (image only) and report it to the
 * plugin so the workflow output size can default to the source image. Returns
 * the size text for display, or undefined when unreadable. */
async function recordMediaSize(file: File, name: string): Promise<string | undefined> {
  try {
    const bitmap = await createImageBitmap(file)
    const width = bitmap.width
    const height = bitmap.height
    bitmap.close()
    await fetch('/comfyui/media-size', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, width, height }),
    }).catch(() => undefined)
    return `${width}×${height}`
  } catch {
    return undefined
  }
}

/** SHA-256 hex digest (pure JS — crypto.subtle needs a secure context, which a
 * LAN http origin is not). Uses the standard padding/compression; the input is
 * any byte array. */
function sha256Hex(data: Uint8Array): string {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ])
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const len = data.length
  const total = len + 1 + (((56 - ((len + 1) % 64)) + 64) % 64) + 8
  const msg = new Uint8Array(total)
  msg.set(data)
  msg[len] = 0x80
  const bitLenLo = (len * 8) >>> 0
  const bitLenHi = Math.floor(len / 0x20000000)
  const dv = new DataView(msg.buffer)
  dv.setUint32(total - 8, bitLenHi)
  dv.setUint32(total - 4, bitLenLo)
  const w = new Uint32Array(64)
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = ((w[i - 15]! >>> 7) | (w[i - 15]! << 25)) ^ ((w[i - 15]! >>> 18) | (w[i - 15]! << 14)) ^ (w[i - 15]! >>> 3)
      const s1 = ((w[i - 2]! >>> 17) | (w[i - 2]! << 15)) ^ ((w[i - 2]! >>> 19) | (w[i - 2]! << 13)) ^ (w[i - 2]! >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }
    let a = H[0]!, b = H[1]!, c = H[2]!, d = H[3]!, e = H[4]!, f = H[5]!, g = H[6]!, h = H[7]!
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0
    }
    H[0] = (H[0]! + a) >>> 0; H[1] = (H[1]! + b) >>> 0; H[2] = (H[2]! + c) >>> 0; H[3] = (H[3]! + d) >>> 0
    H[4] = (H[4]! + e) >>> 0; H[5] = (H[5]! + f) >>> 0; H[6] = (H[6]! + g) >>> 0; H[7] = (H[7]! + h) >>> 0
  }
  let out = ''
  for (let i = 0; i < 8; i++) out += H[i]!.toString(16).padStart(8, '0')
  return out
}

/** `image.png` + hash → `image_3f9a2b1c0d.png`: keeps the name readable while
 * making it content-unique, so re-uploading the same file reuses the name. */
function renameWithHash(original: string, hash: string): string {
  const short = hash.slice(0, 10)
  const dot = original.lastIndexOf('.')
  const base = dot > 0 ? original.slice(0, dot) : original
  const ext = dot > 0 ? original.slice(dot) : ''
  return `${base}_${short}${ext}`
}

/** Upload a file with content-hash naming and dedup: same bytes → same file
 * name, and (for root uploads) the existing file is reused instead of creating
 * a duplicate. Returns the file name on the ComfyUI server. */
async function uploadDedup(file: File, subfolder?: string): Promise<string> {
  const hash = sha256Hex(new Uint8Array(await file.arrayBuffer()))
  const dedup = subfolder === undefined || subfolder === ''
  if (dedup) {
    const lookup = await fetch('/comfyui/media-lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash }),
    }).then((response) => response.json() as Promise<{ ok?: boolean; found?: boolean; name?: string }>).catch(() => undefined)
    if (lookup !== undefined && lookup.ok === true && lookup.found === true && typeof lookup.name === 'string') {
      return lookup.name
    }
  }
  const renamed = new File([file], renameWithHash(file.name, hash), { type: file.type })
  const form = new FormData()
  form.append('image', renamed)
  if (!dedup) form.append('subfolder', subfolder)
  const response = await fetch('/comfyui/upload', { method: 'POST', body: form })
  const data = (await response.json()) as { ok?: boolean; name?: string; error?: string }
  if (data.ok !== true || typeof data.name !== 'string') throw new Error(data.error ?? 'upload failed')
  if (dedup) {
    await fetch('/comfyui/media-hash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash, name: data.name }),
    }).catch(() => undefined)
  }
  return data.name
}

/**
 * Parameter editor: lists the workflow's adjustable parameters (auto-detected
 * prompt/size/steps/seed) with editable name/label/default and a random
 * toggle for number parameters, plus an "advanced" picker that exposes any
 * node input as a custom parameter.
 */
function ParameterEditor(props: {
  t: ComfyUIPanelProps['t']
  params: WorkflowParameter[]
  workflow: Record<string, unknown>
  onChange: (params: WorkflowParameter[]) => void
}): ReturnType<typeof h> {
  const { t, params, workflow, onChange } = props
  const [advanced, setAdvanced] = useState(false)
  const [advNode, setAdvNode] = useState('')
  const [advInput, setAdvInput] = useState('')
  const [advLabel, setAdvLabel] = useState('')
  const [recognizing, setRecognizing] = useState(false)
  const [recognizeError, setRecognizeError] = useState<string | null>(null)
  const [uploading, setUploading] = useState<Record<string, boolean>>({})
  // Raw text of number fields while they are being typed. Parsing on every
  // keystroke would swallow an in-progress decimal ("1." → 1), which is what
  // used to make float defaults impossible to enter.
  const [numDraft, setNumDraft] = useState<Record<string, string>>({})
  const [hovered, setHovered] = useState<string | null>(null)
  // Latest params/uploadFile for the global paste listener (bound once).
  const hoverRef = useRef<string | null>(null)
  const latestRef = useRef<{ params: WorkflowParameter[]; uploadFile: (param: WorkflowParameter, file: File) => Promise<void> }>({
    params,
    uploadFile: async () => undefined,
  })

  /** Re-fetch a parameter's live option list (ComfyUI input dir files) and
   * merge it into the stored options, so uploads made anywhere show up in the
   * dropdown without reloading the workflow editor. */
  const refreshOptions = async (param: WorkflowParameter): Promise<Array<string | number> | undefined> => {
    const rawNode = (workflow as Record<string, { class_type?: string }>)[param.nodeId]
    const classType = typeof rawNode?.class_type === 'string' ? rawNode.class_type : ''
    if (classType === '') return undefined
    const result = (await postJson('/comfyui/workflows/input-options', { classType, inputKey: param.inputKey })) as
      { ok?: boolean; options?: Array<string | number> }
    if (result.ok !== true || !Array.isArray(result.options)) return undefined
    const latest = result.options
    const index = params.findIndex((entry) => entry.id === param.id)
    if (index !== -1 && params[index]?.options !== undefined) {
      update(index, { options: mergeOptions(params[index]!.options!, latest) })
    }
    return latest
  }

  /** Upload a dropped file through the plugin proxy into ComfyUI's input dir. */
  const uploadFile = async (param: WorkflowParameter, file: File): Promise<void> => {
    setUploading((prev) => ({ ...prev, [param.id]: true }))
    try {
      const name = await uploadDedup(file, param.subfolder)
      void recordMediaSize(file, name)
      const index = params.findIndex((entry) => entry.id === param.id)
      if (index !== -1) update(index, { default: name })
      void refreshOptions(param)
    } finally {
      setUploading((prev) => ({ ...prev, [param.id]: false }))
    }
  }
  latestRef.current = { params, uploadFile }

  /** Global paste: Ctrl+V with the mouse hovering an upload parameter routes
   * the clipboard file (e.g. a screenshot) to that parameter — same mental
   * model as pasting an image into a chat input. */
  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      const targetId = hoverRef.current
      if (targetId === null) return
      const file = event.clipboardData?.files?.[0]
      if (file === undefined) return
      const param = latestRef.current.params.find((entry) => entry.id === targetId)
      if (param === undefined || param.upload === undefined) return
      event.preventDefault()
      void latestRef.current.uploadFile(param, file)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [])

  /** Auto-generate the internal parameter name from the input key, deduped against existing params. */
  const genParamName = (base: string): string => {
    let name = base
    let index = 2
    while (params.some((param) => param.name === name)) name = `${base}_${index++}`
    return name
  }

  const nodeEntries = Object.entries(workflow).map(([id, raw]) => [id, raw as { class_type?: string; inputs?: Record<string, unknown> }] as const)
  const advNodeInfo = nodeEntries.find(([id]) => id === advNode)?.[1]
  // Widget-valued inputs are offered without filtering (the loader `upload`
  // pseudo-input included). Inputs currently fed by a link ([nodeId, slot])
  // are left out: they carry no value to edit, and exposing one only creates
  // a parameter that would fight the connection.
  const advInputs = advNodeInfo !== undefined && advNodeInfo.inputs !== undefined
    ? Object.entries(advNodeInfo.inputs).filter(([, value]) => !isLinkValue(value))
    : []
  const selectedInput = advInputs.find(([key]) => key === advInput)

  /** Server-side auto-detection: prompt/size/steps/seed + dropdown options (object_info). */
  const recognize = async (): Promise<void> => {
    if (recognizing) return
    setRecognizing(true)
    setRecognizeError(null)
    try {
      const result = (await postJson('/comfyui/workflows/recognize', { workflow })) as { ok?: boolean; parameters?: WorkflowParameter[]; error?: string }
      if (result.ok === true && Array.isArray(result.parameters)) {
        onChange(result.parameters)
        setAdvanced(false)
      } else {
        setRecognizeError(result.error ?? t('wfParamsRecognizeFailed'))
      }
    } catch {
      setRecognizeError(t('wfParamsRecognizeFailed'))
    } finally {
      setRecognizing(false)
    }
  }

  const update = (index: number, patch: Partial<WorkflowParameter>): void => {
    onChange(params.map((param, i) => (i === index ? { ...param, ...patch } : param)))
  }

  const addAdvanced = async (): Promise<void> => {
    if (advNode === '' || advInput === '' || selectedInput === undefined || advNodeInfo === undefined) return
    const [, value] = selectedInput
    // A linked or object-valued input has no widget value to start from: it
    // becomes a string parameter with an empty default, which the run path
    // reads as "leave the link alone unless a value is passed".
    const type = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string'

    // Generic media-list heuristic: a string holding a JSON array of
    // {kind, file, ...} items (e.g. MiniMaxH3 media_state) becomes one
    // reference-slot parameter per item. Detection is shape-based, never
    // class-specific.
    const existingMedia = params.some((param) => param.nodeId === advNode && param.inputKey === advInput && param.upload === 'media')
    if (!existingMedia && typeof value === 'string') {
      let parsed: unknown
      try {
        parsed = JSON.parse(value) as unknown
      } catch {
        parsed = undefined
      }
      if (Array.isArray(parsed) && parsed.length > 0
        && parsed.every((item) => typeof item === 'object' && item !== null && typeof (item as { file?: unknown }).file === 'string')) {
        const items = parsed as Array<{ name?: unknown; file?: unknown }>
        const firstFile = items[0]?.file
        const slash = typeof firstFile === 'string' ? firstFile.indexOf('/') : -1
        const subfolder = typeof firstFile === 'string' && slash > 0 ? firstFile.slice(0, slash) : undefined
        const added: WorkflowParameter[] = items.map((item, i) => ({
          id: newParamId(),
          name: genParamName(`media_${i + 1}`),
          label: `${t('wfRefSlot')}${i + 1}`,
          type: 'string',
          nodeId: advNode,
          inputKey: advInput,
          default: typeof item.name === 'string' ? item.name : '',
          upload: 'media',
          subfolder,
        }))
        onChange([...params, ...added])
        setAdvanced(false)
        setAdvNode('')
        setAdvInput('')
        setAdvLabel('')
        return
      }
    }

    // Ask the server for the node's dropdown options (object_info combos) and
    // whether this input is a loader file picker (upload kind).
    let options: Array<string | number> | undefined
    let upload: WorkflowParameter['upload']
    let numberSpec: { kind?: 'int' | 'float'; min?: number; max?: number; step?: number } | undefined
    if (typeof advNodeInfo.class_type === 'string') {
      try {
        const result = (await postJson('/comfyui/workflows/input-options', { classType: advNodeInfo.class_type, inputKey: advInput })) as {
          ok?: boolean
          options?: Array<string | number>
          upload?: 'image' | 'video' | 'audio'
          number?: { kind?: 'int' | 'float'; min?: number; max?: number; step?: number }
        }
        if (result.ok === true && Array.isArray(result.options) && result.options.length > 0) options = result.options
        upload = result.upload
        numberSpec = result.number
      } catch {
        // options and the numeric type are a nice-to-have; fall back to free text
      }
    }
    onChange([...params, {
      id: newParamId(),
      name: genParamName(advInput),
      label: advLabel !== '' ? advLabel : `${advNode} · ${advInput}`,
      type,
      nodeId: advNode,
      inputKey: advInput,
      default: typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : '',
      numberKind: type === 'number' ? numberSpec?.kind : undefined,
      min: type === 'number' ? numberSpec?.min : undefined,
      max: type === 'number' ? numberSpec?.max : undefined,
      step: type === 'number' ? numberSpec?.step : undefined,
      options,
      upload,
    }])
    setAdvanced(false)
    setAdvNode('')
    setAdvInput('')
    setAdvLabel('')
  }

  /** Update a parameter's default; DynamicCombo parents refresh their child (size) parameter. */
  const updateDefault = (index: number, value: string | number | boolean): void => {
    update(index, { default: value })
    const param = params[index]
    if (param === undefined || typeof value !== 'string') return
    if (param.options === undefined || param.options.length === 0) return
    // Child parameter key is "<parent>.<child>" on the same node (e.g. aspect_ratio.size).
    const childIndex = params.findIndex((entry) => entry.nodeId === param.nodeId && entry.inputKey.startsWith(`${param.inputKey}.`))
    if (childIndex === -1) return
    const child = params[childIndex]
    if (child === undefined) return
    const rawNode = (workflow as Record<string, { class_type?: string }>)[child.nodeId]
    const classType = typeof rawNode?.class_type === 'string' ? rawNode.class_type : ''
    void postJson('/comfyui/workflows/input-options', { classType, inputKey: param.inputKey, parentValue: value })
      .then((result) => {
        const data = result as { ok?: boolean; child?: { childInputKey: string; options: Array<string | number>; default: string } }
        if (data.ok === true && data.child !== undefined && childIndex < params.length) {
          update(childIndex, { options: data.child.options, default: data.child.default })
        }
      })
      .catch(() => undefined)
  }

  return h('div', { className: 'dsc-params' },
    params.length === 0
      ? h('div', { className: 'dsc-hint' }, t('wfParamsEmpty'))
      : h('div', { className: 'dsc-list' }, params.map((param, index) => h('div', { key: param.id, className: 'dsc-param-row' },
        h('div', { className: 'dsc-param-fields' },
          h('input', {
            className: 'dsc-input dsc-input--sm',
            value: param.label,
            placeholder: t('wfParamLabel'),
            onChange: (event: { target: { value: string } }) => update(index, { label: event.target.value }),
          }),
        ),
        param.upload === 'media'
          ? h('div', {
              className: 'dsc-param-upload-wrap',
              onMouseEnter: () => { hoverRef.current = param.id; setHovered(param.id) },
              onMouseLeave: () => { hoverRef.current = null; setHovered(null) },
            },
              h('input', {
                className: 'dsc-input dsc-input--sm dsc-param-default',
                value: String(param.default),
                placeholder: t('wfMediaEmpty'),
                title: `${param.subfolder ?? ''}/`,
                onChange: (event: { target: { value: string } }) => updateDefault(index, event.target.value),
              }),
              h('label', {
                className: hovered === param.id ? 'dsc-dropzone dsc-dropzone--over' : 'dsc-dropzone',
                title: t('wfPasteHint'),
                tabIndex: 0,
                onDragOver: (event: { preventDefault: () => void }) => event.preventDefault(),
                onDrop: (event: { preventDefault: () => void; dataTransfer?: { files?: File[] } }) => {
                  event.preventDefault()
                  const file = event.dataTransfer?.files?.[0]
                  if (file !== undefined) void uploadFile(param, file)
                },
                onPaste: (event: { clipboardData?: { files?: File[] } }) => {
                  const file = event.clipboardData?.files?.[0]
                  if (file !== undefined) void uploadFile(param, file)
                },
              },
                h('input', {
                  type: 'file',
                  style: { display: 'none' },
                  onChange: (event: { target: HTMLInputElement }) => {
                    const file = event.target.files?.[0]
                    if (file !== undefined) void uploadFile(param, file)
                    event.target.value = ''
                  },
                }),
                uploading[param.id] === true ? t('wfParamsUploading') : t('wfParamsDrop'),
              ),
              h('button', { className: 'dsc-btn', onClick: () => updateDefault(index, '') }, t('wfMediaClear')),
            )
          : param.upload !== undefined
            ? h('div', {
                className: 'dsc-param-upload-wrap',
                onMouseEnter: () => { hoverRef.current = param.id; setHovered(param.id) },
                onMouseLeave: () => { hoverRef.current = null; setHovered(null) },
              },
                param.options !== undefined && param.options.length > 0
                  ? h(UploadSelect, {
                      value: String(param.default),
                      options: param.options,
                      kind: param.upload,
                      onChange: (value: string) => updateDefault(index, value),
                      onRefresh: () => refreshOptions(param),
                    })
                  : null,
                h('label', {
                  className: hovered === param.id ? 'dsc-dropzone dsc-dropzone--over' : 'dsc-dropzone',
                  title: t('wfPasteHint'),
                  tabIndex: 0,
                  onDragOver: (event: { preventDefault: () => void }) => event.preventDefault(),
                  onDrop: (event: { preventDefault: () => void; dataTransfer?: { files?: File[] } }) => {
                    event.preventDefault()
                    const file = event.dataTransfer?.files?.[0]
                    if (file !== undefined) void uploadFile(param, file)
                  },
                  onPaste: (event: { clipboardData?: { files?: File[] } }) => {
                    const file = event.clipboardData?.files?.[0]
                    if (file !== undefined) void uploadFile(param, file)
                  },
                },
                  h('input', {
                    type: 'file',
                    style: { display: 'none' },
                    onChange: (event: { target: HTMLInputElement }) => {
                      const file = event.target.files?.[0]
                      if (file !== undefined) void uploadFile(param, file)
                      event.target.value = ''
                    },
                  }),
                  uploading[param.id] === true ? t('wfParamsUploading') : `${t('wfParamsDrop')} ${t(`uploadKind_${param.upload}`)}`,
                ),
              )
            : (param.options !== undefined && param.options.length > 0)
              ? h('select', {
                  className: 'dsc-input dsc-input--sm dsc-param-default',
                  value: String(param.default),
                  onChange: (event: { target: { value: string } }) => updateDefault(index, event.target.value),
                },
                  param.options.map((option) => h('option', { key: String(option), value: String(option) }, String(option))),
                )
              : param.type === 'string'
              ? h('textarea', {
                className: 'dsc-input dsc-param-default',
                rows: 2,
                value: String(param.default),
                placeholder: t('wfParamDefault'),
                onChange: (event: { target: { value: string } }) => updateDefault(index, event.target.value),
              })
            : param.type === 'boolean'
              ? h('label', { className: 'dsc-param-bool dsc-param-default' },
                  h('input', {
                    type: 'checkbox',
                    checked: asBool(param.default),
                    onChange: (event: { target: { checked: boolean } }) => updateDefault(index, event.target.checked),
                  }),
                  h('span', null, asBool(param.default) ? 'true' : 'false'),
                )
            : param.type === 'number'
              ? h('input', {
                  className: 'dsc-input dsc-input--sm dsc-param-default',
                  inputMode: param.numberKind === 'int' ? 'numeric' : 'decimal',
                  value: numDraft[param.id] ?? String(param.default),
                  placeholder: t('wfParamDefault'),
                  title: numberRangeHint(param),
                  onChange: (event: { target: { value: string } }) => {
                    const raw = event.target.value
                    setNumDraft((prev) => ({ ...prev, [param.id]: raw }))
                    const parsed = Number(raw)
                    if (raw.trim() !== '' && Number.isFinite(parsed)) updateDefault(index, parsed)
                  },
                  onBlur: () => {
                    // Commit: an int input rounds, an empty/garbled field falls
                    // back to 0, and the draft is dropped so the stored value
                    // shows through again.
                    const raw = numDraft[param.id]
                    setNumDraft((prev) => {
                      const next = { ...prev }
                      delete next[param.id]
                      return next
                    })
                    if (raw === undefined) return
                    const parsed = Number(raw)
                    const value = raw.trim() === '' || !Number.isFinite(parsed) ? 0 : parsed
                    updateDefault(index, param.numberKind === 'int' ? Math.round(value) : value)
                  },
                })
              : h('input', {
                  className: 'dsc-input dsc-input--sm dsc-param-default',
                  value: String(param.default),
                  placeholder: t('wfParamDefault'),
                  onChange: (event: { target: { value: string } }) => updateDefault(index, event.target.value),
                }),
        h('div', { className: 'dsc-param-meta' },
          h('span', { className: 'dsc-meta' }, `${param.type}${param.type === 'number' ? `/${param.numberKind ?? '?'}` : ''} · #${param.nodeId}.${param.inputKey}`),
          param.type === 'number'
            ? h('label', { className: 'dsc-param-random' },
                h('input', {
                  type: 'checkbox',
                  checked: param.random === true,
                  onChange: (event: { target: { checked: boolean } }) => update(index, { random: event.target.checked }),
                }),
                h('span', null, t('wfParamRandom')),
              )
            : null,
          h('button', { className: 'dsc-btn', onClick: () => onChange(params.filter((_, i) => i !== index)) }, t('wfParamDelete')),
        ),
      ))),
    h('div', { className: 'dsc-toolbar' },
      h('button', { className: 'dsc-btn', disabled: recognizing, onClick: () => { void recognize() } }, recognizing ? t('wfParamsRecognizing') : t('wfParamsRecognize')),
      h('button', { className: 'dsc-btn', onClick: () => setAdvanced(!advanced) }, t('wfParamsAdd')),
    ),
    recognizeError !== null ? h('div', { className: 'dsc-hint dsc-hint--error' }, recognizeError) : null,
    advanced
      ? h('div', { className: 'dsc-param-advanced' },
          h('div', { className: 'dsc-param-fields' },
            h('select', {
              className: 'dsc-input dsc-input--sm',
              value: advNode,
              onChange: (event: { target: { value: string } }) => { setAdvNode(event.target.value); setAdvInput('') },
            },
              h('option', { value: '' }, '—'),
              nodeEntries.map(([id, node]) => h('option', { key: id, value: id }, `#${id} ${node.class_type ?? ''}`)),
            ),
            advNodeInfo !== undefined
              ? h('select', {
                  className: 'dsc-input dsc-input--sm',
                  value: advInput,
                  onChange: (event: { target: { value: string } }) => setAdvInput(event.target.value),
                },
                  h('option', { value: '' }, '—'),
                  advInputs.map(([key, value]) => h('option', { key, value: key }, `${key} (${inputValueKind(value)})`)),
                )
              : null,
            h('input', {
              className: 'dsc-input dsc-input--sm',
              value: advLabel,
              placeholder: t('wfParamCustomLabel'),
              onChange: (event: { target: { value: string } }) => setAdvLabel(event.target.value),
            }),
            h('button', { className: 'dsc-btn', disabled: advNode === '' || advInput === '', onClick: () => { void addAdvanced() } }, t('wfParamAdd')),
          ),
          h('div', { className: 'dsc-hint' }, t('wfParamCustomHint')),
        )
      : null,
  )
}

function formatTs(ts: string): string {
  const date = new Date(ts)
  return Number.isNaN(date.getTime()) ? ts : date.toLocaleString()
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/** The panel shell: header (drag handle), tabs, and the active tab body. */
export function ComfyUIPanel({ t }: ComfyUIPanelProps): ReturnType<typeof h> | null {
  const open = usePanelOpen()
  const tab = usePanelTab()
  const [geom, setGeom] = useState<PanelGeom>(() => healGeom(loadGeom(), window.innerWidth, window.innerHeight))
  const [dragging, setDragging] = useState<'move' | 'resize' | null>(null)
  const [lightbox, setLightbox] = useState<{ images: string[]; kinds: Array<'image' | 'video' | 'audio' | 'other'>; index: number } | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number; width: number; height: number } | null>(null)

  const openPreview = (images: string[], kinds: Array<'image' | 'video' | 'audio' | 'other'>, index: number): void => setLightbox({ images, kinds, index })

  useEffect(() => {
    if (open) {
      // The window may have been resized or moved to another monitor while the
      // panel was closed, or the saved position may predate the reachability
      // clamp — snap a header that ended up out of reach back into the viewport.
      setGeom((prev) => healGeom(prev, window.innerWidth, window.innerHeight))
      return
    }
    saveGeom(geom)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // While the panel is open, keep the header reachable across viewport
  // resizes too (shrinking the window can otherwise strand it off-screen).
  useEffect(() => {
    if (!open) return
    const onResize = (): void => setGeom((prev) => healGeom(prev, window.innerWidth, window.innerHeight))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open])

  const startDrag = (event: PointerEventLike, mode: 'move' | 'resize'): void => {
    if (event.button !== 0) return
    if (mode === 'move') {
      const target = event.target as HTMLElement | null
      if (target !== null && target.closest('button, input, textarea, select, a, label')) return
    }
    const rect = panelRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    dragRef.current = {
      startX: event.clientX, startY: event.clientY,
      origX: rect.left, origY: rect.top, width: rect.width, height: rect.height,
    }
    setDragging(mode)
    const el = event.currentTarget as HTMLElement | null
    if (el !== null && typeof el.setPointerCapture === 'function') el.setPointerCapture(event.pointerId)
  }

  const moveDrag = (event: PointerEventLike): void => {
    const d = dragRef.current
    if (d === null) return
    if (dragging === 'move') {
      // Clamp while dragging so the header can never be pushed out of reach.
      const pos = clampPos(
        Math.round(d.origX + event.clientX - d.startX),
        Math.round(d.origY + event.clientY - d.startY),
        d.width,
        window.innerWidth,
        window.innerHeight,
      )
      setGeom((prev) => ({ ...prev, x: pos.x, y: pos.y }))
    } else if (dragging === 'resize') {
      const width = Math.max(300, Math.min(720, d.width + event.clientX - d.startX))
      const height = Math.max(200, Math.min(Math.max(300, window.innerHeight - 40), d.height + event.clientY - d.startY))
      setGeom((prev) => ({ ...prev, width, height }))
    }
  }

  const endDrag = (): void => {
    if (dragRef.current === null) return
    dragRef.current = null
    setDragging(null)
    setGeom((prev) => {
      saveGeom(prev)
      return prev
    })
  }

  if (!open) return null

  const panelStyle: Record<string, string> = {}
  if (geom.x !== undefined && geom.y !== undefined) {
    panelStyle.left = `${geom.x}px`
    panelStyle.top = `${geom.y}px`
    panelStyle.right = 'auto'
    panelStyle.bottom = 'auto'
  }
  if (geom.width !== undefined) panelStyle.width = `${geom.width}px`
  if (geom.height !== undefined) panelStyle.height = `${geom.height}px`

  return h('div',
    { ref: panelRef, className: `dsc-panel${dragging !== null ? ' dsc-panel--dragging' : ''}`, style: panelStyle },
    h('div', {
      className: 'dsc-panel-head',
      onPointerDown: (event: PointerEventLike) => startDrag(event, 'move'),
      onPointerMove: (event: PointerEventLike) => moveDrag(event),
      onPointerUp: () => endDrag(),
      onPointerCancel: () => endDrag(),
    },
      h('span', { className: 'dsc-panel-title' },
        h('span', { className: 'dsc-trigger-glyph' }, h(ComfyUIIcon)),
        h('span', null, t('panelTitle')),
      ),
      h('span', { className: 'dsc-panel-head-actions' },
        h('button', {
          className: 'dsc-panel-reset',
          type: 'button',
          title: t('panelReset'),
          'aria-label': t('panelReset'),
          onClick: () => {
            // Restore the CSS-anchored default (right side, 400px wide) and
            // clear the stored geometry so the default also survives refresh.
            setGeom({})
            try {
              localStorage.removeItem(GEOM_KEY)
            } catch {
              // storage unavailable — nothing persisted anyway
            }
          },
        }, '↺'),
        h('button', {
          className: 'dsc-panel-close',
          'aria-label': t('close'),
          onClick: () => panelStore.close(),
        }, '✕'),
      ),
    ),
    h('div', { className: 'dsc-tabs' },
      h(TabButton, { t, active: tab === 'workflows', label: t('tabWorkflows'), onClick: () => panelStore.setTab('workflows') }),
      h(TabButton, { t, active: tab === 'assets', label: t('tabAssets'), onClick: () => panelStore.setTab('assets') }),
      h(TabButton, { t, active: tab === 'queue', label: t('tabQueue'), onClick: () => panelStore.setTab('queue') }),
    ),
    h('div', { className: 'dsc-panel-body' },
      tab === 'workflows' ? h(WorkflowsTab, { t })
        : tab === 'assets' ? h(AssetsTab, { t, onPreview: openPreview })
          : h(QueueTab, { t, onPreview: openPreview }),
    ),
    lightbox !== null ? h(Lightbox, {
      t,
      images: lightbox.images,
      kinds: lightbox.kinds,
      index: lightbox.index,
      onClose: () => setLightbox(null),
      onIndex: (index: number) => setLightbox({ images: lightbox.images, kinds: lightbox.kinds, index }),
    }) : null,
    h('div', {
      className: 'dsc-panel-resize',
      onPointerDown: (event: PointerEventLike) => startDrag(event, 'resize'),
      onPointerMove: (event: PointerEventLike) => moveDrag(event),
      onPointerUp: () => endDrag(),
      onPointerCancel: () => endDrag(),
    }),
  )
}

function TabButton(props: { t: ComfyUIPanelProps['t']; active: boolean; label: string; onClick: () => void }): ReturnType<typeof h> {
  return h('button', {
    className: props.active ? 'dsc-tab dsc-tab--active' : 'dsc-tab',
    onClick: props.onClick,
  }, props.label)
}

function ErrorNote({ t, message }: { t: ComfyUIPanelProps['t']; message: string }): ReturnType<typeof h> {
  return h('div', { className: 'dsc-err' }, `${t('error')}: ${message}`)
}

/** Tab 1: workflow library — plugin library + ComfyUI-side saved workflows. */
/** One selectable item in the load-area picker (mirrors the host response). */
interface LoadAreaFile {
  name: string
  kind: 'image' | 'video' | 'audio'
  url: string
  source: 'imported' | 'generated'
  ts?: string
  workflowName?: string | null
  width?: number
  height?: number
}

/** Load area at the bottom of the workflow library, modeled on the ComfyUI
 * LoadImage node — a list of **slots** rather than a single image.
 *
 * A lone slot stretches across the panel; from two slots on they share a
 * fixed width and wrap into rows. A slot is either filled with a file or
 * empty (added but not yet picked, or emptied through the picker's "空"
 * tile); the whole card is the pick button, and hovering reveals an × in the
 * corner that removes the slot. Filled slots feed the workflow's loader
 * parameters in order, so a run that takes two reference images picks up
 * slots 1 and 2 without the agent naming files. */
function LoadArea(props: { t: ComfyUIPanelProps['t']; onNotice: (message: string) => void }): ReturnType<typeof h> {
  const [slots, setSlots] = useState<Array<LoadAreaFile | null>>([])
  const [files, setFiles] = useState<LoadAreaFile[]>([])
  /** Slot index the picker is currently filling; null = picker closed. */
  const [pickerFor, setPickerFor] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const data = (await fetch('/comfyui/loadarea').then((response) => response.json()).catch(() => undefined)) as
      { ok?: boolean; current?: LoadAreaFile | null; slots?: Array<LoadAreaFile | null>; files?: LoadAreaFile[] } | undefined
    if (data?.ok === true) {
      // `slots` is the current contract; `current` is the older single-image
      // payload, kept working so a stale client/server pair still shows something.
      setSlots(data.slots ?? (data.current !== null && data.current !== undefined ? [data.current] : []))
      setFiles(data.files ?? [])
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const post = async (body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/comfyui/current-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string }
      if (data.ok !== true) throw new Error(data.error ?? `HTTP ${response.status}`)
      await refresh()
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setBusy(false)
    }
  }

  const upload = async (file: File): Promise<string> => {
    setBusy(true)
    setError(null)
    try {
      const name = await uploadDedup(file)
      const sizeText = await recordMediaSize(file, name)
      await refresh()
      props.onNotice(`${props.t('wfUploaded')}：${name}${sizeText !== undefined ? `（${sizeText}）` : ''}`)
      return name
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      throw cause
    } finally {
      setBusy(false)
    }
  }

  const pick = async (file: LoadAreaFile): Promise<void> => {
    const index = pickerFor
    setPickerFor(null)
    const ok = await post({ name: file.name, kind: file.kind, source: file.source, ...(index !== null ? { index } : {}) })
    if (ok) props.onNotice(`${props.t('wfLoadPicked')}：${file.name}`)
  }

  /** "＋ 添加加载区": opens a slot and goes straight to the picker for it, so
   * adding material is one gesture; closing the picker leaves the empty slot. */
  const addSlot = async (): Promise<void> => {
    const index = slots.length
    if (await post({ action: 'addSlot' })) setPickerFor(index)
  }

  const loaded = slots.filter((slot) => slot !== null).length

  return h('div', { className: 'dsc-loadarea' },
    h('div', { className: 'dsc-loadarea-head' },
      h('span', { className: 'dsc-loadarea-title' }, props.t('wfLoadArea')),
      h('span', { className: 'dsc-meta' }, slots.length === 0
        ? props.t('wfLoadEmpty')
        : props.t('wfLoadSummary', { slots: slots.length, loaded })),
    ),
    h('div', { className: 'dsc-loadslots' },
      slots.map((slot, index) => h(LoadSlot, {
        key: index,
        t: props.t,
        slot,
        index,
        busy,
        // A single slot fills the panel width; two or more share a fixed one.
        wide: slots.length === 1,
        onPick: () => setPickerFor(index),
        onRemove: () => { void post({ action: 'removeSlot', index }) },
      })),
    ),
    h('div', { className: 'dsc-toolbar' },
      h('button', { className: 'dsc-btn', disabled: busy, onClick: () => { void addSlot() } }, props.t('wfLoadAddSlot')),
    ),
    pickerFor !== null
      ? h(LoadPicker, {
          t: props.t,
          files,
          current: (pickerFor < slots.length ? slots[pickerFor]?.name : undefined) ?? null,
          onUpload: upload,
          onPick: pick,
          // First tile of the grid: empties the slot without removing it.
          onClear: () => { const index = pickerFor; setPickerFor(null); void post({ action: 'clear', index }) },
          onClose: () => setPickerFor(null),
        })
      : null,
    error !== null ? h('div', { className: 'dsc-hint dsc-hint--error' }, error) : null,
  )
}

/** One load-area slot card. The card is the pick button (empty slots show
 * "加载位 N / 添加素材"); the × in the corner, revealed on hover, removes the
 * slot. Emptying a slot without removing it is done from the picker's "空"
 * tile, so the card carries no button row of its own. */
function LoadSlot(props: {
  t: ComfyUIPanelProps['t']
  slot: LoadAreaFile | null
  index: number
  busy: boolean
  wide: boolean
  onPick: () => void
  onRemove: () => void
}): ReturnType<typeof h> {
  const { t, slot, index } = props
  const size = slot?.width !== undefined && slot.height !== undefined ? `（${slot.width}×${slot.height}）` : ''
  return h('div', { className: props.wide ? 'dsc-loadslot dsc-loadslot--wide' : 'dsc-loadslot' },
    h('button', {
      className: 'dsc-loadslot-pick',
      onClick: props.onPick,
      disabled: props.busy,
      title: slot !== null ? slot.name : t('wfLoadHint'),
    },
      slot === null
        ? h('span', { className: 'dsc-loadslot-empty' },
            h('span', { className: 'dsc-loadslot-index' }, `${t('wfLoadSlotLabel')} ${index + 1}`),
            h('span', { className: 'dsc-loadslot-add' }, t('wfLoadAddMedia')),
          )
        : slot.kind === 'video'
          ? h('video', { className: 'dsc-loadslot-media', src: slot.url, preload: 'metadata', muted: true })
          : slot.kind === 'audio'
            ? h('span', { className: 'dsc-loadslot-empty' }, '♪')
            : h('img', { className: 'dsc-loadslot-media', src: slot.url, alt: '', loading: 'lazy' }),
      slot !== null ? h('span', { className: 'dsc-loadslot-name' }, `${slot.name}${size}`) : null,
    ),
    h('button', {
      className: 'dsc-loadslot-x',
      disabled: props.busy,
      title: t('wfLoadRemoveSlot'),
      'aria-label': t('wfLoadRemoveSlot'),
      onClick: props.onRemove,
    }, '×'),
  )
}

/** The load-area picker dialog: tab bar (全部/已导入/已生成) with a
 * paste/click upload zone on the right, and a masonry image grid below. */
function LoadPicker(props: {
  t: ComfyUIPanelProps['t']
  files: LoadAreaFile[]
  current: string | null
  onUpload: (file: File) => Promise<string>
  onPick: (file: LoadAreaFile) => Promise<void>
  /** Empty the slot this picker was opened for (first tile of the grid). */
  onClear?: () => void
  onClose: () => void
}): ReturnType<typeof h> {
  const [tab, setTab] = useState<'all' | 'imported' | 'generated'>('all')
  const [type, setType] = useState<'all' | 'image' | 'video' | 'audio'>('all')
  const hoverRef = useRef(false)
  const [uploadFlash, setUploadFlash] = useState<string | null>(null)
  const [scrollTo, setScrollTo] = useState<string | null>(null)
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map())
  const flashTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => {
    if (flashTimer.current !== undefined) window.clearTimeout(flashTimer.current)
  }, [])

  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      if (!hoverRef.current) return
      const file = event.clipboardData?.files?.[0]
      if (file === undefined) return
      event.preventDefault()
      void handleUpload(file)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  })

  /** Upload, then flash a confirmation and scroll the grid to the new file. */
  const handleUpload = async (file: File): Promise<void> => {
    try {
      const name = await props.onUpload(file)
      setScrollTo(name)
      setUploadFlash(`${props.t('wfUploadedToast')}：${name}`)
      if (flashTimer.current !== undefined) window.clearTimeout(flashTimer.current)
      flashTimer.current = window.setTimeout(() => setUploadFlash(null), 2500)
    } catch {
      // LoadArea shows the upload error in its own area.
    }
  }

  const bySource = tab === 'all' ? props.files : props.files.filter((file) => file.source === tab)
  const filtered = type === 'all' ? bySource : bySource.filter((file) => file.kind === type)

  // After the refreshed file list renders, scroll the matching card into view.
  useEffect(() => {
    if (scrollTo === null) return
    let found: HTMLElement | undefined
    for (const [key, el] of cardRefs.current) {
      if (key.endsWith(`:${scrollTo}`)) { found = el; break }
    }
    if (found !== undefined) {
      found.scrollIntoView({ block: 'center', behavior: 'smooth' })
      setScrollTo(null)
    }
  }, [scrollTo, filtered])
  // Distribute into 3 vertical columns (round-robin) — a masonry look that
  // scrolls reliably, unlike CSS multi-column which balances columns to the
  // container height and never overflows.
  const columns: LoadAreaFile[][] = [[], [], []]
  filtered.forEach((file, index) => { columns[index % 3]!.push(file) })
  const tabs: Array<{ id: 'all' | 'imported' | 'generated'; label: string }> = [
    { id: 'all', label: props.t('wfTabAll') },
    { id: 'imported', label: props.t('wfTabImported') },
    { id: 'generated', label: props.t('wfTabGenerated') },
  ]
  const typeOptions: Array<{ id: 'all' | 'image' | 'video' | 'audio'; label: string }> = [
    { id: 'all', label: props.t('wfTypeAll') },
    { id: 'image', label: props.t('uploadKind_image') },
    { id: 'video', label: props.t('uploadKind_video') },
    { id: 'audio', label: props.t('uploadKind_audio') },
  ]

  return h('div', { className: 'dsc-picker-overlay', onClick: props.onClose },
    h('div', { className: 'dsc-picker', onClick: (event: { stopPropagation: () => void }) => event.stopPropagation() },
      h('div', { className: 'dsc-picker-bar' },
        h('div', { className: 'dsc-picker-tabs' },
          tabs.map((entry) => h('button', {
            key: entry.id,
            className: `dsc-picker-tab${tab === entry.id ? ' dsc-picker-tab--active' : ''}`,
            onClick: () => setTab(entry.id),
          }, entry.label)),
        ),
        h('label', {
          className: 'dsc-dropzone dsc-picker-upload',
          title: props.t('wfPasteHint'),
          onMouseEnter: () => { hoverRef.current = true },
          onMouseLeave: () => { hoverRef.current = false },
          onDragOver: (event: { preventDefault: () => void }) => event.preventDefault(),
          onDrop: (event: { preventDefault: () => void; dataTransfer?: { files?: File[] } }) => {
            event.preventDefault()
            const file = event.dataTransfer?.files?.[0]
            if (file !== undefined) void handleUpload(file)
          },
        },
          h('input', {
            type: 'file',
            style: { display: 'none' },
            onChange: (event: { target: HTMLInputElement }) => {
              const file = event.target.files?.[0]
              if (file !== undefined) void handleUpload(file)
              event.target.value = ''
            },
          }),
          props.t('wfPickerUpload'),
        ),
        h('select', {
          className: 'dsc-picker-type',
          value: type,
          onChange: (event: { target: { value: string } }) => setType(event.target.value as 'all' | 'image' | 'video' | 'audio'),
        }, typeOptions.map((option) => h('option', { key: option.id, value: option.id }, option.label))),
      ),
      filtered.length === 0 && props.onClear === undefined
        ? h('div', { className: 'dsc-picker-empty' }, props.t('wfLoadNoFiles'))
        : h('div', { className: 'dsc-picker-grid' },
          columns.map((column, columnIndex) => h('div', { key: columnIndex, className: 'dsc-picker-col' },
            // "空": clears the slot the picker was opened for, so a slot can be
            // emptied without deleting it.
            columnIndex === 0 && props.onClear !== undefined
              ? h('div', {
                  className: `dsc-picker-card dsc-picker-card--none${props.current === null ? ' dsc-picker-card--active' : ''}`,
                  role: 'button',
                  tabIndex: 0,
                  onClick: () => props.onClear?.(),
                  onKeyDown: (event: { key: string; preventDefault: () => void }) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      props.onClear?.()
                    }
                  },
                  title: props.t('wfLoadNoneHint'),
                },
                  h('span', { className: 'dsc-picker-thumb dsc-picker-thumb--media' }, '∅'),
                  h('span', { className: 'dsc-picker-name' }, props.t('wfLoadNone')),
                )
              : null,
            // A card is a div rather than a button: video/audio players are
            // interactive content and may not be nested inside a button, and
            // clicking their controls must not select the card.
            column.map((file) => h('div', {
              key: `${file.source}:${file.name}`,
              className: `dsc-picker-card${file.name === props.current ? ' dsc-picker-card--active' : ''}`,
              role: 'button',
              tabIndex: 0,
              onClick: () => { void props.onPick(file) },
              onKeyDown: (event: { key: string; preventDefault: () => void }) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  void props.onPick(file)
                }
              },
              title: file.name,
              ref: (el: HTMLElement | null): void => {
                if (el !== null) cardRefs.current.set(`${file.source}:${file.name}`, el)
                else cardRefs.current.delete(`${file.source}:${file.name}`)
              },
            },
              file.kind === 'image'
                ? h('img', { className: 'dsc-picker-thumb', src: file.url, alt: '', loading: 'lazy' })
                : file.kind === 'video'
                  ? h('video', {
                      className: 'dsc-picker-thumb dsc-picker-player',
                      src: file.url,
                      controls: true,
                      preload: 'metadata',
                      onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
                    })
                  : h('audio', {
                      className: 'dsc-picker-player dsc-picker-player--audio',
                      src: file.url,
                      controls: true,
                      preload: 'metadata',
                      onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
                    }),
              // On a video/audio card the player keeps its own clicks, so this
              // name row is the click target that picks the file — it is sized
              // accordingly.
              h('span', { className: 'dsc-picker-name' }, file.name),
              file.width !== undefined && file.height !== undefined
                ? h('span', { className: 'dsc-meta' }, `${file.width}×${file.height}`)
                : null,
            )),
          )),
        ),
        uploadFlash !== null ? h('div', { className: 'dsc-picker-toast' }, uploadFlash) : null,
    ),
  )
}

/** Tag editor: preset classification chips (图生图 etc.) toggle on/off, plus
 * free-form custom tags added with Enter and removed by clicking. */
function TagEditor(props: {
  t: ComfyUIPanelProps['t']
  tags: string[]
  onChange: (tags: string[]) => void
}): ReturnType<typeof h> {
  const [custom, setCustom] = useState('')

  const toggle = (tag: string): void => {
    props.onChange(props.tags.includes(tag) ? props.tags.filter((entry) => entry !== tag) : [...props.tags, tag])
  }

  const addCustom = (): void => {
    const tag = custom.trim()
    if (tag === '' || props.tags.includes(tag)) return
    props.onChange([...props.tags, tag])
    setCustom('')
  }

  const customTags = props.tags.filter((tag) => !PRESET_TAGS.includes(tag))

  return h('div', { className: 'dsc-tag-editor' },
    h('div', { className: 'dsc-tag-row' },
      PRESET_TAGS.map((tag) => h('button', {
        key: tag,
        className: `dsc-tag-chip${props.tags.includes(tag) ? ' dsc-tag-chip--active' : ''}`,
        onClick: () => toggle(tag),
      }, tag)),
    ),
    customTags.length > 0
      ? h('div', { className: 'dsc-tag-row' },
        customTags.map((tag) => h('button', {
          key: tag,
          className: 'dsc-tag-chip dsc-tag-chip--active',
          title: props.t('wfTagRemove'),
          onClick: () => toggle(tag),
        }, `✕ ${tag}`)),
      )
      : null,
    h('input', {
      className: 'dsc-input dsc-input--sm dsc-tag-input',
      value: custom,
      placeholder: props.t('wfTagAdd'),
      onChange: (event: { target: { value: string } }) => setCustom(event.target.value),
      onKeyDown: (event: { key: string; preventDefault: () => void }) => {
        if (event.key === 'Enter') { event.preventDefault(); addCustom() }
      },
    }),
  )
}

/**
 * The skill-pack editor for one workflow: attach/detach the pack, toggle the
 * run-time gate, and manage its files (SKILL.md plus references/ and scripts/).
 *
 * The pack is what `comfyui_workflow action: skill` hands the agent, so this
 * view is the only place its content is authored. Each file saves explicitly —
 * no autosave — because the model reads whatever is on disk the moment it asks.
 * SKILL.md is edited as a summary field plus a body: the `---` frontmatter that
 * carries the summary is composed on the host, never typed here.
 */
function SkillPackEditor(props: {
  t: ComfyUIPanelProps['t']
  workflow: WorkflowEntry
  onBack: () => void
  onChanged: () => void
}): ReturnType<typeof h> {
  const { t } = props
  const [pack, setPack] = useState<SkillPack | null>(null)
  const [enabled, setEnabled] = useState<boolean>(props.workflow.skillDir !== undefined)
  const [active, setActive] = useState<string>('SKILL.md')
  const [summary, setSummary] = useState<string>('')
  const [text, setText] = useState<string>('')
  const [dirty, setDirty] = useState<boolean>(false)
  const [pendingOpen, setPendingOpen] = useState<string | null>(null)
  const [creating, setCreating] = useState<{ bucket: string; name: string } | null>(null)
  const [creatingDir, setCreatingDir] = useState<string | null>(null)
  const [presetDirs, setPresetDirs] = useState<string[]>(SKILL_FALLBACK_DIRS)
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  /** Load one file into the editor; SKILL.md arrives pre-split into summary + body. */
  const openFile = useCallback(async (path: string): Promise<void> => {
    // Images are shown, not edited: reading one as UTF-8 would only produce
    // garbage in the textarea.
    if (isSkillImage(path)) {
      setActive(path)
      setSummary('')
      setText('')
      setDirty(false)
      setError(null)
      return
    }
    try {
      const data = await getJson<{ ok?: boolean; content?: string; summary?: string; body?: string; error?: string }>(
        `/comfyui/workflows/skill?id=${encodeURIComponent(props.workflow.id)}&path=${encodeURIComponent(path)}`,
      )
      if (data.ok !== true) {
        setError(data.error ?? t('skillReadFailed'))
        return
      }
      setActive(path)
      if (path === 'SKILL.md') {
        setSummary(data.summary ?? '')
        setText(data.body ?? '')
      } else {
        setSummary('')
        setText(data.content ?? '')
      }
      setDirty(false)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [props.workflow.id, t])

  /** Re-read the pack listing, then the requested file. */
  const refresh = useCallback(async (path?: string): Promise<void> => {
    try {
      const data = await getJson<SkillPackResponse>(`/comfyui/workflows/skill?id=${encodeURIComponent(props.workflow.id)}`)
      setEnabled(data.enabled === true)
      setPack(data.pack ?? null)
      if (Array.isArray(data.presetDirs) && data.presetDirs.length > 0) setPresetDirs(data.presetDirs)
      if (data.enabled === true) await openFile(path ?? 'SKILL.md')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [props.workflow.id, openFile])

  /** Re-read the pack listing and — only when nothing is unsaved — the file
   * currently open, so files added or replaced outside this panel (the agent
   * writing via comfyui_skill, or the file manager after `打开目录`) show up
   * without leaving and re-entering the view. */
  const refreshFiles = async (): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      const data = await getJson<SkillPackResponse>(`/comfyui/workflows/skill?id=${encodeURIComponent(props.workflow.id)}`)
      setEnabled(data.enabled === true)
      setPack(data.pack ?? null)
      if (Array.isArray(data.presetDirs) && data.presetDirs.length > 0) setPresetDirs(data.presetDirs)
      setError(null)
      props.onChanged()
      if (data.enabled === true && !dirty) await openFile(active)
      setNotice(t('skillRefreshed'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** Every mutation goes through here so the listing and the flags stay in sync. */
  const mutate = async (body: Record<string, unknown>, after?: string): Promise<boolean> => {
    setBusy(true)
    setNotice(null)
    try {
      const data = (await postJson('/comfyui/workflows/skill', { id: props.workflow.id, ...body })) as SkillPackResponse
      if (data.ok !== true) {
        setError(data.error ?? t('skillFailed'))
        return false
      }
      setEnabled(data.enabled === true)
      setPack(data.pack ?? null)
      setError(null)
      props.onChanged()
      if (after !== undefined && data.enabled === true) await openFile(after)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setBusy(false)
    }
  }

  const saveFile = async (): Promise<boolean> => {
    const body: Record<string, unknown> = { action: 'write', path: active, content: text }
    if (active === 'SKILL.md') body.summary = summary
    const ok = await mutate(body)
    if (ok) {
      setDirty(false)
      setNotice(`${t('skillSaved')} ${active}`)
    }
    return ok
  }

  /** Switching files with unsaved edits parks the request until the user decides. */
  const selectFile = (path: string): void => {
    if (path === active) return
    if (dirty) {
      setPendingOpen(path)
      return
    }
    void openFile(path)
  }

  const createFile = async (): Promise<void> => {
    if (creating === null) return
    const name = creating.name.trim()
    if (name === '') return
    const path = `${creating.bucket}/${name.includes('.') ? name : `${name}.md`}`
    const ok = await mutate({ action: 'write', path, content: '' }, path)
    if (ok) setCreating(null)
  }

  /** Open the pack directory in the desktop file manager (on the machine
   * running DSH — the hint says so, and the path stays visible below). */
  const revealDir = async (): Promise<void> => {
    setNotice(null)
    try {
      const data = (await postJson('/comfyui/workflows/skill/reveal', { id: props.workflow.id })) as { ok?: boolean; error?: string; dir?: string }
      if (data.ok !== true) {
        setError(data.error ?? t('skillFailed'))
        return
      }
      setError(null)
      setNotice(`${t('skillRevealed')} ${data.dir ?? ''}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const createDir = async (): Promise<void> => {
    if (creatingDir === null) return
    const name = creatingDir.trim()
    if (name === '') return
    const ok = await mutate({ action: 'mkdir', name })
    if (ok) {
      setCreatingDir(null)
      setNotice(`${t('skillDirCreated')} ${name}/`)
    }
  }

  const applyRename = async (): Promise<void> => {
    if (renaming === null) return
    const to = renaming.to.trim()
    if (to === '') return
    const bucket = renaming.from.includes('/') ? `${renaming.from.split('/')[0] ?? ''}/` : ''
    const target = to.includes('/') ? to : `${bucket}${to}`
    const ok = await mutate({ action: 'rename', path: renaming.from, to: target }, target)
    if (ok) setRenaming(null)
  }

  /** Import local files into the pack. The destination bucket comes from the
   * host (one extension rule, shared with the agent-facing listing), so the
   * panel only sends the name and the bytes. */
  const importFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return
    setBusy(true)
    setNotice(null)
    let imported: string | null = null
    let failed = 0
    for (const file of files) {
      try {
        const bytes = await file.arrayBuffer()
        const data = (await postRaw(
          `/comfyui/workflows/skill/import?id=${encodeURIComponent(props.workflow.id)}&name=${encodeURIComponent(file.name)}`,
          bytes,
        )) as SkillPackResponse & { path?: string }
        if (data.ok !== true) {
          failed += 1
          setError(data.error ?? t('skillFailed'))
          continue
        }
        setPack(data.pack ?? null)
        imported = data.path ?? null
      } catch (cause) {
        failed += 1
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    setBusy(false)
    props.onChanged()
    if (imported !== null) {
      if (failed === 0) {
        setError(null)
        setNotice(`${t('skillImported')} ${imported}`)
      }
      await openFile(imported)
    }
  }

  const head = h('div', { className: 'dsc-view-head' },
    h('button', { className: 'dsc-btn', onClick: props.onBack }, t('wfViewBack')),
    h('div', { className: 'dsc-wf-name', title: props.workflow.name }, `${t('skillTitle')} · ${props.workflow.name}`),
  )

  if (!enabled) {
    return h('div', null,
      head,
      h('div', { className: 'dsc-hint' }, t('skillIntro')),
      error !== null ? h(ErrorNote, { t, message: error }) : null,
      h('div', { className: 'dsc-row' },
        h('button', { className: 'dsc-btn', disabled: busy, onClick: () => void mutate({ action: 'enable' }, 'SKILL.md') }, t('skillEnable')),
      ),
    )
  }

  const files = pack?.files ?? []
  // Directories come from disk, so a folder the user created by hand (or an
  // empty one they just added) shows up exactly like a preset would. The list
  // is unioned with the directories the file paths imply: a host that predates
  // the `dirs` field would otherwise hide every sub-directory it does report
  // files for.
  const impliedDirs = files
    .filter((file) => file.path.includes('/'))
    .map((file) => file.path.split('/')[0] ?? '')
    .filter((dir) => dir !== '')
  const packDirs = [...new Set([...(pack?.dirs ?? []), ...impliedDirs])].sort((a, b) => a.localeCompare(b))
  const buckets: Array<{ label: string; items: SkillPackFile[] }> = [
    { label: '', items: files.filter((file) => !file.path.includes('/')) },
    ...packDirs.map((bucket) => ({
      label: bucket,
      items: files.filter((file) => file.path.startsWith(`${bucket}/`)),
    })),
  ]
  /** Where a new file may go: the pack's own directories first, then the
   * presets it has not used yet. */
  const targetDirs = [...packDirs, ...presetDirs.filter((dir) => !packDirs.includes(dir))]

  /** One row in the pack file list; clicking opens it for editing. */
  const fileButton = (file: SkillPackFile): ReturnType<typeof h> => h('button', {
    key: file.path,
    className: `dsc-skill-file${file.path === active ? ' dsc-skill-file--active' : ''}`,
    onClick: () => selectFile(file.path),
  },
    h('span', { className: 'dsc-skill-file-name' }, file.path.includes('/') ? file.path.split('/')[1] : file.path),
    h('span', { className: 'dsc-skill-file-size' }, formatBytes(file.size)),
  )

  const fileList = h('div', {
    className: 'dsc-skill-files',
    onDragOver: (event: { preventDefault: () => void }) => event.preventDefault(),
    onDrop: (event: { preventDefault: () => void; dataTransfer?: { files?: File[] } }) => {
      event.preventDefault()
      const dropped = Array.from(event.dataTransfer?.files ?? [])
      if (dropped.length > 0) void importFiles(dropped)
    },
  },
    // Both actions sit at the top of the column: below a long file list they
    // were easy to miss entirely.
    h('div', { className: 'dsc-skill-actions' },
      h('label', { className: 'dsc-btn dsc-btn--sm', title: t('skillImportHint') },
        t('skillImport'),
        h('input', {
          type: 'file',
          multiple: true,
          style: { display: 'none' },
          disabled: busy,
          onChange: (event: { target: HTMLInputElement }) => {
            const picked = Array.from(event.target.files ?? [])
            event.target.value = ''
            if (picked.length > 0) void importFiles(picked)
          },
        }),
      ),
      creating === null
        ? h('button', {
          className: 'dsc-btn dsc-btn--sm',
          disabled: busy,
          onClick: () => { setCreatingDir(null); setCreating({ bucket: targetDirs[0] ?? 'references', name: '' }) },
        }, t('skillNewFile'))
        : null,
      creatingDir === null
        ? h('button', {
          className: 'dsc-btn dsc-btn--sm',
          disabled: busy,
          onClick: () => { setCreating(null); setCreatingDir('') },
        }, t('skillNewDir'))
        : null,
      h('button', {
        className: 'dsc-btn dsc-btn--sm',
        disabled: busy,
        title: t('skillRevealHint'),
        onClick: () => void revealDir(),
      }, t('skillReveal')),
      h('button', {
        className: 'dsc-btn dsc-btn--sm',
        disabled: busy,
        title: t('skillRefreshHint'),
        onClick: () => void refreshFiles(),
      }, t('skillRefresh')),
    ),
    creatingDir === null
      ? null
      : h('div', { className: 'dsc-skill-create' },
        h('input', {
          className: 'dsc-input dsc-input--sm',
          value: creatingDir,
          placeholder: t('skillNewDirPlaceholder'),
          onChange: (event: { target: { value: string } }) => setCreatingDir(event.target.value),
          onKeyDown: (event: { key: string; preventDefault: () => void }) => {
            if (event.key === 'Enter') { event.preventDefault(); void createDir() }
          },
        }),
        h('div', { className: 'dsc-hint' }, t('skillNewDirHint', { presets: presetDirs.join(' / ') })),
        h('div', { className: 'dsc-row' },
          h('button', { className: 'dsc-btn dsc-btn--sm', disabled: busy, onClick: () => void createDir() }, t('skillCreate')),
          h('button', { className: 'dsc-btn dsc-btn--sm', onClick: () => setCreatingDir(null) }, t('cancel')),
        ),
      ),
    h('div', { className: 'dsc-skill-drop-hint' }, t('skillDropHint')),
    buckets.map((bucket) => bucket.items.length === 0 && bucket.label !== ''
      ? null
      : bucket.label === ''
        // Root files (SKILL.md and anything dropped at the top level) are
        // always visible; only directories fold, so a crowded pack can be
        // collapsed per folder.
        ? h('div', { key: '.', className: 'dsc-skill-bucket' }, bucket.items.map(fileButton))
        : h('details', { key: bucket.label, className: 'dsc-fold dsc-skill-fold', open: true },
          h('summary', null, `${bucket.label}/`),
          h('div', { className: 'dsc-skill-bucket' }, bucket.items.map(fileButton)),
        ),
    ),
    creating === null
      ? null
      : h('div', { className: 'dsc-skill-create' },
        h('select', {
          className: 'dsc-input dsc-input--sm',
          value: creating.bucket,
          onChange: (event: { target: { value: string } }) => setCreating({ ...creating, bucket: event.target.value }),
        }, targetDirs.map((bucket) => h('option', { key: bucket, value: bucket }, `${bucket}/`))),
        h('input', {
          className: 'dsc-input dsc-input--sm',
          value: creating.name,
          placeholder: t('skillNewPlaceholder'),
          onChange: (event: { target: { value: string } }) => setCreating({ ...creating, name: event.target.value }),
          onKeyDown: (event: { key: string; preventDefault: () => void }) => {
            if (event.key === 'Enter') { event.preventDefault(); void createFile() }
          },
        }),
        h('div', { className: 'dsc-row' },
          h('button', { className: 'dsc-btn dsc-btn--sm', disabled: busy, onClick: () => void createFile() }, t('skillCreate')),
          h('button', { className: 'dsc-btn dsc-btn--sm', onClick: () => setCreating(null) }, t('cancel')),
        ),
      ),
  )

  const editor = h('div', { className: 'dsc-skill-main' },
    h('div', { className: 'dsc-skill-editor-head' },
      h('span', { className: 'dsc-skill-path' }, active),
      dirty ? h('span', { className: 'dsc-badge dsc-badge--warn' }, t('skillDirty')) : null,
    ),
    active === 'SKILL.md'
      ? h('div', { className: 'dsc-field' },
        h('label', null, t('skillSummary')),
        h('input', {
          className: 'dsc-input',
          value: summary,
          placeholder: t('skillSummaryPlaceholder'),
          onChange: (event: { target: { value: string } }) => { setSummary(event.target.value); setDirty(true) },
        }),
        h('div', { className: 'dsc-hint' }, t('skillSummaryHint')),
      )
      : null,
    isSkillImage(active)
      ? h('div', { className: 'dsc-skill-preview' },
        h('img', {
          src: `/comfyui/workflows/skill/raw?id=${encodeURIComponent(props.workflow.id)}&path=${encodeURIComponent(active)}`,
          alt: active,
        }),
        h('div', { className: 'dsc-hint' }, t('skillImageHint')),
      )
      : h('textarea', {
      className: 'dsc-textarea dsc-textarea--skill',
      value: text,
      spellCheck: false,
      onChange: (event: { target: { value: string } }) => { setText(event.target.value); setDirty(true) },
      onKeyDown: (event: { key: string; preventDefault: () => void; target: HTMLTextAreaElement }) => {
        // Tab indents instead of leaving the field: these files hold scripts.
        if (event.key !== 'Tab') return
        event.preventDefault()
        const area = event.target
        const start = area.selectionStart
        const end = area.selectionEnd
        setText(`${text.slice(0, start)}  ${text.slice(end)}`)
        setDirty(true)
        window.requestAnimationFrame(() => {
          area.selectionStart = start + 2
          area.selectionEnd = start + 2
        })
      },
      }),
    h('div', { className: 'dsc-row' },
      isSkillImage(active)
        ? null
        : h('button', { className: 'dsc-btn', disabled: busy || !dirty, onClick: () => void saveFile() }, t('skillSave')),
      active !== 'SKILL.md'
        ? h('button', { className: 'dsc-btn', disabled: busy, onClick: () => setRenaming({ from: active, to: active.includes('/') ? active.split('/')[1] ?? '' : active }) }, t('skillRename'))
        : null,
      active !== 'SKILL.md'
        ? h('button', { className: 'dsc-btn', disabled: busy, onClick: () => setConfirming(active) }, t('skillDeleteFile'))
        : null,
    ),
    confirming !== null && confirming !== '*pack*'
      ? h('div', { className: 'dsc-dialog dsc-dialog--danger' },
        h('div', { className: 'dsc-dialog-head dsc-danger-text' }, `${t('skillDeleteConfirm')} ${confirming}`),
        h('div', { className: 'dsc-row' },
          h('button', {
            className: 'dsc-btn dsc-btn--danger',
            disabled: busy,
            onClick: () => {
              const target = confirming
              setConfirming(null)
              void mutate({ action: 'delete', path: target }, 'SKILL.md')
            },
          }, t('confirmDelete')),
          h('button', { className: 'dsc-btn', onClick: () => setConfirming(null) }, t('cancel')),
        ),
      )
      : null,
    renaming !== null
      ? h('div', { className: 'dsc-skill-create' },
        h('input', {
          className: 'dsc-input dsc-input--sm',
          value: renaming.to,
          onChange: (event: { target: { value: string } }) => setRenaming({ ...renaming, to: event.target.value }),
        }),
        h('div', { className: 'dsc-row' },
          h('button', { className: 'dsc-btn dsc-btn--sm', disabled: busy, onClick: () => void applyRename() }, t('skillRename')),
          h('button', { className: 'dsc-btn dsc-btn--sm', onClick: () => setRenaming(null) }, t('cancel')),
        ),
      )
      : null,
  )

  return h('div', null,
    head,
    h('div', { className: 'dsc-row dsc-skill-flags' },
      h('label', { className: 'dsc-check' },
        h('input', {
          type: 'checkbox',
          checked: pack?.required === true,
          disabled: busy,
          onChange: (event: { target: { checked: boolean } }) => void mutate({ action: 'require', required: event.target.checked }),
        }),
        t('skillRequired'),
      ),
    ),
    pack !== null ? h('div', { className: 'dsc-skill-dir', title: pack.dir }, `${t('skillDir')}: ${pack.dir}`) : null,
    pendingOpen !== null
      ? h('div', { className: 'dsc-dialog' },
        h('div', { className: 'dsc-dialog-head' }, t('skillDirtyPrompt')),
        h('div', { className: 'dsc-row' },
          h('button', {
            className: 'dsc-btn',
            disabled: busy,
            onClick: () => {
              const target = pendingOpen
              setPendingOpen(null)
              void saveFile().then((ok) => { if (ok) void openFile(target) })
            },
          }, t('skillSaveAndSwitch')),
          h('button', {
            className: 'dsc-btn',
            onClick: () => {
              const target = pendingOpen
              setPendingOpen(null)
              setDirty(false)
              void openFile(target)
            },
          }, t('skillDiscard')),
          h('button', { className: 'dsc-btn', onClick: () => setPendingOpen(null) }, t('cancel')),
        ),
      )
      : null,
    notice !== null ? h('div', { className: 'dsc-ok' }, notice) : null,
    error !== null ? h(ErrorNote, { t, message: error }) : null,
    h('div', { className: 'dsc-skill' }, fileList, editor),
    // Both confirmations render next to the button that opened them: a dialog
    // pinned to the top of the view reads as "the page jumped", not as a
    // question, and destroying a pack is unrecoverable.
    h('div', { className: 'dsc-skill-footer' },
      h('div', { className: 'dsc-row' },
        h('button', { className: 'dsc-btn', disabled: busy, onClick: () => void mutate({ action: 'disable' }).then(() => props.onBack()) }, t('skillDetach')),
        h('button', { className: 'dsc-btn dsc-btn--danger', disabled: busy, onClick: () => setConfirming('*pack*') }, t('skillDestroy')),
      ),
      confirming === '*pack*'
        ? h('div', { className: 'dsc-dialog dsc-dialog--danger' },
          h('div', { className: 'dsc-dialog-head dsc-danger-text' }, t('skillDestroyConfirm', { count: pack?.files.length ?? 0 })),
          h('div', { className: 'dsc-row' },
            h('button', {
              className: 'dsc-btn dsc-btn--danger',
              disabled: busy,
              onClick: () => {
                setConfirming(null)
                void mutate({ action: 'destroy' }).then(() => props.onBack())
              },
            }, t('skillDestroyConfirmButton')),
            h('button', { className: 'dsc-btn', onClick: () => setConfirming(null) }, t('cancel')),
          ),
        )
        : null,
    ),
  )
}

function WorkflowsTab({ t }: ComfyUIPanelProps): ReturnType<typeof h> {
  const [list, setList] = useState<WorkflowEntry[] | null>(null)
  const [comfyui, setComfyui] = useState<ComfyUIWorkflowEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [comfyuiError, setComfyuiError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState<WorkflowDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [viewing, setViewing] = useState<WorkflowViewState | null>(null)
  const [extract, setExtract] = useState<ExtractState | null>(null)
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [skillFor, setSkillFor] = useState<WorkflowEntry | null>(null)
  /** A delete waiting on the user's answer about the workflow's skill pack. */
  const [deleting, setDeleting] = useState<WorkflowEntry | null>(null)

  const load = async (): Promise<void> => {
    try {
      const data = await getJson<{ workflows: WorkflowEntry[] }>('/comfyui/workflows')
      setList(data.workflows)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    try {
      const data = await getJson<{ workflows: ComfyUIWorkflowEntry[] }>('/comfyui/comfy-workflows')
      setComfyui(data.workflows)
      setComfyuiError(null)
    } catch (cause) {
      setComfyuiError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  useEffect(() => {
    let cancelled = false
    void getJson<{ workflows: WorkflowEntry[] }>('/comfyui/workflows').then((data) => {
      if (!cancelled) setList(data.workflows)
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
    })
    void getJson<{ workflows: ComfyUIWorkflowEntry[] }>('/comfyui/comfy-workflows').then((data) => {
      if (!cancelled) setComfyui(data.workflows)
    }).catch((cause: unknown) => {
      if (!cancelled) setComfyuiError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => {
      cancelled = true
    }
  }, [])

  /** Persist the current draft; returns the saved workflow id, or null on failure (error already set). */
  const persist = async (): Promise<string | null> => {
    if (editing === null) return null
    setBusy(true)
    setError(null)
    setNotice(null)
    let workflow: unknown
    if (typeof editing.workflow === 'string') {
      try {
        workflow = JSON.parse(editing.workflow)
      } catch {
        setError(t('wfJsonError'))
        setBusy(false)
        return null
      }
    } else {
      workflow = editing.workflow
    }
    try {
      const body: Record<string, unknown> = {
        name: String(editing.name ?? ''),
        description: String(editing.description ?? ''),
        workflow,
        parameters: editing.parameters ?? [],
        tags: editing.tags ?? [],
      }
      if (editing.id !== undefined) body.id = editing.id
      const result = (await postJson('/comfyui/workflows', body)) as { workflow?: { id?: string } }
      return result.workflow?.id ?? (typeof editing.id === 'string' ? editing.id : null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return null
    } finally {
      setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    const id = await persist()
    if (id === null) return
    setEditing(null)
    await load()
  }

  /** Save the draft, then immediately queue it with the saved parameters. */
  const saveAndRun = async (): Promise<void> => {
    const id = await persist()
    if (id === null) return
    setEditing(null)
    await load()
    await run(id)
  }

  const run = async (id: string): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = (await postJson('/comfyui/workflows/run', { id })) as { promptId: string }
      setNotice(`${t('wfQueued')} ${shortId(result.promptId)}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  /** Delete a workflow. A workflow carrying a skill pack asks first: the pack
   * holds hand-written notes that nothing else can restore. */
  const remove = async (id: string, deleteSkill = false): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await postJson('/comfyui/workflows/delete', { id, deleteSkill })
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const requestRemove = (workflow: WorkflowEntry): void => {
    if (workflow.skillDir !== undefined) {
      setDeleting(workflow)
      return
    }
    void remove(workflow.id)
  }

  const openExtract = (file: string): void => {
    setError(null)
    setExtract({ file, analysis: null, error: null, mode: 'split' })
  }

  const runExtract = async (state: ExtractState): Promise<void> => {
    setBusy(true)
    try {
      const data = (await postJson('/comfyui/comfy-workflows/extract', { file: state.file, mode: state.mode })) as { ok: boolean; saved: WorkflowEntry[]; warnings: string[]; error?: string }
      if (data.ok !== true) throw new Error(data.error ?? 'failed to extract')
      setNotice(`${state.file} → ${t('wfExtractedNotice')}${data.warnings.length > 0 ? `（${t('error')}: ${data.warnings.join('；')}）` : ''}`)
      setExtract(null)
      await load()
    } catch (cause) {
      setExtract({ ...state, error: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setBusy(false)
    }
  }

  const importFile = (file: File): void => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as unknown
        setEditing({ name: file.name.replace(/\.json$/i, ''), workflow: parsed as Record<string, unknown> })
        setError(null)
      } catch {
        setError(t('wfJsonError'))
      }
    }
    reader.readAsText(file)
  }

  const view = async (file: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const data = await getJson<{ ok: boolean; workflow?: Record<string, unknown>; error?: string }>(`/comfyui/comfy-workflows?file=${encodeURIComponent(file)}`)
      if (data.ok !== true || data.workflow === undefined) {
        throw new Error(data.error ?? 'failed to read workflow')
      }
      setViewing({ file, graph: data.workflow })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  if (skillFor !== null) {
    return h(SkillPackEditor, {
      t,
      workflow: skillFor,
      onBack: () => { setSkillFor(null); void load() },
      onChanged: () => { void load() },
    })
  }
  if (viewing !== null) {
    return h(WorkflowView, { t, file: viewing.file, graph: viewing.graph, onBack: () => setViewing(null) })
  }
  if (extract !== null) {
    return h(ExtractDialog, { t, state: extract, onUpdate: setExtract, onRun: (state) => runExtract(state), onClose: () => setExtract(null) })
  }
  if (error !== null) return h('div', null, h(ErrorNote, { t, message: error }))
  if (list === null) return h('div', { className: 'dsc-meta' }, '…')

  if (editing !== null) {
    return h('div', { className: 'dsc-form' },
      h('div', { className: 'dsc-field' },
        h('label', null, t('wfName')),
        h('input', { className: 'dsc-input', value: editing.name ?? '', onChange: (event: { target: { value: string } }) => setEditing({ ...editing, name: event.target.value }) }),
      ),
      h('div', { className: 'dsc-field' },
        h('label', null, t('wfDesc')),
        h('textarea', { className: 'dsc-textarea', placeholder: t('wfDescPlaceholder'), value: editing.description ?? '', onChange: (event: { target: { value: string } }) => setEditing({ ...editing, description: event.target.value }) }),
      ),
      h('div', { className: 'dsc-field' },
        h('label', null, t('wfTags')),
        h(TagEditor, { t, tags: editing.tags ?? [], onChange: (tags) => setEditing({ ...editing, tags }) }),
      ),
      h('div', { className: 'dsc-field' },
        h('label', null, t('wfParams')),
        h(ParameterEditor, {
          t,
          params: editing.parameters ?? [],
          workflow: parseDraftWorkflow(editing.workflow),
          onChange: (parameters) => setEditing({ ...editing, parameters }),
        }),
      ),
      h('div', { className: 'dsc-field' },
        h('label', null, t('wfJson')),
        h('textarea', {
          className: 'dsc-textarea dsc-textarea--json',
          value: typeof editing.workflow === 'string' ? editing.workflow : JSON.stringify(editing.workflow ?? {}, null, 2),
          onChange: (event: { target: { value: string } }) => setEditing({ ...editing, workflow: event.target.value }),
        }),
      ),
      notice !== null ? h('div', { className: 'dsc-ok' }, notice) : null,
      error !== null ? h(ErrorNote, { t, message: error }) : null,
      h('div', { className: 'dsc-row' },
        h('button', { className: 'dsc-btn', disabled: busy, onClick: () => void save() }, t('wfSave')),
        h('button', { className: 'dsc-btn', disabled: busy, onClick: () => void saveAndRun() }, t('wfSaveRun')),
        h('button', { className: 'dsc-btn', disabled: busy, onClick: () => { setEditing(null); setError(null) } }, t('wfCancel')),
      ),
    )
  }

  const comfyuiFold = h('details', { className: 'dsc-fold' },
    h('summary', null, `${t('wfComfyuiSection')} (${comfyui?.length ?? 0})`),
    h('div', { className: 'dsc-fold-body' },
      h('div', { className: 'dsc-hint' }, t('wfComfyuiHint')),
      comfyuiError !== null ? h(ErrorNote, { t, message: comfyuiError }) : null,
      comfyui === null
        ? h('div', { className: 'dsc-meta' }, '…')
        : comfyui.length === 0
          ? h('div', { className: 'dsc-meta' }, t('wfComfyuiEmpty'))
          : h('div', { className: 'dsc-list' }, comfyui.map((workflow) => h('div', { key: workflow.name, className: 'dsc-wf dsc-wf--comfyui', title: t('wfNameCopyHint'), onClick: () => { void copyText(workflow.name).then((ok) => { if (ok) setNotice(`${t('wfNameCopied')}：${workflow.name}`) }) } },
            h('div', { className: 'dsc-wf-col' },
              h('div', { className: 'dsc-wf-name', title: workflow.name }, workflow.name),
              h('div', { className: 'dsc-wf-actions' },
                h('button', { className: 'dsc-btn', disabled: busy, onClick: (event: { stopPropagation: () => void }) => { event.stopPropagation(); void view(workflow.name) } }, t('wfView')),
                h('button', { className: 'dsc-btn', disabled: busy, onClick: (event: { stopPropagation: () => void }) => { event.stopPropagation(); openExtract(workflow.name) } }, t('wfExtract')),
              ),
              h('div', { className: 'dsc-meta' }, [formatBytes(workflow.size), workflow.modified !== undefined ? formatTs(new Date(workflow.modified).toISOString()) : ''].filter(Boolean).join(' · ')),
            ),
            h('span', { className: workflow.extracted ? 'dsc-badge dsc-badge--ok' : 'dsc-badge dsc-badge--warn' }, workflow.extracted ? `${t('wfExtracted')} ${workflow.derived.length}` : t('wfNotExtracted')),
          ))),
    ),
  )

  // Tag filter bar: every tag present in the library, preset order first,
  // with counts; null = all workflows.
  const tagCounts = new Map<string, number>()
  for (const workflow of list) {
    for (const tag of workflow.tags ?? []) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
  }
  const visibleTags = [...tagCounts.entries()].sort((a, b) => {
    const pa = PRESET_TAGS.indexOf(a[0])
    const pb = PRESET_TAGS.indexOf(b[0])
    if (pa !== -1 && pb !== -1) return pa - pb
    if (pa !== -1) return -1
    if (pb !== -1) return 1
    return b[1] - a[1]
  }).map(([tag]) => tag)
  const visibleList = tagFilter === null ? list : list.filter((workflow) => (workflow.tags ?? []).includes(tagFilter))

  const apiFold = h('details', { className: 'dsc-fold', open: true },
    h('summary', null, `${t('wfLibrarySection')} (${visibleList.length})`),
    h('div', { className: 'dsc-fold-body' },
      visibleTags.length > 0 || tagFilter !== null
        ? h('div', { className: 'dsc-tag-filter' },
            // A simple dropdown instead of a chip row: the library can grow
            // many custom tags, and a horizontal strip of chips would push the
            // workflow list down and visually crowd the toolbar. First option
            // is always "all"; picking a tag filters, picking "all" clears.
            h('select', {
              className: 'dsc-input dsc-input--inline',
              title: t('wfTags'),
              value: tagFilter ?? '',
              onChange: (event: { target: { value: string } }) => setTagFilter(event.target.value === '' ? null : event.target.value),
            },
              h('option', { value: '' }, `${t('wfTagAll')} (${list.length})`),
              visibleTags.map((tag) => h('option', { key: tag, value: tag }, `${tag} (${tagCounts.get(tag) ?? 0})`)),
            ),
          )
        : null,
      visibleList.length === 0
        ? h('div', { className: 'dsc-meta' }, t('wfEmpty'))
        : h('div', { className: 'dsc-list' }, visibleList.map((workflow) => h('div', { key: workflow.id, className: 'dsc-wf', title: t('wfNameCopyHint'), onClick: () => { void copyText(workflow.name).then((ok) => { if (ok) setNotice(`${t('wfNameCopied')}：${workflow.name}`) }) } },
          h('div', { className: 'dsc-wf-top' },
            h('div', { className: 'dsc-wf-name', title: workflow.name }, workflow.name),
            (workflow.tags ?? []).length > 0
              ? h('div', { className: 'dsc-wf-tags' }, (workflow.tags ?? []).map((tag) => h('span', { key: tag, className: 'dsc-tag-chip dsc-tag-chip--mini' }, tag)))
              : null,
            workflow.skillDir !== undefined
              ? h('span', { className: 'dsc-badge dsc-badge--ok', title: t('skillBadgeHint') }, workflow.requireSkill === true ? t('skillBadgeRequired') : t('skillBadge'))
              : null,
          ),
          workflow.description !== '' ? h('div', { className: 'dsc-wf-desc' }, workflow.description) : null,
          h('div', { className: 'dsc-wf-updated' }, `${t('wfUpdated')} ${formatTs(workflow.updatedAt)}`),
          h('div', { className: 'dsc-wf-actions' },
            h('button', { className: 'dsc-btn', disabled: busy, onClick: (event: { stopPropagation: () => void }) => { event.stopPropagation(); void run(workflow.id) } }, t('wfRun')),
            h('button', { className: 'dsc-btn', disabled: busy, onClick: (event: { stopPropagation: () => void }) => { event.stopPropagation(); setEditing({ ...workflow, workflow: JSON.stringify(workflow.workflow, null, 2), parameters: workflow.parameters ?? [], tags: workflow.tags ?? [] }); setError(null) } }, t('wfEdit')),
            h('button', { className: 'dsc-btn', disabled: busy, onClick: (event: { stopPropagation: () => void }) => { event.stopPropagation(); setSkillFor(workflow); setError(null) } }, t('skillButton')),
            h('button', { className: 'dsc-btn', disabled: busy, onClick: (event: { stopPropagation: () => void }) => { event.stopPropagation(); requestRemove(workflow) } }, t('wfDelete')),
          ),
          deleting?.id === workflow.id
            ? h('div', { className: 'dsc-dialog dsc-dialog--danger', onClick: (event: { stopPropagation: () => void }) => event.stopPropagation() },
              h('div', { className: 'dsc-dialog-head dsc-danger-text' }, t('skillDeleteWithWorkflow')),
              h('div', { className: 'dsc-row' },
                h('button', { className: 'dsc-btn dsc-btn--danger', disabled: busy, onClick: () => { setDeleting(null); void remove(workflow.id, true) } }, t('skillDeleteBoth')),
                h('button', { className: 'dsc-btn', disabled: busy, onClick: () => { setDeleting(null); void remove(workflow.id, false) } }, t('skillKeepPack')),
                h('button', { className: 'dsc-btn', onClick: () => setDeleting(null) }, t('cancel')),
              ),
            )
            : null,
        ))),
    ),
  )

  return h('div', null,
    h('div', { className: 'dsc-toolbar' },
      h('button', { className: 'dsc-btn', disabled: busy, onClick: () => { setEditing({ workflow: {}, parameters: [], tags: [] }); setError(null) } }, t('wfAdd')),
      h('label', { className: 'dsc-btn' },
        t('wfImportFile'),
        h('input', {
          type: 'file',
          accept: '.json,application/json',
          style: { display: 'none' },
          onChange: (event: { target: HTMLInputElement }) => {
            const file = event.target.files?.[0]
            if (file !== undefined) importFile(file)
            event.target.value = ''
          },
        }),
      ),
      h('button', { className: 'dsc-btn', disabled: busy, onClick: () => void load() }, t('wfRefresh')),
    ),
    notice !== null ? h('div', { className: 'dsc-ok' }, notice) : null,
    comfyuiFold,
    apiFold,
    h(LoadArea, { t, onNotice: setNotice }),
  )
}

/** Extract-mode chooser: shows the canvas analysis and lets the user pick how
 * to extract runnable API workflows from a ComfyUI-side graph. */
function ExtractDialog(props: {
  t: ComfyUIPanelProps['t']
  state: ExtractState
  onUpdate: (state: ExtractState) => void
  onRun: (state: ExtractState) => Promise<void>
  onClose: () => void
}): ReturnType<typeof h> {
  const { t, state, onUpdate, onRun, onClose } = props
  useEffect(() => {
    if (state.analysis === null && state.error === null) {
      let cancelled = false
      void getJson<{ ok: boolean; analysis?: GraphAnalysis; error?: string }>(`/comfyui/comfy-workflows/analyze?file=${encodeURIComponent(state.file)}`)
        .then((data) => {
          if (cancelled) return
          if (data.ok !== true || data.analysis === undefined) onUpdate({ ...state, error: data.error ?? 'failed to analyze' })
          else onUpdate({ ...state, analysis: data.analysis, mode: data.analysis.mode === 'single' ? 'all' : 'split' })
        })
        .catch((cause: unknown) => {
          if (!cancelled) onUpdate({ ...state, error: cause instanceof Error ? cause.message : String(cause) })
        })
      return () => {
        cancelled = true
      }
    }
    return undefined
  })

  const modes: Array<{ mode: ExtractMode; label: string; hint: string }> = [
    { mode: 'all', label: t('wfExtractModeAll'), hint: t('wfExtractModeAllHint') },
    { mode: 'split', label: t('wfExtractModeSplit'), hint: t('wfExtractModeSplitHint') },
    { mode: 'main', label: t('wfExtractModeMain'), hint: t('wfExtractModeMainHint') },
  ]
  const analysis = state.analysis
  return h('div', { className: 'dsc-dialog' },
    h('div', { className: 'dsc-dialog-head' },
      h('span', { className: 'dsc-wf-name' }, `${t('wfExtractTitle')}: ${state.file}`),
      h('button', { className: 'dsc-panel-close', 'aria-label': t('close'), onClick: onClose }, '✕'),
    ),
    analysis === null
      ? h('div', { className: 'dsc-meta' }, '…')
      : h('div', null,
          h('div', { className: 'dsc-hint' },
            `${t('wfComponents')}: ${analysis.components.length} · ${t('wfBypassed')}: ${analysis.bypassedCount} · ${t('wfIsolated')}: ${analysis.isolated.length}`,
          ),
          analysis.components.length > 0
            ? h('ul', { className: 'dsc-node-list' },
                analysis.components.map((component) => h('li', { key: String(component.index) },
                  `${t('wfComponentLabel')} ${component.index}（${component.size} ${t('wfNodes')}）${component.groups.length > 0 ? `[${component.groups.slice(0, 3).join('+')}]` : ''}`,
                )),
              )
            : h('div', { className: 'dsc-meta' }, t('wfExtractEmpty')),
          h('div', { className: 'dsc-extract-modes' },
            modes.map((entry) => h('label', { key: entry.mode, className: 'dsc-mode' },
              h('input', {
                type: 'radio',
                name: 'extract-mode',
                checked: state.mode === entry.mode,
                onChange: () => onUpdate({ ...state, mode: entry.mode }),
              }),
              h('span', { className: 'dsc-mode-label' }, entry.label),
              h('span', { className: 'dsc-hint' }, entry.hint),
            )),
          ),
          state.error !== null ? h(ErrorNote, { t, message: state.error }) : null,
          h('div', { className: 'dsc-row' },
            h('button', { className: 'dsc-btn', disabled: analysis.components.length === 0, onClick: () => void onRun(state) }, t('wfExtractRun')),
            h('button', { className: 'dsc-btn', onClick: onClose }, t('wfCancel')),
          ),
        ),
  )
}

/** Read-only inspection of a ComfyUI-side saved workflow: node list + JSON. */
function WorkflowView(props: { t: ComfyUIPanelProps['t']; file: string; graph: Record<string, unknown>; onBack: () => void }): ReturnType<typeof h> {
  const nodes = Array.isArray(props.graph.nodes)
    ? (props.graph.nodes as Array<Record<string, unknown>>).filter((node) => node.mode !== 4 && typeof node.type === 'string' && node.type !== '')
    : []
  const json = JSON.stringify(props.graph, null, 2)
  return h('div', { className: 'dsc-view' },
    h('div', { className: 'dsc-view-head' },
      h('span', { className: 'dsc-wf-name' }, props.file),
      h('button', { className: 'dsc-btn', onClick: props.onBack }, props.t('wfViewBack')),
    ),
    h('div', { className: 'dsc-view-label' }, `${props.t('wfViewNodes')} (${nodes.length})`),
    nodes.length === 0
      ? h('div', { className: 'dsc-meta' }, props.t('wfViewEmpty'))
      : h('ul', { className: 'dsc-node-list' }, nodes.map((node) => h('li', { key: String(node.id) }, `${String(node.id)} · ${String(node.type)}`))),
    h('div', { className: 'dsc-view-label' }, props.t('wfViewJson')),
    h('textarea', { className: 'dsc-textarea dsc-textarea--json dsc-textarea--view', readOnly: true, value: json }),
  )
}

/** Tab 2: asset preview — thumbnails of everything the plugin generated. */
function AssetsTab({ t, onPreview }: { t: ComfyUIPanelProps['t']; onPreview: (images: string[], kinds: Array<'image' | 'video' | 'audio' | 'other'>, index: number) => void }): ReturnType<typeof h> {
  const [assets, setAssets] = useState<AssetEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState(() => panelStore.getAssetFilter())
  /** Asset awaiting the delete confirmation, if any. */
  const [pendingDelete, setPendingDelete] = useState<AssetEntry | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    try {
      const data = await getJson<{ assets: AssetEntry[] }>('/comfyui/assets')
      setAssets(data.assets)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  useEffect(() => {
    let cancelled = false
    void getJson<{ assets: AssetEntry[] }>('/comfyui/assets').then((data) => {
      if (!cancelled) setAssets(data.assets)
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => {
      cancelled = true
    }
  }, [])

  /** Delete the record and (when the output directory is known) its files. */
  const confirmDelete = async (asset: AssetEntry): Promise<void> => {
    setDeleting(true)
    try {
      const result = (await postJson('/comfyui/assets/delete', { promptId: asset.promptId })) as
        { ok?: boolean; error?: string; deleted?: number; failures?: string[] }
      if (result.ok !== true) throw new Error(result.error ?? 'delete failed')
      setPendingDelete(null)
      setNotice(t('assetDeleteDone', { deleted: result.deleted ?? 0 }))
      if (Array.isArray(result.failures) && result.failures.length > 0) {
        setError(result.failures.join('; '))
      }
      await load()
    } catch (cause) {
      setError(t('assetDeleteFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
      setPendingDelete(null)
    } finally {
      setDeleting(false)
    }
  }

  if (error !== null && assets === null) return h('div', null, h(ErrorNote, { t, message: error }))
  if (assets === null) return h('div', { className: 'dsc-meta' }, '…')

  const names = [...new Set(assets.map((asset) => asset.workflowName ?? ''))]
  const visible = filter === '' ? assets : assets.filter((asset) => (asset.workflowName ?? '') === filter)
  // Every media item in the visible grid, in display order, for the lightbox
  // sequence (videos/audio included so clicking a thumbnail can play it).
  const previewItems = visible.flatMap((asset) => asset.media.map((item) => ({ url: item.url, kind: item.kind })))
  const openAsset = (asset: AssetEntry): void => {
    const first = asset.media[0]
    const index = first !== undefined ? previewItems.findIndex((item) => item.url === first.url) : 0
    onPreview(previewItems.map((item) => item.url), previewItems.map((item) => item.kind), index < 0 ? 0 : index)
  }

  return h('div', null,
    h('div', { className: 'dsc-toolbar' },
      h('select', { className: 'dsc-input dsc-input--inline', value: filter, onChange: (event: { target: { value: string } }) => setFilter(event.target.value) },
        h('option', { value: '' }, t('assetAll')),
        names.map((name) => h('option', { key: name, value: name }, name === '' ? '—' : name)),
      ),
      h('button', { className: 'dsc-btn', onClick: () => void load() }, t('refresh')),
    ),
    error !== null ? h(ErrorNote, { t, message: error }) : null,
    notice !== null ? h('div', { className: 'dsc-ok' }, notice) : null,
    visible.length === 0
      ? h('div', { className: 'dsc-meta' }, t('assetEmpty'))
      : h('div', { className: 'dsc-assets-grid' }, visible.map((asset) => h(AssetThumb, {
          key: asset.promptId,
          asset,
          t,
          onClick: () => openAsset(asset),
          onDelete: () => { setNotice(null); setPendingDelete(asset) },
        }))),
    pendingDelete !== null
      ? h(ConfirmDialog, {
          t,
          title: t('assetDeleteTitle'),
          body: t('assetDeleteBody', { count: pendingDelete.media.length }),
          detail: pendingDelete.media.map((item) => item.filename).join('、'),
          busy: deleting,
          onConfirm: () => { void confirmDelete(pendingDelete) },
          onCancel: () => setPendingDelete(null),
        })
      : null,
  )
}

/** Modal confirmation for a destructive action (asset deletion). */
function ConfirmDialog(props: {
  t: ComfyUIPanelProps['t']
  title: string
  body: string
  detail?: string
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}): ReturnType<typeof h> {
  return h('div', { className: 'dsc-picker-overlay', onClick: props.onCancel },
    h('div', { className: 'dsc-confirm', onClick: (event: { stopPropagation: () => void }) => event.stopPropagation() },
      h('div', { className: 'dsc-confirm-title' }, props.title),
      h('div', { className: 'dsc-confirm-body' }, props.body),
      props.detail !== undefined && props.detail !== ''
        ? h('div', { className: 'dsc-confirm-detail' }, props.detail)
        : null,
      h('div', { className: 'dsc-confirm-actions' },
        h('button', { className: 'dsc-btn', disabled: props.busy, onClick: props.onCancel }, props.t('cancel')),
        h('button', { className: 'dsc-btn dsc-btn--danger', disabled: props.busy, onClick: props.onConfirm }, props.t('confirmDelete')),
      ),
    ),
  )
}

function AssetThumb(props: { asset: AssetEntry; t: ComfyUIPanelProps['t']; onClick: () => void; onDelete: () => void }): ReturnType<typeof h> {
  const first = props.asset.media[0]
  const [broken, setBroken] = useState(false)
  // Deleting is destructive, so the button stays out of the way until the
  // pointer is on the card, and it never triggers the card's own click.
  const trash = h('button', {
    className: 'dsc-asset-trash',
    title: props.t('assetDelete'),
    'aria-label': props.t('assetDelete'),
    onClick: (event: { stopPropagation: () => void }) => {
      event.stopPropagation()
      props.onDelete()
    },
  }, '🗑')
  if (first === undefined || broken) {
    return h('div', { className: 'dsc-asset dsc-asset--empty', onClick: props.onClick },
      h('div', null, props.t('assetGone')),
      h('div', { className: 'dsc-meta' }, props.asset.workflowName ?? '—'),
      trash,
    )
  }
  return h('div', { className: 'dsc-asset', onClick: props.onClick },
    first.kind === 'video'
      ? h('video', { src: first.url, controls: true, preload: 'metadata', onClick: (event: { stopPropagation: () => void }) => event.stopPropagation() })
      : first.kind === 'audio'
        // Audio cards show a plain note icon + filename (no player inline —
        // an <img> or <audio> here mislabels live files as evicted or squats
        // in the grid); the actual player opens in the lightbox preview.
        ? h('div', { className: 'dsc-asset-audio-icon' },
            // Dim waveform bars tiled across the green tile (pure decoration;
            // the speaker glyph stays on top).
            h('svg', { className: 'dsc-asset-audio-icon-wave', 'aria-hidden': 'true' },
              h('defs', null,
                // One horizontal waveform: the pattern tile is as tall as the
                // card (110px) so nothing repeats vertically, and the bars are
                // thin (2px) and dense (6px spacing) for a fine waveform look.
                h('pattern', { id: 'dsc-wave-pattern', width: 64, height: 110, patternUnits: 'userSpaceOnUse' },
                  h('g', { fill: 'rgba(255,255,255,0.15)' },
                    h('rect', { x: 0, y: 50, width: 2, height: 10, rx: 1 }),
                    h('rect', { x: 4, y: 44, width: 2, height: 22, rx: 1 }),
                    h('rect', { x: 8, y: 48, width: 2, height: 14, rx: 1 }),
                    h('rect', { x: 12, y: 38, width: 2, height: 34, rx: 1 }),
                    h('rect', { x: 16, y: 46, width: 2, height: 18, rx: 1 }),
                    h('rect', { x: 20, y: 52, width: 2, height: 6, rx: 1 }),
                    h('rect', { x: 24, y: 40, width: 2, height: 30, rx: 1 }),
                    h('rect', { x: 28, y: 48, width: 2, height: 14, rx: 1 }),
                    h('rect', { x: 32, y: 42, width: 2, height: 26, rx: 1 }),
                    h('rect', { x: 36, y: 36, width: 2, height: 38, rx: 1 }),
                    h('rect', { x: 40, y: 47, width: 2, height: 16, rx: 1 }),
                    h('rect', { x: 44, y: 51, width: 2, height: 8, rx: 1 }),
                    h('rect', { x: 48, y: 40, width: 2, height: 30, rx: 1 }),
                    h('rect', { x: 52, y: 45, width: 2, height: 20, rx: 1 }),
                    h('rect', { x: 56, y: 38, width: 2, height: 34, rx: 1 }),
                    h('rect', { x: 60, y: 49, width: 2, height: 12, rx: 1 })))),
              h('rect', { width: '100%', height: '100%', fill: 'url(#dsc-wave-pattern)' })),
            h('svg', { className: 'dsc-asset-audio-icon-sym', viewBox: '0 0 24 24', 'aria-hidden': 'true', dangerouslySetInnerHTML: { __html: '<path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>' } }),
            h('span', { className: 'dsc-asset-audio-icon-name', title: first.filename }, first.filename))
        : h('img', { src: first.url, alt: first.filename, loading: 'lazy', onError: () => setBroken(true) }),
    h('div', { className: 'dsc-asset-meta' }, props.asset.workflowName ?? '—'),
    trash,
  )
}

/**
 * Tab 3: the task center — active tasks (pending / generating) shown as
 * cards with id, status and progress, plus history filtered by the
 * completed / failed / cancelled chips. Polled every 3 seconds.
 */
function QueueTab({ t, onPreview }: { t: ComfyUIPanelProps['t']; onPreview: (images: string[], kinds: Array<'image' | 'video' | 'audio' | 'other'>, index: number) => void }): ReturnType<typeof h> {
  const [filter, setFilter] = useState<JobFilter>('all')
  const [active, setActive] = useState<JobView[] | null>(null)
  const [history, setHistory] = useState<JobView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async (current: JobFilter): Promise<void> => {
    try {
      const historyStatus = current === 'all' ? 'completed,failed,cancelled' : current
      const [activeData, historyData] = await Promise.all([
        getJson<JobsView>('/comfyui/jobs?status=pending,in_progress&limit=100'),
        getJson<JobsView>(`/comfyui/jobs?status=${historyStatus}&limit=100`),
      ])
      if (activeData.ok !== true) throw new Error(activeData.error ?? t('queueError'))
      if (historyData.ok !== true) throw new Error(historyData.error ?? t('queueError'))
      // Active queue: earliest submitted first (running on top, later joins append below).
      setActive([...(activeData.jobs ?? [])].sort((a, b) => (a.createTime ?? 0) - (b.createTime ?? 0)))
      setHistory(historyData.jobs)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  useEffect(() => {
    void load(filter)
    const timer = setInterval(() => void load(filter), 3_000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter])

  const act = async (payload: Record<string, unknown>): Promise<void> => {
    setBusy(true)
    try {
      const data = (await postJson('/comfyui/jobs/actions', payload)) as { ok: boolean; error?: string }
      if (data.ok !== true) throw new Error(data.error ?? 'action failed')
      await load(filter)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  if (error !== null) return h('div', null, h(ErrorNote, { t, message: error }))
  if (active === null || history === null) return h('div', { className: 'dsc-meta' }, '…')

  // Preview image sequence over the history list, plus each job's position in it.
  const historyPreviewUrls = history.map(previewUrlOf)
  const previewImages = historyPreviewUrls.filter((url): url is string => url !== null)
  const previewPrefix: number[] = []
  {
    let acc = 0
    for (const url of historyPreviewUrls) {
      previewPrefix.push(acc)
      if (url !== null) acc += 1
    }
  }

  return h('div', { className: 'dsc-list' },
    h('div', { className: 'dsc-queue-actions' },
      h('button', { className: 'dsc-btn', onClick: () => void act({ action: 'clear' }), disabled: busy }, t('jobClearQueue')),
      h('button', { className: 'dsc-btn', onClick: () => void act({ action: 'clearHistory' }), disabled: busy }, t('jobClearHistory')),
      h('button', { className: 'dsc-btn', onClick: () => void act({ action: 'free', unloadModels: true, freeMemory: true }), disabled: busy }, t('jobFree')),
    ),
    h('div', { className: 'dsc-section' },
      h('div', { className: 'dsc-section-head' },
        h('span', { className: 'dsc-section-title' }, `${t('jobActive')} (${active.length})`),
      ),
      active.length === 0
        ? h('div', { className: 'dsc-meta' }, t('queueEmpty'))
        : h('div', { className: 'dsc-list' }, active.map((job) => h(JobRow, { key: job.id, job, t, busy, act }))),
    ),
    h('div', { className: 'dsc-section' },
      h('div', { className: 'dsc-section-head' },
        h('span', { className: 'dsc-section-title' }, `${t('jobFilterLabel')} (${history.length})`),
        h('div', { className: 'dsc-queue-head' },
          JOB_FILTERS.map((item) =>
            h('button', {
              key: item.key,
              className: `dsc-chip${filter === item.key ? ' dsc-chip--active' : ''}`,
              onClick: () => setFilter(item.key),
              disabled: busy,
            }, t(item.label))),
        ),
      ),
      history.length === 0
        ? h('div', { className: 'dsc-meta' }, t('queueEmpty'))
        : h('div', { className: 'dsc-list' }, history.map((job, index) => h(JobRow, {
            key: job.id,
            job,
            t,
            busy,
            act,
            onPreview: historyPreviewUrls[index] !== null && previewImages.length > 0
              ? () => onPreview(previewImages, previewImages.map(() => 'image' as const), previewPrefix[index]!)
              : undefined,
          }))),
    ),
  )
}

function jobBadge(status: JobStatus): string {
  switch (status) {
    case 'in_progress': return 'dsc-badge--info'
    case 'completed': return 'dsc-badge--ok'
    case 'failed': return 'dsc-badge--danger'
    default: return ''
  }
}

const STATUS_LABELS: Record<JobStatus, string> = {
  pending: 'jobFilterPending',
  in_progress: 'jobFilterInProgress',
  completed: 'jobFilterCompleted',
  failed: 'jobFilterFailed',
  cancelled: 'jobFilterCancelled',
}

/**
 * One task card: a compact row with a status badge, task name + short id,
 * duration (and error/progress for in-flight tasks), and a ⋯ menu with
 * per-state actions. Hover highlights the row. Rendered as a component
 * instance (h(JobRow, ...)) so its hooks stay per-card.
 */
function JobRow(props: {
  job: JobView
  t: ComfyUIPanelProps['t']
  busy: boolean
  act: (payload: Record<string, unknown>) => Promise<void>
  onPreview?: () => void
}): ReturnType<typeof h> {
  const { job, t, busy, act, onPreview } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onDoc = (event: MouseEvent): void => {
      if (menuRef.current !== null && !menuRef.current.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [menuOpen])

  const running = job.status === 'in_progress'
  const terminal = job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled'
  const pct = job.progress !== null && job.progress !== undefined && job.progress.max > 0
    ? Math.min(100, Math.round((job.progress.value / job.progress.max) * 100))
    : null
  const duration = job.executionStartTime !== null && job.executionEndTime !== null
    ? Math.max(0, Math.round(((job.executionEndTime ?? 0) - (job.executionStartTime ?? 0)) / 1000))
    : null
  const errMsg = job.executionError?.exception_message ?? job.executionError?.message
  const name = job.workflowName ?? job.workflowId
  const preview = previewUrlOf(job)
  const close = (): void => setMenuOpen(false)
  const statusClass = job.status === 'failed' ? ' dsc-job-item--failed' : job.status === 'cancelled' ? ' dsc-job-item--cancelled' : ''

  return h('div', { className: `dsc-job-item${statusClass}` },
    preview !== null
      ? h('img', {
          src: preview,
          alt: '',
          loading: 'lazy',
          className: onPreview !== undefined ? 'dsc-job-preview dsc-job-preview--clickable' : 'dsc-job-preview',
          onClick: onPreview,
        })
      : null,
    h('div', { className: 'dsc-job-main' },
      h('div', { className: 'dsc-job-name', title: name ?? undefined },
        name !== null && name !== undefined && name !== '' ? name : '—',
      ),
      h('div', { className: 'dsc-job-mid' },
        running && job.progress !== null && job.progress !== undefined
          ? h('div', { className: 'dsc-progress' },
              h('div', { className: 'dsc-progress-track' },
                h('div', { className: 'dsc-progress-fill', style: { width: `${pct ?? 0}%` } }),
              ),
              h('span', { className: 'dsc-job-progress' },
                `${job.progress.value}/${job.progress.max} · ${pct ?? 0}%`,
              ),
            )
          : null,
        h('div', { className: 'dsc-job-mid-right' },
          h('span', { className: `dsc-badge dsc-badge--status ${jobBadge(job.status)}` }, t(STATUS_LABELS[job.status] ?? job.status)),
          h('div', { ref: menuRef, className: 'dsc-job-menu' },
            h('button', {
              className: 'dsc-job-menu-btn',
              'aria-label': t('jobMore'),
              onClick: () => setMenuOpen(!menuOpen),
            }, '⋯'),
            menuOpen ? h('div', { className: 'dsc-job-menu-pop' },
              job.status === 'pending'
                ? h('button', { onClick: () => { void act({ action: 'delete', ids: [job.id] }); close() } }, t('jobDelete'))
                : null,
              running
                ? h('button', { onClick: () => { void act({ action: 'interrupt', promptId: job.id }); close() } }, t('jobInterrupt'))
                : null,
              terminal
                ? h('button', { onClick: () => { void act({ action: 'deleteHistory', ids: [job.id] }); close() } }, t('jobDelete'))
                : null,
              terminal
                ? h('button', { onClick: () => { void act({ action: 'rerun', jobId: job.id }); close() } }, t('jobRerun'))
                : null,
              terminal
                ? h('button', { onClick: () => { panelStore.setAssetFilter(name ?? ''); panelStore.setTab('assets'); close() } }, t('jobViewAssets'))
                : null,
            ) : null,
          ),
        ),
      ),
      h('div', { className: 'dsc-job-bottom' },
        h('span', { className: 'dsc-job-duration' }, `${t('jobDuration')} ${duration ?? 0}s`),
        errMsg !== undefined && errMsg !== null ? h('span', { className: 'dsc-job-error', title: errMsg }, errMsg) : null,
      ),
    ),
  )
}
