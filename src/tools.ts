/**
 * Model-facing tools for dsh-comfyui, registered into the host `tools`
 * registry. The main entry is `comfyui_workflow`: list and run saved
 * workflows from the panel-managed library (synchronously or as a background
 * job); `comfyui_skill` maintains their skill packs. Secondary, for
 * hand-written workflows only (temporary tests, building a workflow for this
 * environment): `comfyui_object_info` exposes the server's node definitions
 * and `comfyui_run` submits a hand-written API workflow.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import { ComfyUIClient, collectMedia } from './comfyui.js'
import type { AssetRecord, LoadSlot, StoredWorkflow } from './store.js'
import type { GraphAnalysis } from './analyze.js'
import type { RunProgress } from './progress.js'
import type { QueuedRun } from './queue.js'
import { refreshParameterMetadata, type Workflow, type WorkflowParameter } from './params.js'
import type { HostHint } from './host-hint.js'
import { SKILL_MAIN, joinFrontmatter, type WorkflowSkillPacks } from './skillpack.js'

/** A workflow saved on the ComfyUI server (userdata/workflows), with extract status. */
export interface ComfyUIComfyWorkflow {
  name: string
  size?: number
  modified?: number
  /** Whether at least one runnable API workflow was extracted from this graph. */
  extracted: boolean
  /** Runnable API workflows extracted from this graph (运行主题). */
  derived: Array<{ libraryId: string; name: string }>
}

/** Live runtime the tools, routes, and proxy share. */
export interface ComfyUIRuntime {
  getConfig(): Config
  /** Resolve the API key per request (credentials store, then environment). */
  getApiKey(): Promise<string | undefined>
  createClient(apiKey: string | undefined): ComfyUIClient
  /** Absolute media proxy URL base: explicit config > detected request host > loopback. */
  proxyBase(): string | undefined
  /** Remembers the origin browsers use to reach this server (Host header). */
  hostHint: HostHint
  /** Whether the settings service can persist config writes. */
  settingsWritable(): boolean
  updateConfig(patch: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }>
  /** Queue a workflow and track it in the queue tracker. `meta.parameters`
   * applies adjustable parameters (values/random seeds) before submitting. */
  queue(workflow: unknown, meta: {
    workflowName: string | null
    workflowId?: string | null
    source: string
    parameters?: WorkflowParameter[]
    values?: Record<string, unknown>
  }): Promise<string>
  /** Stop tracking a prompt (used when a tool call fails before completion). */
  untrack(promptId: string): void
  /** Every prompt this plugin queued and is still waiting on. */
  trackedRuns(): QueuedRun[]
  /** Live generation progress for one prompt (from the ComfyUI WebSocket). */
  queueProgress(promptId: string): RunProgress | undefined
  /** Saved workflows from the library. */
  listWorkflows(): Promise<StoredWorkflow[]>
  getWorkflow(id: string): Promise<StoredWorkflow | undefined>
  /** Create or update a workflow in the library. */
  saveWorkflow(input: {
    id?: string
    name: string
    description: string
    workflow: unknown
    parameters?: WorkflowParameter[]
    tags?: string[]
    source?: 'user' | 'comfyui'
    comfyuiFile?: string
  }): Promise<{ ok: true; workflow: StoredWorkflow } | { ok: false; error: string }>
  /** Delete a workflow from the library; false when it did not exist. */
  deleteWorkflow(id: string): Promise<boolean>
  /** Per-workflow skill packs (SKILL.md bundles under `<dataDir>/skills/`). */
  skillPacks: WorkflowSkillPacks
  /** Force TTS-Audio-Suite to rescan its voice library (best-effort; false
   * when the server has no such endpoint). Call before re-deriving parameter
   * snapshots so object_info reports newly added voices. */
  refreshVoiceLibrary(): Promise<boolean>
  /** Pixel sizes of panel-uploaded files, keyed by file name. */
  listMediaSizes(): Promise<Record<string, { width: number; height: number }>>
  /** Record the pixel size of one uploaded file. */
  saveMediaSize(name: string, size: { width: number; height: number }): Promise<void>
  /** File name recorded for a content hash (dedup index), if any. */
  lookupMediaHash(hash: string): Promise<string | undefined>
  /** Record a content hash → file name pair for dedup. */
  saveMediaHash(hash: string, name: string): Promise<void>
  /** The load-area slots, in order; `null` is an empty slot the user added.
   * Filled slots are the default source media for loader parameters. */
  loadSlots(): Promise<Array<LoadSlot>>
  /** Persist the load-area slots. */
  saveSlots(slots: Array<LoadSlot>): Promise<void>
  /** The asset index (newest first). */
  listAssets(): Promise<AssetRecord[]>
  /** Remove one asset record from the index, returning what was removed. */
  deleteAsset(promptId: string): Promise<AssetRecord | undefined>
  /** Move completed tracked runs into the asset index. */
  sweep(): Promise<AssetRecord[]>
  /** Workflows the user saved on the ComfyUI server, with extract status. */
  listComfyWorkflows(): Promise<ComfyUIComfyWorkflow[]>
  /** Read one ComfyUI-side saved workflow graph (UI format, not runnable as-is). */
  getComfyWorkflow(file: string): Promise<unknown>
  /** Analyze one ComfyUI-side graph: connected components, groups, dangling nodes. */
  analyzeComfyWorkflow(file: string): Promise<GraphAnalysis | { ok: false; error: string }>
  /** Extract runnable API workflows from a ComfyUI-side graph (整体/按分量/主流程). */
  extractComfyWorkflow(input: {
    file: string
    mode: 'all' | 'split' | 'main'
  }): Promise<{ ok: true; saved: StoredWorkflow[]; analysis: GraphAnalysis; warnings: string[] } | { ok: false; error: string }>
}

/** Execution identity handed to tool execute. */
interface ToolRunContext {
  agent?: unknown
  signal: AbortSignal
  callId?: string
  rootCallId?: string
  /** Set when another tool (run_code / programmatic tool calling) dispatched this call. */
  parent?: unknown
}

/**
 * Which skill packs each agent has already read, for the `requireSkill` gate.
 *
 * Keyed by the live `Agent` handle the tools registry passes as `exec.agent`:
 * one per session and stable across turns, so a WeakMap entry lives exactly as
 * long as the session and needs no eviction pass. An execution without an
 * agent (a direct internal call) is never gated.
 */
const skillPackReads = new WeakMap<object, Set<string>>()

/** Upper bound on the text one `comfyui_skill action: read` returns. The pack
 * caps files at 256 KB, which is still far more than a tool result should
 * inject in one go; a longer file comes back truncated with a marker. */
const MAX_TOOL_READ_CHARS = 40_000

function markSkillPackRead(agent: unknown, workflowId: string): void {
  if (typeof agent !== 'object' || agent === null) return
  const seen = skillPackReads.get(agent)
  if (seen === undefined) skillPackReads.set(agent, new Set([workflowId]))
  else seen.add(workflowId)
}

function hasReadSkillPack(agent: unknown, workflowId: string): boolean {
  if (typeof agent !== 'object' || agent === null) return true
  return skillPackReads.get(agent)?.has(workflowId) === true
}

