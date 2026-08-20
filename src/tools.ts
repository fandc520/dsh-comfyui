/**
 * Model-facing tools for dsh-comfyui, registered into the host `tools`
 * registry. `comfyui_run` submits a workflow and returns media results
 * (synchronously or as a background job); `comfyui_object_info` exposes the
 * server's node definitions; `comfyui_workflow` lists and runs saved
 * workflows from the panel-managed workflow library.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import { ComfyUIClient, collectMedia } from './comfyui.js'
import { TEMPLATES, findTemplate, cloneWorkflow, applyTemplateInputs } from './templates.js'
import type { AssetRecord, StoredWorkflow } from './store.js'
import type { GraphAnalysis } from './analyze.js'
import type { RunProgress } from './progress.js'
import type { QueuedRun } from './queue.js'
import type { WorkflowParameter } from './params.js'
import type { HostHint } from './host-hint.js'

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
  /** Pixel sizes of panel-uploaded files, keyed by file name. */
  listMediaSizes(): Promise<Record<string, { width: number; height: number }>>
  /** Record the pixel size of one uploaded file. */
  saveMediaSize(name: string, size: { width: number; height: number }): Promise<void>
  /** File name recorded for a content hash (dedup index), if any. */
  lookupMediaHash(hash: string): Promise<string | undefined>
  /** Record a content hash → file name pair for dedup. */
  saveMediaHash(hash: string, name: string): Promise<void>
  /** The load-area selection (default source image for image-to-image). */
  loadCurrentImage(): Promise<{ name: string; kind: 'image' | 'video' | 'audio'; source: 'imported' | 'generated' } | undefined>
  /** Persist the load-area selection. */
  saveCurrentImage(image: { name: string; kind: 'image' | 'video' | 'audio'; source: 'imported' | 'generated' }): Promise<void>
  /** The asset index (newest first). */
  listAssets(): Promise<AssetRecord[]>
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
}

/** Background mode result: collect later with job_output. */
export interface BackgroundResult {
  kind: 'background'
  jobId: string
  promptId: string
  label: string
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

interface JobsService {
  start(spec: {
    kind: string
    label: string
    owner?: unknown
    run(): {
      cancel(reason?: string): void
      done: Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string; output?: string }>
      readOutput?(): string
    }
  }): string
}

const TOOL_TIMEOUT_MS = 3_600_000

function missing(args: Record<string, unknown>, name: string): boolean {
  return args[name] === undefined || args[name] === null
}

function requireOneOf(args: Record<string, unknown>, names: readonly string[]): string | undefined {
  const present = names.filter((name) => !missing(args, name))
  if (present.length === 0) return `exactly one of ${names.join(', ')} is required`
  if (present.length > 1) return `only one of ${names.join(', ')} may be given`
  return undefined
}

function buildWorkflow(args: Record<string, unknown>): { workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }>; label: string } {
  const template = args.template
  if (typeof template === 'string') {
    const found = findTemplate(template)
    if (found === undefined) {
      throw new Error(`comfyui_run: unknown template "${template}" — use one of ${TEMPLATES.map((t) => t.id).join(', ')}`)
    }
    const workflow = cloneWorkflow(found.workflow)
    const inputs = args.inputs
    if (inputs !== undefined) {
      if (typeof inputs !== 'object' || inputs === null) {
        throw new Error('comfyui_run: inputs must be an object keyed by node id')
      }
      applyTemplateInputs(workflow, inputs as Record<string, Record<string, unknown>>)
    }
    return { workflow, label: `comfyui ${template}` }
  }
  const workflow = args.workflow
  if (typeof workflow !== 'object' || workflow === null) {
    throw new Error('comfyui_run: workflow must be an object')
  }
  const inputs = args.inputs
  if (inputs !== undefined) {
    if (typeof inputs !== 'object' || inputs === null) {
      throw new Error('comfyui_run: inputs must be an object keyed by node id')
    }
    applyTemplateInputs(workflow as Record<string, { class_type: string; inputs: Record<string, unknown> }>, inputs as Record<string, Record<string, unknown>>)
  }
  return { workflow: workflow as Record<string, { class_type: string; inputs: Record<string, unknown> }>, label: 'comfyui custom workflow' }
}

