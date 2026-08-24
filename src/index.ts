/**
 * dsh-comfyui host entry: wires the tools, HTTP routes, and media proxy, and
 * registers the `comfyui:` settings section so the browser settings page can
 * persist config without editing cordis.yml. Everything unmounts with the
 * plugin fiber.
 */
import type { Context } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { Config, type Config as ConfigType } from './config.js'
import { ComfyUIClient, CLIENT_ID } from './comfyui.js'
import { ComfyUIStore } from './store.js'
import { QueueTracker } from './queue.js'
import { convertGraphToApi } from './convert.js'
import { analyzeGraph } from './analyze.js'
import { ProgressTracker } from './progress.js'
import { COMFYUI_SKILL } from './skill.js'
import type { StoredWorkflow } from './store.js'
import { analyzeWorkflowParameters, applyWorkflowParameters, type Workflow } from './params.js'
import { registerComfyUITools, type ComfyUIRuntime } from './tools.js'
import { mountComfyUIRoutes } from './routes.js'
import { mountComfyUIProxy } from './proxy.js'
import { createHostHint, detectLanOrigin } from './host-hint.js'

export const name = 'dsh-comfyui'
export { Config }

/**
 * Required services. `tools` is the model-facing registry the plugin writes
 * into, so the fiber must wait for it: reading `ctx.tools` without declaring
 * it here is what cordis rejects with `cannot get property "tools" without
 * inject`. `webServer`, `settings`, and `credentials` stay OUT of this list —
 * they are optional, and the plugin degrades gracefully without them (see
 * apply).
 */
export const inject = ['tools']

const COMFYUI_NS = settingsNamespace('comfyui')

/** object_info is large and changes only when nodes are (re)installed. */
const OBJECT_INFO_TTL_MS = 60_000
let objectInfoCache: { ts: number; value: Record<string, unknown> } | undefined

async function objectInfoCached(client: ComfyUIClient): Promise<Record<string, unknown> | undefined> {
  const now = Date.now()
  if (objectInfoCache !== undefined && now - objectInfoCache.ts < OBJECT_INFO_TTL_MS) return objectInfoCache.value
  try {
    const value = await client.objectInfo()
    objectInfoCache = { ts: now, value }
    return value
  } catch {
    return undefined
  }
}

/** Structural slice of the credentials service (avoid a hard package dep). */
interface CredentialsService {
  resolve(ref: string): Promise<{ value: string; source: string } | undefined>
}

/** Structural slice of the settings service. */
interface SettingsService {
  readonly writable: boolean
  update(ns: unknown, patch: Record<string, unknown>): Promise<void>
}

async function resolveApiKey(ctx: Context, envName: string): Promise<string | undefined> {
  const credentials = ctx.get('credentials') as CredentialsService | undefined
  if (credentials !== undefined) {
    try {
      const resolved = await credentials.resolve(envName)
      if (resolved !== undefined) return resolved.value
    } catch {
      // Fall through to the process environment below.
    }
  }
  return process.env[envName]
}

/** Default plugin data directory under the harness home. */
function defaultDataDir(): string {
  const base = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(base, 'data', 'dsh-comfyui')
}

/**
 * The plugin body. The loader validates the entry config against `Config`
 * (defaults applied), then hands the resolved object to apply.
 */