/** One media item returned by comfyui_run (JSON-safe). */
export interface RunMediaItem {
  filename: string
  subfolder: string
  type: string
  node: string
  index: number
  kind: 'image' | 'video' | 'audio' | 'other'
  url: string
}

/** Synchronous completion result. */
export interface RunResult {
  kind: 'sync'
  promptId: string
  status: 'completed' | 'interrupted'
  elapsedMs: number
  media: RunMediaItem[]
  summary: string
  /** Saved-workflow runs: the prompt-type parameters as actually submitted. */
  prompts?: PromptUsed[]
  /** The model-facing text (`runResultText`), carried in the value for code-dispatched calls. */
  report?: string
}

/** One prompt-type parameter of a saved-workflow run, as actually submitted. */
export interface PromptUsed {
  name: string
  text: string
  /** false = the caller did not pass it, so the saved default was used. */
  passed: boolean
}

/** Background mode result: collect later with job_output. */
export interface BackgroundResult {
  kind: 'background'
  jobId: string
  promptId: string
  label: string
  /** The host posts a completion notice (and wakes an idle agent) — dsh 0.1.7+ jobs. */
  notifies: boolean
  /** The model-facing receipt (`backgroundText`), carried in the value for code-dispatched calls. */
  report?: string
}

/** A minimal ToolDefinition for ctx.tools.register. */
interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): unknown[]
    presentationMeta?(args: unknown, value: unknown): unknown
  }
  timeoutMs?: number
  execute(args: Record<string, unknown>, exec: ToolRunContext): Promise<unknown>
}

/**
 * The jobs service spans two contracts, and `engines.dsh` admits both:
 * - dsh 0.1.2–0.1.6: `owner` is the Agent handle; the job_output text is the
 *   outcome's `output`.
 * - dsh 0.1.7+ (0.2.x included): `owner` is the SessionId the registry looks
 *   up (`agents.get(sessionId)` — an Agent object fails every async start with
 *   `session "[object Object]" has no live agent`); the text is `result`.
 * `readAt` arrived with that switch, so it is the feature test (`sessionJobs`).
 */
interface JobsService {
  start(spec: {
    kind: string
    label: string
    owner?: unknown
    /** 0.1.7+ hands the job handle in; older hosts call `run()` bare. */
    run(job?: JobHandle): {
      cancel(reason?: string): void
      done: Promise<JobOutcome>
    }
  }): string
  readAt?: unknown
}

/** The 0.1.7+ job handle — only its status-line progress is used here. */
interface JobHandle {
  updateProgress?(line: string): void
}

type JobOutcome =
  | { status: 'completed' | 'killed' | 'failed'; detail?: string; result?: string }
  | { status: 'completed' | 'killed' | 'failed'; detail?: string; output?: string }

function sessionJobs(jobs: JobsService): boolean {
  return typeof jobs.readAt === 'function'
}

/** The job owner for a tool call, in the shape this host's registry resolves. */
function jobOwner(jobs: JobsService, agent: unknown): { owner?: unknown } {
  if (agent === undefined) return {}
  if (!sessionJobs(jobs)) return { owner: agent }
  const id = typeof agent === 'object' && agent !== null ? (agent as { id?: unknown }).id : undefined
  return typeof id === 'string' && id !== '' ? { owner: id } : {}
}

/** A completed job: `text` is what the model's next job_output receives. */
function jobCompleted(jobs: JobsService, text: string): JobOutcome {
  return sessionJobs(jobs) ? { status: 'completed', result: text } : { status: 'completed', output: text }
}

/**
 * A failed job. 0.1.7+ shows `detail` as the status-line reason, so the
 * message goes there; older hosts hand `output` to job_output instead.
 */
function jobFailed(jobs: JobsService, message: string): JobOutcome {
  return sessionJobs(jobs)
    ? { status: 'failed', detail: `comfyui: ${message}` }
    : { status: 'failed', detail: 'comfyui', output: message }
}

/** The job status line for one prompt: sampler progress once the WebSocket reports any. */
function progressLine(progress: RunProgress | undefined): string {
  if (progress === undefined || progress.max <= 0) return 'waiting for ComfyUI'
  const node = progress.node !== null ? ` (node ${progress.node})` : ''
  return `step ${progress.value}/${progress.max}${node}`
}

/**
 * Run one queued prompt as a background job — the shared async path of
 * `comfyui_run` and `comfyui_workflow run`.
 * - Cancel (job_kill) aborts the wait, which cancels THIS prompt only
 *   (`cancelPrompt`: dequeue while pending, interrupt while running) and
 *   settles the job as killed. A bare `interrupt()` here used to stop
 *   whatever ComfyUI was running, i.e. someone else's job when this one was
 *   still queued.
 * - On 0.1.7+ hosts the status line carries live sampler progress (from the
 *   ProgressTracker, pulled once per history poll — no extra timer), so
 *   job_list shows the job moving instead of inviting a status poll.
 */
function startPromptJob(
  jobs: JobsService,
  runtime: ComfyUIRuntime,
  client: ComfyUIClient,
  opts: { promptId: string; label: string; subject: string; waitMs: number; agent: unknown; prompts?: PromptUsed[] },
): string {
  const { promptId, label, subject, waitMs } = opts
  const config = runtime.getConfig()
  return jobs.start({
    kind: 'comfyui',
    label,
    ...jobOwner(jobs, opts.agent),
    run: (job) => {
      const startedAt = Date.now()
      const controller = new AbortController()
      let lastLine: string | undefined
      const publishProgress = (): void => {
        if (job?.updateProgress === undefined) return
        const line = progressLine(runtime.queueProgress(promptId))
        if (line === lastLine) return
        lastLine = line
        job.updateProgress(line)
      }
      const done = (async (): Promise<JobOutcome> => {
        try {
          const entry = await client.waitForCompletion({
            promptId,
            timeoutMs: waitMs,
            pollIntervalMs: config.pollIntervalMs,
            signal: controller.signal,
            onPoll: publishProgress,
          })
          const items = collectMedia({ promptId, entry, maxItems: config.maxMediaItems, proxyBase: runtime.proxyBase() })
          const result: RunResult = {
            kind: 'sync',
            promptId,
            status: 'completed',
            elapsedMs: Date.now() - startedAt,
            media: items,
            summary: summarizeMedia(items),
            ...(opts.prompts !== undefined && opts.prompts.length > 0 ? { prompts: opts.prompts } : {}),
          }
          return jobCompleted(jobs, runResultText(subject, result))
        } catch (error) {
          runtime.untrack(promptId)
          if (controller.signal.aborted) return { status: 'killed', detail: 'comfyui: cancelled' }
          const message = error instanceof Error ? error.message : String(error)
          return jobFailed(jobs, message)
        }
      })()
      return {
        cancel: () => controller.abort(),
        done,
      }
    },
  })
}

const TOOL_TIMEOUT_MS = 3_600_000

/**
 * The hand-written API workflow `comfyui_run` submits, with optional per-node
 * input overrides merged in. The built-in templates are gone: they named
 * stock checkpoints most servers do not have, and "文生图" matched `txt2img`
 * before the agent ever looked at the library (real session, 0.5.5 round) —
 * a leftover `template` argument gets a pointer to the right entry point.
 */