function summarizeMedia(media: RunMediaItem[]): string {
  if (media.length === 0) return 'no media outputs'
  const images = media.filter((item) => item.kind === 'image').length
  const videos = media.filter((item) => item.kind === 'video').length
  const others = media.length - images - videos
  const parts: string[] = []
  if (images > 0) parts.push(`${images} image(s)`)
  if (videos > 0) parts.push(`${videos} video(s)`)
  if (others > 0) parts.push(`${others} other file(s)`)
  return parts.join(', ')
}

function renderRunResult(_args: unknown, value: unknown): unknown[] {
  const result = value as RunResult | BackgroundResult
  if (result.kind === 'background') {
    return [{
      type: 'text',
      text: `ComfyUI generation started in the background (job ${result.jobId}, prompt ${result.promptId}). Collect the result with job_output.`,
    }]
  }
  const lines = [
    `ComfyUI ${result.status} (prompt ${result.promptId}) in ${result.elapsedMs} ms — ${summarizeMedia(result.media)}`,
  ]
  for (const item of result.media) {
    lines.push(`  ${item.kind}: ${item.url}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
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
  timeoutMs?: number,
): Promise<RunResult> {
  const startedAt = Date.now()
  try {
    const entry = await client.waitForCompletion({
      promptId,
      timeoutMs: timeoutMs ?? config.timeoutMs,
      pollIntervalMs: config.pollIntervalMs,
      signal,
    })
    const items = collectMedia({ promptId, entry, maxItems: config.maxMediaItems, proxyBase: runtime.proxyBase() })
    return {
      kind: 'sync',
      promptId,
      status: 'completed',
      elapsedMs: Date.now() - startedAt,
      media: items,
      summary: summarizeMedia(items),
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
      'Submit a workflow to the configured ComfyUI server and return the generated media (images/videos).',
      'Provide exactly one of `workflow` (ComfyUI API-format object: node id → { class_type, inputs }) or `template` (built-in: txt2img | img2img | video).',
      'Use `inputs` to override node inputs by id, e.g. {"6": {"text": "a red cat"}} for the positive prompt in the templates.',
      'Templates: txt2img — 4 checkpoint, 5 EmptyLatentImage (width/height), 6 positive text, 7 negative text, 3 KSampler (seed/steps/cfg/denoise), 9 SaveImage. img2img — 10 LoadImage (image), 11 VAEEncode, 6 text, 3 KSampler (denoise). video — Wan 2.1, needs ComfyUI-WanVideoWrapper custom nodes (10 UNETLoader, 13 WanTextEncode, 14 WanImageToVideo, 15 KSampler, 17 SaveVideo).',
      'Inspect available node types with comfyui_object_info before hand-writing a workflow.',
      '`mode: sync` (default) waits and returns media URLs; `mode: async` starts a background job and returns a job id for job_output.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        workflow: { type: 'object', description: 'ComfyUI API-format workflow: node id → { class_type, inputs }. Alternative to `template`.' },
        template: { type: 'string', enum: ['txt2img', 'img2img', 'video'], description: 'Built-in workflow template id. Alternative to `workflow`.' },
        inputs: { type: 'object', description: 'Per-node input overrides keyed by node id, e.g. {"3": {"seed": 42, "steps": 30}, "6": {"text": "prompt"}}.' },
        mode: { type: 'string', enum: ['sync', 'async'], default: 'sync', description: 'sync waits and returns media; async returns a background job id.' },
        timeout_ms: { type: 'number', minimum: 5_000, maximum: 3_600_000, description: 'Generation wait budget in ms (default 180000). Video needs minutes.' },
      },
      required: [],
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
      const problem = requireOneOf(args, ['workflow', 'template'])
      if (problem !== undefined) throw new Error(`comfyui_run: ${problem}`)
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
        const jobId = jobs.start({
          kind: 'comfyui',
          label,
          ...(exec.agent !== undefined ? { owner: exec.agent } : {}),
          run: () => {
            const startedAt = Date.now()
            const done = (async () => {
              try {
                const entry = await client.waitForCompletion({
                  promptId,
                  timeoutMs: waitMs,
                  pollIntervalMs: config.pollIntervalMs,
                  signal: new AbortController().signal,
                })
                const items = collectMedia({ promptId, entry, maxItems: config.maxMediaItems, proxyBase: runtime.proxyBase() })
                const result: RunResult = {
                  kind: 'sync',
                  promptId,
                  status: 'completed',
                  elapsedMs: Date.now() - startedAt,
                  media: items,
                  summary: summarizeMedia(items),
                }
                return { status: 'completed' as const, output: JSON.stringify(result) }
              } catch (error) {
                runtime.untrack(promptId)
                const message = error instanceof Error ? error.message : String(error)
                return { status: 'failed' as const, detail: 'comfyui', output: message }
              }
            })()
            return {
              cancel: () => { void client.interrupt().catch(() => undefined) },
              done,
            }
          },
        })
        const result: BackgroundResult = { kind: 'background', jobId, promptId, label }
        return result
      }

      const result = await waitSync(runtime, client, promptId, config, exec.signal, waitMs)
      return result
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
    if (optionsRecord !== undefined && 'default' in optionsRecord) {
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
    description: 'List the node definitions the configured ComfyUI server supports (class types, required and optional inputs). Use it to build valid API-format workflows for comfyui_run. Optional `filter` narrows by class-name substring, e.g. "KSampler", "VAE", "LoadImage".',
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
        display_name: def.display_name,
        description: (def.description ?? '').slice(0, 200),
        required: summarizeFields(def.input?.required, true),
        optional: summarizeFields(def.input?.optional, false),
      }))
      return {
        total: entries.length,
        shown: nodes.length,
        filter: filter ?? null,
        hint: filtered.length > nodes.length ? `filter matched ${filtered.length} nodes, showing first ${nodes.length} — narrow the filter for more` : undefined,
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
      'List and run saved ComfyUI workflows from the plugin workflow library (运行主题: API-format workflows extracted from a graph or pasted directly).',
      '`action: list` returns every runnable workflow with its id, name, description (what the workflow does), and input notes.',
      'It also lists workflows the user saved on the ComfyUI server (衍生主题: UI graph format canvases). A graph may hold SEVERAL independent flows; each is extracted into its own runnable workflow in the panel (整体/按分量/主流程). A graph with no extracted workflow yet cannot run — tell the user to open the ComfyUI panel and 提取 it first.',
      '`action: run` runs one saved workflow by id — pass only the id plus parameter overrides; the plugin submits the saved workflow JSON itself (never copy the JSON into your reply). It waits for media by default; add `mode: "async"` to run in the background and collect the result with job_output.',
      '`action: get` returns one saved workflow\'s complete API-format JSON by id for inspection/diagnostics only — it consumes many tokens and is not the run path.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'run', 'get'], description: 'list returns the workflow library; run executes one workflow by id (direct call to the saved JSON); get returns one workflow\'s full JSON for inspection.' },
        id: { type: 'string', description: 'Workflow id (required for action: run and get).' },
        mode: { type: 'string', enum: ['sync', 'async'], description: 'run mode (default sync); async starts a background job and returns its id for job_output. Video/audio workflows should use async — generation takes minutes and sync may time out.' },
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
          workflows?: Array<{ id: string; name: string; description: string; parameters?: Array<{ name: string; label: string; type: string; default?: string | number | boolean; random?: boolean; options?: Array<string | number>; upload?: 'image' | 'video' | 'audio' | 'media'; subfolder?: string }> }>
          comfyuiWorkflows?: Array<{ name: string; extracted: boolean; derived: Array<{ libraryId: string; name: string }> }>
          result?: RunResult
          id?: string
          name?: string
          workflow?: unknown
          background?: BackgroundResult
        }
        if (data.action === 'get') {
          return [{ type: 'text', text: `ComfyUI workflow ${data.name ?? data.id}: ${JSON.stringify(data.workflow)}` }]
        }
        if (data.background !== undefined) {
          return [{ type: 'text', text: `ComfyUI workflow started in the background (job ${data.background.jobId}, prompt ${data.background.promptId}). Collect the result with job_output.` }]
        }
        if (data.action === 'list') {
          const lines = [`Saved ComfyUI workflows (${data.workflows?.length ?? 0}):`]
          for (const workflow of data.workflows ?? []) {
            lines.push(`- ${workflow.id} — ${workflow.name}${workflow.description !== '' ? `: ${workflow.description}` : ''}`)
            for (const param of workflow.parameters ?? []) {
              const def = typeof param.default === 'string' ? `"${param.default}"` : String(param.default)
              const options = Array.isArray(param.options) && param.options.length > 0 ? `，可选: ${param.options.join(' / ')}` : ''
              const upload = param.upload !== undefined
                ? `，上传类型: ${param.upload}${param.upload === 'media' ? `（${param.subfolder ?? ''}/，空值=移除该参考位）` : ''}`
                : ''
              lines.push(`  ${param.name}(${param.label}${param.random === true ? '，随机' : ''}，默认 ${def}${options}${upload})`)
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
        const lines = [`ComfyUI workflow ${result.status} (prompt ${result.promptId}) in ${result.elapsedMs} ms — ${summarizeMedia(result.media)}`]
        for (const item of result.media) lines.push(`  ${item.kind}: ${item.url}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
      presentationMeta(_args, value) {
        return value
      },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const action = args.action
      if (action !== 'list' && action !== 'run' && action !== 'get') {
        throw new Error(`comfyui_workflow: action must be list, run, or get, got ${String(action)}`)
      }
      if (action === 'list') {
        const [workflows, comfyui] = await Promise.all([
          runtime.listWorkflows(),
          runtime.listComfyWorkflows().catch(() => []),
        ])
        return {
          action: 'list',
          workflows: workflows.map(({ id, name, description, parameters, updatedAt }) => ({
            id,
            name,
            description,
            parameters: (parameters ?? []).map(({ name: pname, label, type, default: def, random, options, upload }) => {
              // DSH validates tool output as lossless JSON: JSON.stringify drops
              // undefined keys, so omit optional fields instead of passing undefined.
              const entry: Record<string, unknown> = { name: pname, label, type, default: def }
              if (random !== undefined) entry.random = random
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
        throw new Error('comfyui_workflow: id is required for action: run and get')
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
      const config = runtime.getConfig()
      const client = runtime.createClient(await runtime.getApiKey())
      const values = typeof args.parameters === 'object' && args.parameters !== null
        ? (args.parameters as Record<string, unknown>)
        : {}
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
        const jobId = jobs.start({
          kind: 'comfyui',
          label: saved.name,
          ...(exec.agent !== undefined ? { owner: exec.agent } : {}),
          run: () => {
            const startedAt = Date.now()
            const done = (async () => {
              try {
                const entry = await client.waitForCompletion({
                  promptId,
                  timeoutMs: waitMs,
                  pollIntervalMs: config.pollIntervalMs,
                  signal: new AbortController().signal,
                })
                const items = collectMedia({ promptId, entry, maxItems: config.maxMediaItems, proxyBase: runtime.proxyBase() })
                const result: RunResult = {
                  kind: 'sync',
                  promptId,
                  status: 'completed',
                  elapsedMs: Date.now() - startedAt,
                  media: items,
                  summary: summarizeMedia(items),
                }
                return { status: 'completed' as const, output: JSON.stringify(result) }
              } catch (error) {
                runtime.untrack(promptId)
                const message = error instanceof Error ? error.message : String(error)
                return { status: 'failed' as const, detail: 'comfyui', output: message }
              }
            })()
            return {
              cancel: () => { void client.interrupt().catch(() => undefined) },
              done,
            }
          },
        })
        return { action: 'run', id, workflowName: saved.name, background: { kind: 'background', jobId, promptId, label: saved.name } }
      }
      const result = await waitSync(runtime, client, promptId, config, exec.signal, waitMs)
      return { action: 'run', id, workflowName: saved.name, result }
    },
  }
}

/** Register the plugin tools; returns disposers. */
export function registerComfyUITools(ctx: Context, runtime: ComfyUIRuntime): Array<() => void> {
  const tools = (ctx as unknown as { tools: { register(definition: ToolDefinition): () => void } }).tools
  const disposers: Array<() => void> = []
  disposers.push(tools.register(runDefinition(runtime, ctx)))
  disposers.push(tools.register(objectInfoDefinition(runtime)))
  disposers.push(tools.register(workflowDefinition(runtime, ctx)))
  return disposers
}