export async function apply(ctx: Context, entryConfig: Partial<ConfigType>): Promise<void> {
  const resolved: ConfigType = {
    baseUrl: entryConfig.baseUrl ?? 'http://127.0.0.1:8188',
    apiKeyEnv: entryConfig.apiKeyEnv ?? 'COMFYUI_API_KEY',
    connectTimeoutMs: entryConfig.connectTimeoutMs ?? 10_000,
    timeoutMs: entryConfig.timeoutMs ?? 900_000,
    pollIntervalMs: entryConfig.pollIntervalMs ?? 1_000,
    maxMediaItems: entryConfig.maxMediaItems ?? 12,
    maxMediaBytes: entryConfig.maxMediaBytes ?? 64 * 1024 * 1024,
    dataDir: entryConfig.dataDir !== undefined && entryConfig.dataDir !== '' ? entryConfig.dataDir : defaultDataDir(),
    maxAssets: entryConfig.maxAssets ?? 200,
    mediaHost: entryConfig.mediaHost ?? '',
    outputDir: entryConfig.outputDir ?? '',
  }

  const store = new ComfyUIStore(resolved.dataDir, resolved.maxAssets)
  await store.init()
  const tracker = new QueueTracker({
    load: () => store.loadTracked(),
    save: (state) => store.saveTracked(state),
  })
  await tracker.init()
  const progress = new ProgressTracker()

  // Best-effort progress feed: listen on the server's WebSocket for `progress`
  // events. The socket uses the same client id as queued prompts (CLIENT_ID),
  // so progress events for prompts this plugin submits arrive here; the server
  // only broadcasts them to the submitting client. Node's global WebSocket
  // (undici) cannot set auth headers, so a remote server behind an
  // authenticating proxy simply shows no progress.
  ctx.effect(() => {
    const wsUrl = resolved.baseUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:').replace(/\/$/, '') + `/ws?clientId=${CLIENT_ID}`
    progress.attach(wsUrl)
    return () => progress.dispose()
  }, 'dsh-comfyui: progress')

  const hostHint = createHostHint()

  const runtime: ComfyUIRuntime = {
    getConfig: () => resolved,
    getApiKey: () => resolveApiKey(ctx, resolved.apiKeyEnv),
    createClient: (apiKey) => new ComfyUIClient(resolved.baseUrl, apiKey, resolved.connectTimeoutMs, resolved.maxMediaBytes),
    hostHint,
    proxyBase: () => {
      // Explicit external media host wins (LAN/domain/reverse-proxy config);
      // otherwise use the origin browsers actually reached this server with;
      // then the server's own LAN origin (reachable from remote browsers);
      // finally fall back to loopback. The result is always an absolute
      // http(s) URL, which the chat markdown renderer requires.
      const explicit = (resolved.mediaHost ?? '').trim().replace(/\/+$/, '')
      if (explicit !== '') return explicit
      const hinted = hostHint.origin()
      if (hinted !== undefined) return hinted
      const ws = ctx.get('webServer') as { port?: number; host?: string } | undefined
      if (ws === undefined || ws.port === undefined) return undefined
      const lan = detectLanOrigin(ws.port)
      if (lan !== undefined) return lan
      const host = ws.host === '0.0.0.0' ? '127.0.0.1' : ws.host ?? '127.0.0.1'
      return `http://${host}:${ws.port}`
    },
    settingsWritable: () => {
      const settings = ctx.get('settings') as SettingsService | undefined
      return settings?.writable === true
    },
    updateConfig: async (patch) => {
      const settings = ctx.get('settings') as SettingsService | undefined
      if (settings === undefined) {
        return { ok: false, error: 'settings service unavailable — edit cordis.yml instead' }
      }
      try {
        await settings.update(COMFYUI_NS, patch)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    queue: async (workflow, meta) => {
      const client = runtime.createClient(await resolveApiKey(ctx, resolved.apiKeyEnv))
      let prompt = workflow as unknown as Workflow
      if (meta.parameters !== undefined && meta.parameters.length > 0) {
        const objectInfo = await objectInfoCached(client)
        const slots = await store.loadSlots()
        const loaded = slots.filter((slot): slot is NonNullable<typeof slot> => slot !== null)
        prompt = applyWorkflowParameters(prompt, meta.parameters, meta.values ?? {}, objectInfo, await store.loadMediaSizes(), loaded)
      }
      const extraData: Record<string, unknown> = {}
      if (meta.workflowId !== undefined && meta.workflowId !== null && meta.workflowName !== null) {
        // ComfyUI's job metadata derives workflow_id from extra_pnginfo.workflow.id.
        extraData['extra_pnginfo'] = { workflow: { id: meta.workflowId, name: meta.workflowName } }
      }
      const promptId = await client.queuePrompt(prompt, { extraData })
      tracker.track({ promptId, ts: new Date().toISOString(), workflowName: meta.workflowName, source: meta.source })
      return promptId
    },
    untrack: (promptId) => tracker.untrack(promptId),
    trackedRuns: () => tracker.list(),
    queueProgress: (promptId) => progress.get(promptId),
    listWorkflows: () => store.listWorkflows(),
    getWorkflow: (id) => store.getWorkflow(id),
    saveWorkflow: (input) => store.saveWorkflow(input),
    deleteWorkflow: (id) => store.deleteWorkflow(id),
    listMediaSizes: () => store.loadMediaSizes(),
    saveMediaSize: (name, size) => store.saveMediaSize(name, size),
    lookupMediaHash: (hash) => store.lookupMediaHash(hash),
    saveMediaHash: (hash, name) => store.saveMediaHash(hash, name),
    loadSlots: () => store.loadSlots(),
    saveSlots: (slots) => store.saveSlots(slots),
    listAssets: () => store.listAssets(),
    deleteAsset: (promptId) => store.deleteAsset(promptId),
    sweep: async () => {
      const client = runtime.createClient(await resolveApiKey(ctx, resolved.apiKeyEnv))
      return tracker.sweep({ client, store, maxItems: resolved.maxMediaItems, proxyBase: runtime.proxyBase() })
    },
    listComfyWorkflows: async () => {
      const client = runtime.createClient(await resolveApiKey(ctx, resolved.apiKeyEnv))
      const entries = await client.listUserData('workflows')
      const library = await store.listWorkflows()
      return entries
        .filter((entry) => entry.type === 'file' && entry.name.endsWith('.json'))
        .map((entry) => {
          const derived = library.filter((workflow) => workflow.comfyuiFile === entry.name)
          return {
            name: entry.name,
            size: entry.size,
            modified: entry.modified,
            extracted: derived.length > 0,
            derived: derived.map((workflow) => ({ libraryId: workflow.id, name: workflow.name })),
          }
        })
    },
    getComfyWorkflow: async (file) => {
      const client = runtime.createClient(await resolveApiKey(ctx, resolved.apiKeyEnv))
      return client.getUserDataFile(`workflows/${file}`)
    },
    analyzeComfyWorkflow: async (file) => {
      const client = runtime.createClient(await resolveApiKey(ctx, resolved.apiKeyEnv))
      const graph = await client.getUserDataFile(`workflows/${file}`)
      return analyzeGraph(graph)
    },
    extractComfyWorkflow: async ({ file, mode }) => {
      const client = runtime.createClient(await resolveApiKey(ctx, resolved.apiKeyEnv))
      const [graph, objectInfo] = await Promise.all([
        client.getUserDataFile(`workflows/${file}`),
        client.objectInfo(),
      ])
      const analysis = analyzeGraph(graph)
      if (!analysis.ok) return { ok: false, error: analysis.error }
      if (analysis.components.length === 0) {
        return { ok: false, error: '图里没有可执行的分量（所有节点都被绕过或悬空）' }
      }
      const base = file.replace(/\.json$/i, '').slice(0, 40)
      const groupLabel = (component: { groups: string[] }): string =>
        component.groups.length > 0 ? `（${component.groups.slice(0, 3).join('+')}）` : ''
      const jobs: Array<{ name: string; description: string; includeNodeIds: Set<number> }> = []
      if (mode === 'all') {
        jobs.push({
          name: base,
          description: `从 ComfyUI 图工作流 ${file} 整体提取：${analysis.components.length} 个分量合成一个运行工作流。`,
          includeNodeIds: new Set(analysis.components.flatMap((component) => component.nodeIds)),
        })
      } else if (mode === 'main') {
        const main = analysis.components[0]
        if (main === undefined) {
          return { ok: false, error: '图里没有可提取的分量' }
        }
        jobs.push({
          name: `${base} · 主流程`,
          description: `从 ComfyUI 图工作流 ${file} 提取主流程（${main.size} 节点）${groupLabel(main)}。`,
          includeNodeIds: new Set(main.nodeIds),
        })
      } else {
        for (const component of analysis.components) {
          jobs.push({
            name: `${base} · 分量${component.index}${groupLabel(component)}`,
            description: `从 ComfyUI 图工作流 ${file} 提取第 ${component.index} 个分量（${component.size} 节点）${groupLabel(component)}。`,
            includeNodeIds: new Set(component.nodeIds),
          })
        }
      }
      const saved: StoredWorkflow[] = []
      const warnings: string[] = []
      for (const job of jobs) {
        const converted = convertGraphToApi(graph, objectInfo, { includeNodeIds: job.includeNodeIds })
        if (!converted.ok) return { ok: false, error: `${job.name}：${converted.error}` }
        for (const warning of converted.warnings) warnings.push(`${job.name}：${warning}`)
        const hasOutput = Object.values(converted.workflow).some((node) => {
          const def = objectInfo[node.class_type] as { output_node?: boolean } | undefined
          return def?.output_node === true
        })
        if (!hasOutput) {
          warnings.push(`${job.name}：分量没有任何输出节点（ComfyUI 无法排队），已跳过`)
          continue
        }
        const parameters = analyzeWorkflowParameters(converted.workflow, objectInfo)
        const result = await store.saveWorkflow({
          name: job.name.slice(0, 80),
          description: job.description,
          workflow: converted.workflow,
          parameters,
          source: 'comfyui',
          comfyuiFile: file,
        })
        if (!result.ok) return result
        saved.push(result.workflow)
      }
      if (saved.length === 0) {
        return { ok: false, error: '没有可提取的分量：所有分量都无输出节点或被跳过' }
      }
      return { ok: true, saved, analysis, warnings }
    },
  }

  // The settings section rides the plugin fiber: a host without a settings
  // service simply never registers it, and the entry config stands as composed.
  let source: () => ConfigType = () => resolved
  installSettingsSection(ctx, COMFYUI_NS, Config, resolved, {
    setSource: (current) => {
      source = current as () => ConfigType
    },
    onChange: () => {
      Object.assign(resolved, source())
    },
  })

  ctx.effect(() => {
    const disposers = registerComfyUITools(ctx, runtime)
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-comfyui: tools')

  // The companion skill rides the same optional-services pattern: headless
  // hosts without a skills service simply skip it. Runtime skills register at
  // rank 250, so project/user skills can override the shipped guidance.
  ctx.effect(() => {
    const skills = ctx.get('skills') as { register(skill: unknown): () => void } | undefined
    if (skills === undefined) return () => {}
    return skills.register({
      ...COMFYUI_SKILL,
      content: COMFYUI_SKILL.content,
    })
  }, 'dsh-comfyui: skill')

  // Routes and the media proxy ride a `webServer` sub-fiber rather than a
  // one-shot `ctx.get` at apply time: loader entries settle concurrently, so
  // reading the service here would silently skip both mounts whenever the web
  // server happens to activate after this plugin. A headless host never
  // activates this fiber and keeps the tools alone.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const disposers: Array<() => void> = []
      const routesDisposer = mountComfyUIRoutes(webCtx, runtime)
      if (routesDisposer !== undefined) disposers.push(routesDisposer)
      const proxyDisposer = mountComfyUIProxy(webCtx, runtime)
      if (proxyDisposer !== undefined) disposers.push(proxyDisposer)
      // Inject a one-line self-report into the served index.html: on every
      // page load the browser pings /comfyui/ping, which records the origin
      // the browser actually uses, so generated media URLs match the user's
      // address (LAN IP, domain, reverse proxy) without any configuration.
      const webServer = webCtx.get('webServer') as { tapIndex(transform: (html: string) => string): () => void } | undefined
      if (webServer !== undefined) {
        disposers.push(webServer.tapIndex((html) => {
          if (html.includes('dsh-comfyui-ping')) return html
          return html.replace('</head>', '<script>/* dsh-comfyui-ping */try{fetch("/comfyui/ping",{cache:"no-store"})}catch(e){}</script></head>')
        }))
      }
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'dsh-comfyui: routes and media proxy')
  })
}