function buildWorkflow(args: Record<string, unknown>): { workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }>; label: string } {
  if (args.template !== undefined) {
    throw new Error('comfyui_run: built-in templates were removed — to generate, use comfyui_workflow (action: list, then run); comfyui_run only takes a hand-written `workflow`')
  }
  const workflow = args.workflow
  if (typeof workflow !== 'object' || workflow === null || Array.isArray(workflow)) {
    throw new Error('comfyui_run: `workflow` (a hand-written API-format object: node id → { class_type, inputs }) is required')
  }
  const nodes = workflow as Record<string, { class_type: string; inputs: Record<string, unknown> }>
  const inputs = args.inputs
  if (inputs !== undefined) {
    if (typeof inputs !== 'object' || inputs === null) {
      throw new Error('comfyui_run: inputs must be an object keyed by node id')
    }
    for (const [nodeId, partial] of Object.entries(inputs as Record<string, unknown>)) {
      const node = nodes[nodeId]
      if (node === undefined || typeof partial !== 'object' || partial === null) continue
      node.inputs = { ...node.inputs, ...(partial as Record<string, unknown>) }
    }
  }
  return { workflow: nodes, label: 'comfyui custom workflow' }
}

function summarizeMedia(media: RunMediaItem[]): string {
  if (media.length === 0) return 'no media outputs'
  const images = media.filter((item) => item.kind === 'image').length
  const videos = media.filter((item) => item.kind === 'video').length
  const audio = media.filter((item) => item.kind === 'audio').length
  const others = media.length - images - videos - audio
  const parts: string[] = []
  if (images > 0) parts.push(`${images} image(s)`)
  if (videos > 0) parts.push(`${videos} video(s)`)
  if (audio > 0) parts.push(`${audio} audio file(s)`)
  if (others > 0) parts.push(`${others} other file(s)`)
  return parts.join(', ')
}

/** One ready-to-paste Markdown reference: images embed, other media link. */
function mediaMarkdown(item: RunMediaItem, n: number): string {
  return item.kind === 'image' ? `![image ${n}](${item.url})` : `[${item.kind} ${n}: ${item.filename}](${item.url})`
}

/**
 * The prompt-type parameters of a saved-workflow run as they will be
 * submitted: auto-detected prompts (`prompt`, `prompt_2`, …, label 提示词)
 * and any string parameter whose name or label says prompt. `passed: false`
 * marks a value the caller left to the saved default.
 */
/**
 * A parameter's prompt role: 'write' = the positive prompt the model must
 * compose from the user's request every run; 'negative' = a negative prompt
 * (its default is normally fine); undefined = not a prompt. Prompts are the
 * auto-detected `prompt`, `prompt_2`, … (label 提示词) or any string parameter
 * whose name or label says prompt.
 */
function promptRole(param: { name: string; label?: string; type?: string; upload?: string }): 'write' | 'negative' | undefined {
  if (param.type !== 'string' || param.upload !== undefined) return undefined
  const label = param.label ?? ''
  if (!/prompt/i.test(param.name) && !/提示/.test(label)) return undefined
  return /negative|neg_|负面|反向/i.test(`${param.name} ${label}`) ? 'negative' : 'write'
}

function promptsUsed(parameters: WorkflowParameter[], values: Record<string, unknown>): PromptUsed[] {
  const used: PromptUsed[] = []
  for (const param of parameters) {
    if (promptRole(param) === undefined) continue
    const passed = Object.prototype.hasOwnProperty.call(values, param.name)
    const value = passed ? values[param.name] : param.default
    if (typeof value !== 'string' || value === '') continue
    used.push({ name: param.name, text: value, passed })
  }
  return used
}

/**
 * The model-facing account of a finished run — the sync result, the async
 * job_output text and the `report` a run_code caller reads alike. It says the
 * result is final (models re-check status and re-query assets for URLs they
 * already hold), names the prompt actually submitted, and hands over the media
 * as Markdown lines to paste: the model's reply is the one place every host
 * mode shows (dsh 0.2 collapses finished tool rows, and run_code / PTC mode
 * renders no tool card at all), so it is the display path, always. Headless
 * hosts (no web server) only have bare filenames, which stay a plain list.
 */
function runResultText(subject: string, result: RunResult): string {
  const final = result.status === 'completed' ? ' This is the final result — there is no status to check and no address to look up.' : ''
  const lines = [`${subject} ${result.status} (prompt ${result.promptId}) in ${result.elapsedMs} ms — ${summarizeMedia(result.media)}.${final}`]
  // The prompt as submitted — so the report names the real subject, and a run
  // that silently used the saved default (no parameter passed) is visible.
  for (const used of result.prompts ?? []) {
    const text = used.text.length > 300 ? `${used.text.slice(0, 300)}…` : used.text
    lines.push(used.passed
      ? `Prompt used (${used.name}): "${text}"`
      : `Prompt used (${used.name}, default — not passed): "${text}"`)
  }
  const linkable = result.media.filter((item) => item.url !== item.filename)
  const theme = 'In your reply, state in one sentence what was generated (its subject, per the prompt used).'
  if (linkable.length > 0) {
    lines.push(`${theme} Show the results by pasting these Markdown lines into your reply as-is. The URLs are final — do not look them up again:`)
    linkable.forEach((item, i) => lines.push(mediaMarkdown(item, i + 1)))
  } else if (result.status === 'completed') {
    lines.push(theme)
  }
  for (const item of result.media) {
    if (item.url === item.filename) lines.push(`  ${item.kind}: ${item.filename}`)
  }
  return lines.join('\n')
}

/**
 * The model-facing receipt for a started background job. Models tend to block
 * on it (job_output wait, sleeps) or poll; where the host posts a completion
 * notice, the right move is to end the turn — the notice wakes the agent.
 */
function backgroundText(subject: string, result: BackgroundResult): string {
  const head = `${subject} started in the background (job ${result.jobId}, prompt ${result.promptId}).`
  const collect = 'call job_output once (no wait) — its result already contains ready-to-paste Markdown for the media.'
  return result.notifies
    ? `${head} Do not wait, poll or call job_output now: tell the user it is generating and end your turn. You will get a completion notice in this session when it finishes; then ${collect}`
    : `${head} Do not block on it: continue with other work or end your turn. To collect it later, ${collect}`
}

function renderRunResult(_args: unknown, value: unknown): unknown[] {
  const result = value as RunResult | BackgroundResult
  if (result.kind === 'background') return [{ type: 'text', text: backgroundText('ComfyUI generation', result) }]
  return [{ type: 'text', text: runResultText('ComfyUI', result) }]
}

/**
 * Wait for a queued prompt and collect its media. Untracks the prompt when
 * the wait fails; an interrupted wait reports an interrupted result instead
 * of throwing.
 */
async function waitSync(
  runtime: ComfyUIRuntime,
  client: ComfyUIClient,
  promptId: string,
  config: Config,
  signal: AbortSignal,
  timeoutMs: number | undefined,
  context: { prompts?: PromptUsed[] },
): Promise<RunResult> {
  const startedAt = Date.now()
  const prompts = context.prompts !== undefined && context.prompts.length > 0 ? { prompts: context.prompts } : {}
  try {
    const entry = await client.waitForCompletion({
      promptId,
      timeoutMs: timeoutMs ?? config.timeoutMs,
      pollIntervalMs: config.pollIntervalMs,
      signal,
    })
    const items = collectMedia({ promptId, entry, maxItems: config.maxMediaItems, proxyBase: runtime.proxyBase() })
    const elapsedMs = Date.now() - startedAt
    return {
      kind: 'sync',
      promptId,
      status: 'completed',
      elapsedMs,
      media: items,
      summary: summarizeMedia(items),
      ...prompts,
    }
  } catch (error) {
    runtime.untrack(promptId)
    if (error instanceof Error && error.name === 'ComfyUIError' && error.message.includes('interrupted')) {
      return {
        kind: 'sync',
        promptId,
        status: 'interrupted',
        elapsedMs: Date.now() - startedAt,
        media: [],
        summary: 'interrupted before completion',
      }
    }
    throw error
  }
}

function runDefinition(runtime: ComfyUIRuntime, ctx: Context): ToolDefinition {
  return {
    name: 'comfyui_run',
    description: [
      'SECONDARY tool — not the way to generate. To generate, use comfyui_workflow (action: list, then run a saved workflow).',
      'comfyui_run only submits a HAND-WRITTEN ComfyUI API workflow (node id → { class_type, inputs }), for a temporary test or for building a new workflow for this environment: first check the server with comfyui_object_info (node classes, inputs, available model names), then write the JSON, then run it here.',
      '`inputs` overrides node inputs by id, e.g. {"3": {"seed": 42}}.',
      '`mode: sync` (default) waits and returns media URLs; `mode: async` starts a background job and returns a job id at once — then end your turn instead of waiting; a completion notice brings you back, and job_output returns the media as ready-to-paste Markdown. Results are final and carry the media URLs — never re-check status or look addresses up; paste the Markdown lines the result gives into your reply to show the media.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        workflow: { type: 'object', description: 'Hand-written ComfyUI API-format workflow: node id → { class_type, inputs }; node references are ["<node id string>", <output slot>].' },
        inputs: { type: 'object', description: 'Optional per-node input overrides keyed by node id, e.g. {"3": {"seed": 42, "steps": 30}}.' },
        mode: { type: 'string', enum: ['sync', 'async'], default: 'sync', description: 'sync waits and returns media; async returns a background job id immediately (end your turn after it).' },
        timeout_ms: { type: 'number', minimum: 5_000, maximum: 3_600_000, description: 'Generation wait budget in ms (default 180000). Video needs minutes.' },
      },
      required: ['workflow'],
    },
    output: {
      schema: { type: 'object' },
      render: renderRunResult,
      presentationMeta(_args, value) {
        const result = value as RunResult | BackgroundResult
        if (result.kind === 'background') {
          return { kind: 'background', jobId: result.jobId, promptId: result.promptId, label: result.label }
        }
        return {
          kind: 'sync',
          promptId: result.promptId,
          status: result.status,
          elapsedMs: result.elapsedMs,
          media: result.media,
          summary: result.summary,
        }
      },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const mode = args.mode === undefined ? 'sync' : args.mode
      if (mode !== 'sync' && mode !== 'async') throw new Error(`comfyui_run: mode must be sync or async, got ${String(mode)}`)
      const config = runtime.getConfig()
      const apiKey = await runtime.getApiKey()
      const client = runtime.createClient(apiKey)
      const { workflow, label } = buildWorkflow(args)
      const promptId = await runtime.queue(workflow, { workflowName: label, source: 'tool' })
      const waitMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : config.timeoutMs

      if (mode === 'async') {
        const jobs = ctx.get('jobs') as JobsService | undefined
        if (jobs === undefined) {
          throw new Error('comfyui_run: background jobs unavailable — load @deepseek-ai/dsh-jobs-local and @deepseek-ai/dsh-tool-jobs')
        }
        const jobId = startPromptJob(jobs, runtime, client, { promptId, label, subject: 'ComfyUI', waitMs, agent: exec.agent })
        const result: BackgroundResult = { kind: 'background', jobId, promptId, label, notifies: sessionJobs(jobs) }
        return { ...result, report: backgroundText('ComfyUI generation', result) }
      }

      const result = await waitSync(runtime, client, promptId, config, exec.signal, waitMs, {})
      return { ...result, report: runResultText('ComfyUI', result) }
    },
  }
}

interface FieldSummary {
  name: string
  type: string
  required: boolean
  default?: unknown
  options?: string[]
}

function summarizeFields(fields: Record<string, unknown> | undefined, required: boolean): FieldSummary[] {
  const out: FieldSummary[] = []
  for (const [name, spec] of Object.entries(fields ?? {})) {
    if (!Array.isArray(spec)) continue
    const [typeOrList, options] = spec as [unknown, unknown?]
    const optionsRecord = typeof options === 'object' && options !== null ? options as Record<string, unknown> : undefined
    const entry: FieldSummary = { name, type: 'unknown', required }
    if (Array.isArray(typeOrList)) {
      entry.type = 'enum'
      entry.options = (typeOrList as unknown[]).slice(0, 6).map(String)
    } else if (typeof typeOrList === 'string') {
      entry.type = typeOrList
    }
    if (optionsRecord !== undefined && optionsRecord.default !== undefined) {
      entry.default = optionsRecord.default
    }
    out.push(entry)
    if (out.length >= 14) break
  }
  return out
}

function objectInfoDefinition(runtime: ComfyUIRuntime): ToolDefinition {
  return {
    name: 'comfyui_object_info',
    description: 'SECONDARY tool, for hand-writing workflows only (with comfyui_run): lists the node definitions this ComfyUI server supports — class types, required/optional inputs, and the model files each loader offers — so a temporary test or a new workflow for this environment uses real names. Not needed to generate with saved workflows (comfyui_workflow). Optional `filter` narrows by class-name substring, e.g. "KSampler", "Loader".',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Optional substring filter on node class names.' },
      },
      required: [],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        const data = value as { total: number; shown: number; nodes: Array<{ class_type: string; display_name?: string; description?: string }>; hint?: string }
        const lines = [`ComfyUI nodes: ${data.total} total, showing ${data.shown}`]
        for (const node of data.nodes) {
          lines.push(`- ${node.class_type}${node.display_name !== undefined ? ` (${node.display_name})` : ''}${node.description !== undefined && node.description !== '' ? `: ${node.description}` : ''}`)
        }
        if (data.hint !== undefined) lines.push(data.hint)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 60_000,
    async execute(args) {
      const client = runtime.createClient(await runtime.getApiKey())
      const raw = await client.objectInfo()
      const entries = Object.entries(raw as Record<string, {
        display_name?: string
        description?: string
        input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> }
      }>)
      const filter = typeof args.filter === 'string' ? args.filter.trim().toLowerCase() : undefined
      const filtered = filter === undefined || filter === ''
        ? entries
        : entries.filter(([name]) => name.toLowerCase().includes(filter))
      const nodes = filtered.slice(0, 60).map(([classType, def]) => ({
        class_type: classType,
        // Omitted rather than assigned undefined: a key holding undefined makes the
        // whole result fail DSH's lossless-JSON validation. The render type already
        // declares display_name optional.
        ...(def.display_name !== undefined ? { display_name: def.display_name } : {}),
        description: (def.description ?? '').slice(0, 200),
        required: summarizeFields(def.input?.required, true),
        optional: summarizeFields(def.input?.optional, false),
      }))
      const hint = filtered.length > nodes.length
        ? `filter matched ${filtered.length} nodes, showing first ${nodes.length} — narrow the filter for more`
        : undefined
      return {
        total: entries.length,
        shown: nodes.length,
        filter: filter ?? null,
        // Omitted rather than assigned undefined, same reason as display_name.
        ...(hint !== undefined ? { hint } : {}),
        nodes,
      }
    },
  }
}

/** List and run saved workflows from the panel-managed library. */
function workflowDefinition(runtime: ComfyUIRuntime, ctx: Context): ToolDefinition {
  return {
    name: 'comfyui_workflow',
    description: [
      'The way to generate images, video or audio with ComfyUI: list the saved workflows (set up for this server), pick the one that fits, run it. Lists and runs workflows from the plugin workflow library (运行主题: API-format workflows extracted from a graph or pasted directly).',
      '`action: list` returns every runnable workflow with its id, name, description (what the workflow does), and input notes.',
      'It also lists workflows the user saved on the ComfyUI server (衍生主题: UI graph format canvases). A graph may hold SEVERAL independent flows; each is extracted into its own runnable workflow in the panel (整体/按分量/主流程). A graph with no extracted workflow yet cannot run — tell the user to open the ComfyUI panel and 提取 it first.',
      '`action: run` runs one saved workflow by id — pass only the id plus parameter overrides keyed by the exact names from list (unknown names are rejected; parameters not passed use their defaults). Fill prompt parameters from what the user asked for, improvising from the request when unspecified. Call it directly, not from run_code, so the user sees the result card. The plugin submits the saved workflow JSON itself (never copy the JSON into your reply). It waits for media by default; add `mode: "async"` to run in the background — then end your turn instead of waiting; a completion notice brings you back, and job_output returns the media as ready-to-paste Markdown. Results are final and carry the media URLs — never re-check status or look addresses up; paste the Markdown lines the result gives into your reply to show the media.',
      '`action: get` returns one saved workflow\'s complete API-format JSON by id for inspection/diagnostics only — it consumes many tokens and is not the run path.',
      '`action: refresh` re-derives one saved workflow\'s parameter snapshot (options / numberKind / min/max/step) from the current node definitions and saves it back. Run it after the TTS-Audio-Suite voice library or node definitions changed: saved workflows snapshot their parameter options at save time, so a freshly added voice is not accepted by `action: run` until the snapshot catches up. It force-rescans the TTS voice library first, then updates only the fields derived from object_info — the parameter set (including user-added advanced parameters) is preserved. Returns `changed` with the parameter names that actually changed.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'run', 'get', 'refresh'], description: 'list returns the workflow library; run executes one workflow by id (direct call to the saved JSON); get returns one workflow\'s full JSON for inspection; refresh re-derives one workflow\'s parameter snapshot from the current node definitions and saves it back.' },
        id: { type: 'string', description: 'Workflow id (required for action: run and get).' },
        mode: { type: 'string', enum: ['sync', 'async'], description: 'run mode (default sync); async starts a background job and returns its id immediately (end your turn after it; collect with job_output once notified). Video/audio workflows should use async — generation takes minutes and sync may time out.' },
        timeout_ms: { type: 'number', minimum: 5_000, maximum: 3_600_000, description: 'Generation wait budget in ms (default 900000 = 15 min). Video needs minutes; raise this for long videos.' },
        parameters: {
          type: 'object',
          description: 'Optional per-run values for the workflow\'s adjustable parameters (see the workflow\'s `inputs` note from action: list — e.g. {"prompt": "a red cat", "seed": 42}). Omitted parameters keep their defaults; seed-type parameters randomize when the workflow marks them 随机.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        const data = value as {
          action: string
          env?: { baseUrl: string; comfyuiDirs: string[] }
          workflows?: Array<{ id: string; name: string; description: string; skill?: { summary: string; files: number; required: boolean }; parameters?: Array<{ name: string; label?: string; type?: string; default?: string | number | boolean; random?: boolean; numberKind?: 'int' | 'float'; options?: Array<string | number>; upload?: 'image' | 'video' | 'audio' | 'media'; subfolder?: string }> }>
          comfyuiWorkflows?: Array<{ name: string; extracted: boolean; derived: Array<{ libraryId: string; name: string }> }>
          loadArea?: { slots: number; loaded: number; items: Array<{ name: string; kind: string; source: string }> }
          result?: RunResult
          id?: string
          name?: string
          workflow?: unknown
          background?: BackgroundResult
          changed?: string[]
          parameterCount?: number
          skill?: { workflowName: string; summary: string; body: string; resourceBase: string; files: string[] }
        }
        if (data.action === 'skill') {
          const pack = data.skill
          if (pack === undefined) return [{ type: 'text', text: `ComfyUI workflow ${data.name ?? data.id} 没有技能包。` }]
          // Same framing the host uses for its own skills: a named block, the
          // resource base, then the body verbatim. The reference files stay on
          // disk until the body sends the model after one of them.
          const others = pack.files.filter((file) => file !== 'SKILL.md')
          return [{
            type: 'text',
            text: [
              `<skill_content name="${pack.workflowName}">`,
              '<skill_resources>',
              `Base directory for this skill: ${pack.resourceBase}`,
              others.length > 0
                ? `Files in this pack: ${others.join(', ')} — resolve them against the base directory and read one only when the instructions below point at it.`
                : 'This pack has no reference files.',
              '</skill_resources>',
              '',
              '<skill_instructions>',
              pack.body,
              '</skill_instructions>',
              '</skill_content>',
            ].join('\n'),
          }]
        }
        if (data.action === 'get') {
          return [{ type: 'text', text: `ComfyUI workflow ${data.name ?? data.id}: ${JSON.stringify(data.workflow)}` }]
        }
        if (data.background !== undefined) {
          return [{ type: 'text', text: backgroundText('ComfyUI workflow', data.background) }]
        }
        if (data.action === 'refresh') {
          const changed = data.changed ?? []
          const changedText = changed.length > 0
            ? `更新了 ${changed.length} 个参数的 options / 数值声明：${changed.join('、')}`
            : 'options 与数值声明与最新节点定义一致，没有变化'
          return [{ type: 'text', text: `ComfyUI workflow ${data.name ?? data.id}：参数快照已刷新（${data.parameterCount ?? 0} 个参数原样保留），${changedText}` }]
        }
        if (data.action === 'list') {
          const lines: string[] = []
          const env = data.env
          if (env !== undefined) {
            // The model's local-env one-liner: the ComfyUI server address and
            // the user's ComfyUI install dirs, so it never has to ask where
            // files live (TTS-Audio-Suite voice library etc.).
            lines.push(`ComfyUI 服务器: ${env.baseUrl}；本机 ComfyUI 目录: ${env.comfyuiDirs.length > 0 ? env.comfyuiDirs.join('；') : '未配置（设置页 comfyuiDirs 可填写）'}`)
          }
          lines.push(`Saved ComfyUI workflows (${data.workflows?.length ?? 0}):`)
          for (const workflow of data.workflows ?? []) {
            lines.push(`- ${workflow.id} — ${workflow.name}${workflow.description !== '' ? `: ${workflow.description}` : ''}`)
            const skill = workflow.skill
            if (skill !== undefined) {
              const extra = skill.files > 1 ? `，另有 ${skill.files - 1} 篇参考文档` : ''
              lines.push(`  技能包${skill.required ? '（运行前必读）' : ''}: ${skill.summary}${extra} — 运行前先 action: skill { id: "${workflow.id}" }`)
            }
            // Prompt parameters carry the user's request, so they are marked to
            // be filled from it and their saved default is not printed (a
            // default shown here gets rerun verbatim); every other parameter
            // is listed with its default.
            const params = workflow.parameters ?? []
            if (params.length > 0) lines.push('  参数（键名用括号前的英文名；未传的参数使用默认值）:')
            for (const param of params) {
              const prompt = promptRole(param) === 'write'
              const label = param.label ?? param.name
              const def = prompt || param.default === undefined ? '' : `，默认 ${typeof param.default === 'string' ? `"${param.default}"` : String(param.default)}`
              const options = Array.isArray(param.options) && param.options.length > 0 ? `，可选: ${param.options.join(' / ')}` : ''
              const upload = param.upload !== undefined
                ? `，上传类型: ${param.upload}${param.upload === 'media' ? `（${param.subfolder ?? ''}/，空值=移除该参考位）` : ''}`
                : ''
              const fill = prompt ? ' — 按用户需求填写，未明确时据需求自行发挥' : ''
              lines.push(`  ${param.name}(${label}${param.random === true ? '，随机' : ''}${def}${options}${upload})${fill}`)
            }
          }
          const loadArea = data.loadArea
          if (loadArea !== undefined && loadArea.slots > 0) {
            lines.push(`用户加载区（${loadArea.slots} 个加载位，已放入 ${loadArea.loaded} 个素材，未显式传值的加载参数按顺序取用）:`)
            for (const [index, item] of loadArea.items.entries()) {
              lines.push(`  ${index + 1}. ${item.name}（${item.kind}）`)
            }
          }
          const comfyui = data.comfyuiWorkflows ?? []
          if (comfyui.length > 0) {
            lines.push(`ComfyUI 端保存的图工作流（${comfyui.length} 个，UI 图格式，不能直接运行）:`)
            for (const workflow of comfyui) {
              if (workflow.extracted) {
                lines.push(`- ${workflow.name} — 已提取 ${workflow.derived.length} 个运行工作流：${workflow.derived.map((d) => `${d.name}(${d.libraryId})`).join('、')}`)
              } else {
                lines.push(`- ${workflow.name} — 未提取：如需运行，请转告用户先在 ComfyUI 面板里“提取”它（可选择整体/按分量/主流程）`)
              }
            }
          }
          return [{ type: 'text', text: lines.join('\n') }]
        }
        const result = data.result
        if (result === undefined) return [{ type: 'text', text: 'ComfyUI workflow run returned no result.' }]
        return [{ type: 'text', text: runResultText('ComfyUI workflow', result) }]
      },
      presentationMeta(_args, value) {
        return value
      },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const action = args.action
      if (action !== 'list' && action !== 'run' && action !== 'get' && action !== 'refresh' && action !== 'skill') {
        throw new Error(`comfyui_workflow: action must be list, run, skill, get, or refresh, got ${String(action)}`)
      }
      if (action === 'list') {
        const [workflows, comfyui, slots] = await Promise.all([
          runtime.listWorkflows(),
          runtime.listComfyWorkflows().catch(() => []),
          runtime.loadSlots().catch(() => [] as LoadSlot[]),
        ])
        // What the user currently has loaded in the panel's load area. Unset
        // loader parameters take these files in slot order, so the model can
        // see how many references a run will pick up without asking.
        const loaded = slots.filter((slot): slot is NonNullable<LoadSlot> => slot !== null)
        // Rung one of the skill-pack disclosure ladder: a workflow that has a
        // pack contributes ONE summary line here, not its body. The model
        // reaches for `action: skill` only after this listing points it at a
        // specific workflow, so an unused pack costs nothing.
        const packs = new Map<string, { summary: string; files: number; required: boolean }>()
        await Promise.all(workflows
          .filter((workflow) => workflow.skillDir !== undefined && workflow.skillDir !== '')
          .map(async (workflow) => {
            const pack = await runtime.skillPacks.infoFor(workflow).catch(() => undefined)
            if (pack === undefined) return
            packs.set(workflow.id, {
              summary: pack.summary !== '' ? pack.summary : `${workflow.name} 的使用说明`,
              files: pack.files.length,
              required: pack.required,
            })
          }))
        return {
          action: 'list',
          // Local environment the model can rely on: the ComfyUI server
          // address and the user's ComfyUI install dirs (configured in the
          // settings page comfyuiDirs). Fresh on every call, so config
          // changes show up without restarting DSH.
          env: {
            baseUrl: runtime.getConfig().baseUrl,
            comfyuiDirs: runtime.getConfig().comfyuiDirs,
          },
          loadArea: {
            slots: slots.length,
            loaded: loaded.length,
            items: loaded.map(({ name, kind, source }) => ({ name, kind, source })),
          },
          workflows: workflows.map(({ id, name, description, parameters, updatedAt }) => ({
            id,
            name,
            description,
            ...(packs.has(id) ? { skill: packs.get(id)! } : {}),
            parameters: (parameters ?? []).map(({ name: pname, label, type, default: def, random, numberKind, options, upload }) => {
              // DSH validates tool output as lossless JSON: JSON.stringify drops
              // undefined keys, so omit optional fields instead of passing undefined.
              const entry: Record<string, unknown> = { name: pname }
              if (label !== undefined) entry.label = label
              if (type !== undefined) entry.type = type
              if (def !== undefined) entry.default = def
              if (random !== undefined) entry.random = random
              // Tells the model whether decimals are accepted; absent means the
              // node's declared type is unknown and a float is safe.
              if (numberKind !== undefined) entry.numberKind = numberKind
              if (options !== undefined) entry.options = options
              if (upload !== undefined) entry.upload = upload
              return entry
            }),
            updatedAt,
          })),
          comfyuiWorkflows: comfyui.map(({ name, extracted, derived }) => ({ name, extracted, derived })),
        }
      }
      const id = args.id
      if (typeof id !== 'string' || id === '') {
        throw new Error('comfyui_workflow: id is required for action: run, get, refresh and skill')
      }
      const saved = await runtime.getWorkflow(id)
      if (saved === undefined) {
        throw new Error(`comfyui_workflow: workflow "${id}" not found — run action: list first`)
      }
      if (action === 'get') {
        return {
          action: 'get',
          id: saved.id,
          name: saved.name,
          description: saved.description,
          parameters: saved.parameters ?? [],
          workflow: saved.workflow,
        }
      }
      if (action === 'skill') {
        const pack = await runtime.skillPacks.load(saved.id)
        if (!pack.ok) {
          throw new Error(`comfyui_workflow: ${pack.error}`)
        }
        // Reading the pack is what opens the `requireSkill` gate below.
        markSkillPackRead(exec.agent, saved.id)
        return {
          action: 'skill',
          id: saved.id,
          name: saved.name,
          skill: {
            workflowName: pack.value.workflowName,
            summary: pack.value.summary,
            body: pack.value.body,
            resourceBase: pack.value.resourceBase,
            files: pack.value.files,
          },
        }
      }
      if (action === 'refresh') {
        // The library snapshot is captured at save time and never re-reads
        // object_info, so a voice library that grew since then would reject
        // the new voice at run time. Force the TTS rescan first (the object_info
        // COMBO does not self-heal), then re-derive the derived fields only.
        await runtime.refreshVoiceLibrary()
        const client = runtime.createClient(await runtime.getApiKey())
        const objectInfo = await client.objectInfo().catch(() => undefined)
        const { parameters, changed } = refreshParameterMetadata(
          saved.parameters ?? [],
          objectInfo,
          saved.workflow,
        )
        const result = await runtime.saveWorkflow({
          id: saved.id,
          name: saved.name,
          description: saved.description,
          workflow: saved.workflow,
          parameters,
          source: saved.source,
          comfyuiFile: saved.comfyuiFile,
          tags: saved.tags,
        })
        if (!result.ok) {
          throw new Error(`comfyui_workflow: refresh failed: ${result.error}`)
        }
        return {
          action: 'refresh',
          id: saved.id,
          name: saved.name,
          parameterCount: parameters.length,
          changed,
        }
      }
      // The 必读 gate: workflows the user marked `requireSkill` refuse to run
      // until this session has actually loaded their pack. The reminder in the
      // listing is advisory; this is the part that holds.
      if (saved.requireSkill === true && saved.skillDir !== undefined && !hasReadSkillPack(exec.agent, saved.id)) {
        throw new Error(`comfyui_workflow: 工作流 "${saved.name}" 标记了运行前必读技能包 — 先调用 action: skill { id: "${saved.id}" } 读完再运行。`)
      }
      const config = runtime.getConfig()
      const client = runtime.createClient(await runtime.getApiKey())
      const values = typeof args.parameters === 'object' && args.parameters !== null
        ? (args.parameters as Record<string, unknown>)
        : {}
      // Unknown names used to be ignored silently, so a misspelt prompt key
      // ran the saved default and looked like "ComfyUI ignores my prompt".
      // Refuse before anything is queued and name the valid keys instead.
      const known = new Set((saved.parameters ?? []).map((param) => param.name))
      const unknown = Object.keys(values).filter((name) => !known.has(name))
      if (unknown.length > 0) {
        throw new Error(`comfyui_workflow: "${saved.name}" has no parameter ${unknown.map((name) => `"${name}"`).join(', ')} — nothing was submitted. Valid parameter names: ${[...known].join(', ') || '(none)'}`)
      }
      const prompts = promptsUsed(saved.parameters ?? [], values)
      const promptId = await runtime.queue(saved.workflow, {
        workflowName: saved.name,
        workflowId: saved.id,
        source: 'workflow-tool',
        parameters: saved.parameters,
        values,
      })
      const mode = args.mode === undefined ? 'sync' : args.mode
      if (mode !== 'sync' && mode !== 'async') {
        throw new Error(`comfyui_workflow: mode must be sync or async, got ${String(mode)}`)
      }
      const waitMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : config.timeoutMs
      if (mode === 'async') {
        const jobs = ctx.get('jobs') as JobsService | undefined
        if (jobs === undefined) {
          throw new Error('comfyui_workflow: background jobs unavailable — load @deepseek-ai/dsh-jobs-local and @deepseek-ai/dsh-tool-jobs')
        }
        const jobId = startPromptJob(jobs, runtime, client, { promptId, label: saved.name, subject: 'ComfyUI workflow', waitMs, agent: exec.agent, prompts })
        const background: BackgroundResult = { kind: 'background', jobId, promptId, label: saved.name, notifies: sessionJobs(jobs) }
        return { action: 'run', id, workflowName: saved.name, background, report: backgroundText('ComfyUI workflow', background) }
      }
      const result = await waitSync(runtime, client, promptId, config, exec.signal, waitMs, { prompts })
      return { action: 'run', id, workflowName: saved.name, result, report: runResultText('ComfyUI workflow', result) }
    },
  }
}

/**
 * `comfyui_skill`: read and write one workflow's skill pack.
 *
 * The pack is documentation the agent is expected to consult before running a
 * workflow (`comfyui_workflow action: skill`), and this tool is the other half:
 * the agent can also author it — record a pitfall it just hit, add a style
 * reference, lay out its own folders — with the same validation, size caps, and
 * path containment the panel goes through.
 *
 * Destroying a pack is deliberately absent. The files are hand-written by the
 * user and have no other copy, so removing the whole thing stays a panel
 * gesture behind an explicit confirmation; the agent can delete a file it owns
 * but cannot wipe the directory.
 */
function skillDefinition(runtime: ComfyUIRuntime): ToolDefinition {
  return {
    name: 'comfyui_skill',
    description: [
      "Read and write one workflow's skill pack: the SKILL.md the agent reads before running that workflow, plus its reference files, scripts, templates and assets.",
      '`action: list` returns the pack listing (files, sub-directories, byte sizes) and its absolute directory.',
      '`action: read` returns one file (path relative to the pack, e.g. `references/styles.md`); reading `SKILL.md` also satisfies the 必读 gate that blocks `comfyui_workflow action: run` for workflows marked required.',
      '`action: write` creates or overwrites one file (`content`); pass `summary` alongside when writing SKILL.md to set the one-line summary the workflow listing shows. `action: append` adds to the end of an existing file instead — the right choice for recording a newly discovered pitfall without rewriting the document.',
      '`action: mkdir` creates a sub-directory, `action: rename` moves a file within the pack, `action: delete` removes one file (SKILL.md cannot be renamed or deleted).',
      '`action: enable` attaches a pack to a workflow that has none (seeding SKILL.md), and `action: require` toggles whether running that workflow demands the pack be read first.',
      'Write documentation the next agent run will need: when to use the workflow, which parameter values matter, what fails. Keep SKILL.md short and put bulk material in separate files — SKILL.md is loaded whole, the other files only when it points at them.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'read', 'write', 'append', 'mkdir', 'rename', 'delete', 'enable', 'require'],
          description: 'list the pack; read/write/append/rename/delete one file; mkdir a sub-directory; enable a pack on a workflow; require toggles the read-before-run gate.',
        },
        workflow_id: { type: 'string', description: 'Workflow id from comfyui_workflow action: list.' },
        path: { type: 'string', description: 'Pack-relative file path for read/write/append/rename/delete, e.g. "SKILL.md" or "references/styles.md". One level of sub-directory only.' },
        content: { type: 'string', description: 'File text for write and append.' },
        summary: { type: 'string', description: 'One-line summary stored in SKILL.md frontmatter; this is the line the workflow listing shows, so make it say when to use the workflow.' },
        to: { type: 'string', description: 'New path for rename (a bare name keeps the current directory).' },
        name: { type: 'string', description: 'Sub-directory name for mkdir (letters, digits, CJK, underscore, dash).' },
        required: { type: 'boolean', description: 'For action: require — true refuses to run the workflow until the pack has been read in this session.' },
      },
      required: ['action', 'workflow_id'],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        const data = value as {
          action: string
          workflowName?: string
          path?: string
          content?: string
          truncated?: boolean
          dir?: string
          summary?: string
          files?: Array<{ path: string; size: number }>
          dirs?: string[]
          required?: boolean
        }
        if (data.action === 'read') {
          return [{ type: 'text', text: `${data.path} (${data.workflowName}):\n${data.content ?? ''}${data.truncated === true ? '\n…（文件过大，已截断）' : ''}` }]
        }
        const lines: string[] = []
        if (data.action === 'list') {
          lines.push(`技能包 ${data.workflowName}（${data.dir}）${data.required === true ? ' — 运行前必读' : ''}`)
          if (data.summary !== undefined && data.summary !== '') lines.push(`摘要: ${data.summary}`)
          for (const file of data.files ?? []) lines.push(`  ${file.path} (${file.size} B)`)
          const empty = (data.dirs ?? []).filter((dir) => !(data.files ?? []).some((file) => file.path.startsWith(`${dir}/`)))
          if (empty.length > 0) lines.push(`  空目录: ${empty.map((dir) => `${dir}/`).join('、')}`)
          return [{ type: 'text', text: lines.join('\n') }]
        }
        lines.push(`技能包 ${data.workflowName} 已更新（${data.action}${data.path !== undefined ? ` ${data.path}` : ''}）`)
        for (const file of data.files ?? []) lines.push(`  ${file.path} (${file.size} B)`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
      presentationMeta(_args, value) {
        return value
      },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const action = args.action
      const id = args.workflow_id
      if (typeof id !== 'string' || id === '') {
        throw new Error('comfyui_skill: workflow_id is required')
      }
      const saved = await runtime.getWorkflow(id)
      if (saved === undefined) {
        throw new Error(`comfyui_skill: workflow "${id}" not found — run comfyui_workflow action: list first`)
      }
      const path = typeof args.path === 'string' ? args.path : ''
      const content = typeof args.content === 'string' ? args.content : ''

      const listing = async (label: string, extra?: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const pack = await runtime.skillPacks.info(id)
        if (pack === undefined) throw new Error(`comfyui_skill: 工作流 "${saved.name}" 没有技能包 — 先用 action: enable 挂一个`)
        return {
          action: label,
          workflowId: id,
          workflowName: saved.name,
          dir: pack.dir,
          summary: pack.summary,
          required: pack.required,
          files: pack.files.map(({ path: file, size }) => ({ path: file, size })),
          dirs: pack.dirs,
          ...extra,
        }
      }

      if (action === 'enable') {
        const result = await runtime.skillPacks.enable(id)
        if (!result.ok) throw new Error(`comfyui_skill: ${result.error}`)
        return listing('enable')
      }
      if (action === 'list') return listing('list')
      if (action === 'require') {
        const result = await runtime.skillPacks.setRequired(id, args.required === true)
        if (!result.ok) throw new Error(`comfyui_skill: ${result.error}`)
        return listing('require')
      }
      if (action === 'read') {
        if (path === '') throw new Error('comfyui_skill: path is required for action: read')
        const file = await runtime.skillPacks.readFile(id, path)
        if (!file.ok) throw new Error(`comfyui_skill: ${file.error}`)
        // Reading the main document is the same gesture `comfyui_workflow
        // action: skill` performs, so it opens the run gate too.
        if (path === SKILL_MAIN) markSkillPackRead(exec.agent, id)
        const truncated = file.value.length > MAX_TOOL_READ_CHARS
        return {
          action: 'read',
          workflowId: id,
          workflowName: saved.name,
          path,
          content: truncated ? file.value.slice(0, MAX_TOOL_READ_CHARS) : file.value,
          truncated,
        }
      }
      if (action === 'write' || action === 'append') {
        if (path === '') throw new Error(`comfyui_skill: path is required for action: ${action}`)
        let text = content
        if (action === 'append') {
          const existing = await runtime.skillPacks.readFile(id, path)
          const before = existing.ok ? existing.value : ''
          text = before === '' ? content : `${before.replace(/\s*$/, '')}\n\n${content}`
        }
        const summary = typeof args.summary === 'string' ? args.summary : undefined
        const result = path === SKILL_MAIN && summary !== undefined
          ? await runtime.skillPacks.writeFile(id, path, joinFrontmatter(summary, text))
          : await runtime.skillPacks.writeFile(id, path, text)
        if (!result.ok) throw new Error(`comfyui_skill: ${result.error}`)
        return listing(action, { path })
      }
      if (action === 'mkdir') {
        const name = typeof args.name === 'string' ? args.name : ''
        const result = await runtime.skillPacks.makeDir(id, name)
        if (!result.ok) throw new Error(`comfyui_skill: ${result.error}`)
        return listing('mkdir', { path: `${name}/` })
      }
      if (action === 'rename') {
        const to = typeof args.to === 'string' ? args.to : ''
        if (path === '' || to === '') throw new Error('comfyui_skill: path and to are required for action: rename')
        const bucket = path.includes('/') ? `${path.split('/')[0] ?? ''}/` : ''
        const target = to.includes('/') ? to : `${bucket}${to}`
        const result = await runtime.skillPacks.renameFile(id, path, target)
        if (!result.ok) throw new Error(`comfyui_skill: ${result.error}`)
        return listing('rename', { path: target })
      }
      if (action === 'delete') {
        if (path === '') throw new Error('comfyui_skill: path is required for action: delete')
        const result = await runtime.skillPacks.deleteFile(id, path)
        if (!result.ok) throw new Error(`comfyui_skill: ${result.error}`)
        return listing('delete', { path })
      }
      throw new Error(`comfyui_skill: unknown action ${String(action)}`)
    },
  }
}

/** Register the plugin tools; returns disposers. */
export function registerComfyUITools(ctx: Context, runtime: ComfyUIRuntime): Array<() => void> {
  const tools = (ctx as unknown as { tools: { register(definition: ToolDefinition): () => void } }).tools
  const disposers: Array<() => void> = []
  // Main entry first: generating = comfyui_workflow list → run. The
  // hand-written-workflow pair (object_info → run) is secondary and last.
  disposers.push(tools.register(workflowDefinition(runtime, ctx)))
  disposers.push(tools.register(skillDefinition(runtime)))
  disposers.push(tools.register(objectInfoDefinition(runtime)))
  disposers.push(tools.register(runDefinition(runtime, ctx)))
  return disposers
}
