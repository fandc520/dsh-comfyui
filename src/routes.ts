/**
 * Browser-facing HTTP routes for dsh-comfyui: configuration (read/redacted,
 * persist through the settings service), a connection probe, the workflow
 * library (list/save/delete/run), the asset index, and the live ComfyUI
 * queue view. Writes are same-origin-only.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { errorMessage, readJsonBody, readRawBody, sameOrigin, sendJson } from './http.js'
import type { ComfyUIRuntime } from './tools.js'
import { analyzeWorkflowParameters, comboChildInfo, inputOptions, numberSpecOf, uploadKindOf, type Workflow } from './params.js'
import { collectMedia, historyErrorMessage, mediaProxyUrl, type ComfyUIMediaRef } from './comfyui.js'
import type { AssetRecord } from './store.js'
import { unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** One selectable item in the load-area picker. */
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

/**
 * Rebuild an asset's media URLs from the stored file references.
 *
 * Records written before the media proxy addressed files directly carry
 * prompt/node/index URLs, which only resolve while ComfyUI still has that run
 * in its in-memory /history — a server restart or a "clear history" click
 * makes every one of them 404 ("source file evicted"), even though the files
 * are untouched in the output directory. Healing them on read fixes the whole
 * back catalogue without rewriting the stored index.
 */
function healAssetUrls(assets: AssetRecord[]): AssetRecord[] {
  return assets.map((asset) => ({
    ...asset,
    media: asset.media.map((item) => (
      item.filename === '' ? item : { ...item, url: mediaProxyUrl(item) }
    )),
  }))
}

/**
 * Where ComfyUI writes its outputs on this machine.
 *
 * ComfyUI has no API that deletes an output file (its own asset routes only
 * soft-delete a database row and keep the content), so removing a generated
 * file means touching the filesystem directly. The configured `outputDir`
 * wins; otherwise it is inferred from the absolute path some nodes report
 * with their results (`fullpath`), by stripping the subfolder/filename tail
 * the record already carries. When neither is available — a ComfyUI on
 * another host, for instance — deletion degrades to dropping the index
 * record and says so.
 */
function resolveOutputDir(configured: string, assets: AssetRecord[]): string | undefined {
  if (configured !== '' && isAbsolute(configured)) return resolve(configured)
  for (const asset of assets) {
    for (const item of asset.media) {
      const full = (item as { fullpath?: unknown }).fullpath
      if (typeof full !== 'string' || full === '' || item.filename === '') continue
      const tail = item.subfolder !== '' ? `${item.subfolder}/${item.filename}` : item.filename
      const normalized = full.replace(/\\/g, '/')
      if (!normalized.endsWith(tail)) continue
      const root = normalized.slice(0, normalized.length - tail.length).replace(/[/]+$/, '')
      if (root !== '') return resolve(root)
    }
  }
  return undefined
}

/** Delete one generated file under the output directory. Returns 'deleted',
 * 'missing' (already gone — the record still goes), or 'skipped' when the
 * reference does not resolve inside the output directory. */
async function deleteOutputFile(outputDir: string, ref: { filename: string; subfolder: string; type: string }): Promise<'deleted' | 'missing' | 'skipped'> {
  // 'temp' and 'input' live in sibling directories that this mapping does not
  // cover; only outputs are ours to remove.
  if (ref.filename === '' || (ref.type !== '' && ref.type !== 'output')) return 'skipped'
  const target = resolve(join(outputDir, ref.subfolder, ref.filename))
  // Path-traversal guard: a crafted subfolder/filename must not reach outside.
  const rel = relative(outputDir, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) return 'skipped'
  try {
    await unlink(target)
    return 'deleted'
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return 'missing'
    throw error
  }
}

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|avi|m4v)$/i
const AUDIO_EXT = /\.(mp3|wav|ogg|flac|m4a|aac|opus)$/i
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|avif)$/i

/** The media kind of a file name, falling back to the loader's own kind when
 * the extension says nothing. */
function mediaKindOfName(name: string, fallback: 'image' | 'video' | 'audio'): 'image' | 'video' | 'audio' {
  if (VIDEO_EXT.test(name)) return 'video'
  if (AUDIO_EXT.test(name)) return 'audio'
  if (IMAGE_EXT.test(name)) return 'image'
  return fallback
}

/** The file-picker input key of a loader node class, taken from its
 * object_info upload flag (image_upload / video_upload / audio_upload) so a
 * renamed key does not silently empty the load area. */
function loaderInputKey(objectInfo: Record<string, unknown> | undefined, classType: string): string | undefined {
  const def = objectInfo?.[classType] as { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } } | undefined
  const inputs = { ...def?.input?.required, ...def?.input?.optional }
  for (const key of Object.keys(inputs)) {
    if (uploadKindOf(objectInfo, classType, key) !== undefined) return key
  }
  return undefined
}

function generatedUrlOf(assets: AssetRecord[], name: string): string | undefined {
  for (const asset of assets) {
    for (const item of asset.media) {
      if (item.filename === name && item.url !== undefined) return item.url
    }
  }
  return undefined
}

function findOutputRef(assets: AssetRecord[], name: string): ComfyUIMediaRef | undefined {
  for (const asset of assets) {
    for (const item of asset.media) {
      if (item.filename === name) {
        return { filename: item.filename, subfolder: item.subfolder, type: item.type }
      }
    }
  }
  return undefined
}

function redact(runtime: ComfyUIRuntime, apiKey: string | undefined): Record<string, unknown> {
  const config = runtime.getConfig()
  return {
    baseUrl: config.baseUrl,
    apiKeyEnv: config.apiKeyEnv,
    hasApiKey: apiKey !== undefined,
    timeoutMs: config.timeoutMs,
    pollIntervalMs: config.pollIntervalMs,
    maxMediaItems: config.maxMediaItems,
    mediaHost: config.mediaHost,
    writable: runtime.settingsWritable(),
  }
}

function methodIs(request: IncomingMessage, method: string): boolean {
  return request.method === method
}

/**
 * Video/audio previews cannot render as <img> thumbnails. VHS embeds the
 * companion workflow image (same basename, .png) in the video's `workflow`
 * field; prefer it. Without one, drop the preview entirely.
 */
function previewThumb(preview: { filename?: string; subfolder?: string; type?: string; mediaType?: string; workflow?: string } | null): { filename?: string; subfolder?: string; type?: string; mediaType?: string } | null {
  if (preview === null || preview.filename === undefined || preview.filename === null) return null
  const isMedia = preview.mediaType === 'gifs' || preview.mediaType === 'video' || preview.mediaType === 'audio'
    || /\.(mp4|webm|mov|mkv|avi|mp3|wav|ogg|flac|m4a|aac|opus)$/i.test(preview.filename)
  if (!isMedia) {
    return { filename: preview.filename, subfolder: preview.subfolder ?? '', type: preview.type ?? 'output', mediaType: preview.mediaType }
  }
  if (typeof preview.workflow === 'string' && preview.workflow !== '' && /\.(png|jpe?g|webp|gif)$/i.test(preview.workflow)) {
    return { filename: preview.workflow, subfolder: preview.subfolder ?? '', type: preview.type ?? 'output', mediaType: 'image' }
  }
  return null
}

/** Reject non-same-origin requests; returns the parsed body otherwise. */
async function readSameOriginPost(request: IncomingMessage, response: ServerResponse): Promise<Record<string, unknown> | undefined> {
  if (!sameOrigin(request)) {
    sendJson(response, 403, { error: 'forbidden: same-origin requests only' })
    return undefined
  }
  const body = await readJsonBody(request)
  return (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
}

/**
 * Mount every dsh-comfyui route on the host web server.
 * @returns the disposer, or undefined when no web server is present.
 */
export function mountComfyUIRoutes(ctx: Context, runtime: ComfyUIRuntime): (() => void) | undefined {
  const webServer = ctx.get('webServer') as {
    register(route: { kind: string; path: string; handler(request: IncomingMessage, response: ServerResponse): void | Promise<void> }): () => void
  } | undefined
  if (webServer === undefined) return undefined

  // Record the browser's request origin on every route so media URLs can use
  // the address the browser actually reached (loopback, LAN IP, or domain).
  const withHint = (
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  ): ((request: IncomingMessage, response: ServerResponse) => void | Promise<void>) => {
    return (request, response) => {
      runtime.hostHint.record(request)
      return handler(request, response)
    }
  }

  const disposers: Array<() => void> = []

  // Browser self-report: the index.html tap injects a one-line fetch that
  // fires on every page load, so the host hint learns the origin the browser
  // is actually using (e.g. http://100.97.190.89:3080) before any generation
  // — without relying on the panel being opened or media being loaded.
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/comfyui/ping',
    handler: withHint(async (_request, response) => {
      sendJson(response, 200, { ok: true })
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/comfyui/config',
    handler: withHint(async (request, response) => {
      if (methodIs(request, 'GET')) {
        const apiKey = await runtime.getApiKey()
        sendJson(response, 200, redact(runtime, apiKey))
        return
      }
      if (methodIs(request, 'POST')) {
        const body = await readSameOriginPost(request, response)
        if (body === undefined) return
        const patch = body.patch
        if (patch === undefined || typeof patch !== 'object' || patch === null) {
          sendJson(response, 400, { error: 'a patch object is required' })
          return
        }
        const result = await runtime.updateConfig(patch as Record<string, unknown>)
        if (!result.ok) {
          sendJson(response, 409, { error: result.error })
          return
        }
        const apiKey = await runtime.getApiKey()
        sendJson(response, 200, { ok: true, config: redact(runtime, apiKey) })
        return
      }
      sendJson(response, 405, { error: 'method not allowed' })
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/comfyui/test',
    handler: withHint(async (request, response) => {
      if (!methodIs(request, 'POST')) {
        sendJson(response, 405, { error: 'method not allowed' })
        return
      }
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: 'forbidden: same-origin requests only' })
        return
      }
      const startedAt = Date.now()
      try {
        const client = runtime.createClient(await runtime.getApiKey())
        const stats = await client.systemStats()
        sendJson(response, 200, {
          ok: true,
          version: stats.system?.comfyui_version ?? 'unknown',
          latencyMs: Date.now() - startedAt,
        })
      } catch (error) {
        sendJson(response, 200, { ok: false, error: errorMessage(error), latencyMs: Date.now() - startedAt })
      }
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/comfyui/workflows',
    handler: withHint(async (request, response) => {
      if (methodIs(request, 'GET')) {
        sendJson(response, 200, { workflows: await runtime.listWorkflows() })
        return
      }
      if (methodIs(request, 'POST')) {
        const body = await readSameOriginPost(request, response)
        if (body === undefined) return
        if (body.workflow === undefined) {
          sendJson(response, 400, { error: 'workflow is required' })
          return
        }
        const result = await runtime.saveWorkflow({
          id: typeof body.id === 'string' ? body.id : undefined,
          name: typeof body.name === 'string' ? body.name : '',
          description: typeof body.description === 'string' ? body.description : '',
          workflow: body.workflow,
          parameters: Array.isArray(body.parameters) ? body.parameters : undefined,
          tags: Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
        })
        if (!result.ok) {
          sendJson(response, 400, { error: result.error })
          return
        }
        sendJson(response, 200, { ok: true, workflow: result.workflow })
        return
      }
      sendJson(response, 405, { error: 'method not allowed' })
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/comfyui/workflows/recognize',
    handler: withHint(async (request, response) => {
      if (!methodIs(request, 'POST')) {
        sendJson(response, 405, { error: 'method not allowed' })
        return
      }
      const body = await readSameOriginPost(request, response)
      if (body === undefined) return
      if (body.workflow === undefined || typeof body.workflow !== 'object' || body.workflow === null) {
        sendJson(response, 400, { error: 'workflow is required' })
        return
      }
      const client = runtime.createClient(await runtime.getApiKey())
      const objectInfo = await client.objectInfo().catch(() => undefined)
      const parameters = analyzeWorkflowParameters(body.workflow as Workflow, objectInfo)
      sendJson(response, 200, { ok: true, parameters })
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/comfyui/workflows/input-options',
    handler: withHint(async (request, response) => {
      if (!methodIs(request, 'POST')) {
        sendJson(response, 405, { error: 'method not allowed' })
        return
      }
      const body = await readSameOriginPost(request, response)
      if (body === undefined) return
      const classType = typeof body.classType === 'string' ? body.classType : ''
      const inputKey = typeof body.inputKey === 'string' ? body.inputKey : ''
      if (classType === '' || inputKey === '') {
        sendJson(response, 400, { error: 'classType and inputKey are required' })
        return
      }
      const client = runtime.createClient(await runtime.getApiKey())
      const objectInfo = await client.objectInfo().catch(() => undefined)
      const options = inputOptions(objectInfo, classType, inputKey)
      const child = typeof body.parentValue === 'string'
        ? comboChildInfo(objectInfo, classType, inputKey, body.parentValue)
        : undefined
      const upload = uploadKindOf(objectInfo, classType, inputKey)
      // Declared INT/FLOAT type: the editor uses it to allow (or round away)
      // decimals instead of assuming every number input is an integer.
      const number = numberSpecOf(objectInfo, classType, inputKey)
      sendJson(response, 200, { ok: true, options: options ?? [], child, upload, number })
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/comfyui/loadarea',
    handler: withHint(async (request, response) => {
      if (!methodIs(request, 'GET')) {
        sendJson(response, 405, { error: 'method not allowed' })
        return
      }
      try {
        const client = runtime.createClient(await runtime.getApiKey())
        const [objectInfo, slots, assets, sizes] = await Promise.all([
          client.objectInfo().catch(() => undefined),
          runtime.loadSlots(),
          runtime.listAssets().then(healAssetUrls),
          runtime.listMediaSizes(),
        ])
        const files: LoadAreaFile[] = []
        const seen = new Set<string>()
        // imported: files visible to the ComfyUI loader nodes (input dir).
        // The input key is read from object_info rather than hard-coded —
        // LoadImage calls it "image", LoadVideo "file", LoadAudio "audio",
        // and guessing wrong silently drops that whole media type from the
        // load area (which is what happened to video).
        const loaderSpecs: Array<[string, LoadAreaFile['kind']]> = [
          ['LoadImage', 'image'],
          ['LoadVideo', 'video'],
          ['LoadAudio', 'audio'],
        ]
        for (const [classType, fallbackKind] of loaderSpecs) {
          const inputKey = loaderInputKey(objectInfo, classType)
          if (inputKey === undefined) continue
          for (const option of inputOptions(objectInfo, classType, inputKey) ?? []) {
            const name = String(option)
            if (seen.has(name)) continue
            seen.add(name)
            files.push({
              // Classify by extension first: ComfyUI lists an .mp4 under
              // LoadAudio too (it can pull the audio track), and whichever
              // loader happened to be scanned first would otherwise decide
              // the file's type in the picker.
              name,
              kind: mediaKindOfName(name, fallbackKind),
              source: 'imported',
              url: `/comfyui/media?file=${encodeURIComponent(name)}&type=input`,
              width: sizes[name]?.width,
              height: sizes[name]?.height,
            })
          }
        }
        // generated: completed runs collected into the asset index (output dir)
        for (const asset of assets) {
          for (const item of asset.media) {
            if (item.filename === '' || seen.has(item.filename)) continue
            seen.add(item.filename)
            files.push({
              name: item.filename,
              kind: item.kind === 'video' ? 'video' : item.kind === 'audio' ? 'audio' : 'image',
              source: 'generated',
              url: item.url,
              ts: asset.ts,
              workflowName: asset.workflowName,
            })
          }
        }
        // Every slot in order; `null` entries are empty slots the user added.
        const slotEntries: Array<LoadAreaFile | null> = slots.map((slot) => {
          if (slot === null) return null
          const url = slot.source === 'generated'
            ? generatedUrlOf(assets, slot.name) ?? `/comfyui/media?file=${encodeURIComponent(slot.name)}&type=output`
            : `/comfyui/media?file=${encodeURIComponent(slot.name)}&type=input`
          return {
            name: slot.name,
            kind: slot.kind,
            source: slot.source,
            url,
            width: sizes[slot.name]?.width,
            height: sizes[slot.name]?.height,
          }
        })
        // `current` stays in the payload as the first filled slot: it is the
        // primary source image, and older clients read only this field.
        const currentEntry = slotEntries.find((entry): entry is LoadAreaFile => entry !== null) ?? null
        sendJson(response, 200, { ok: true, current: currentEntry, slots: slotEntries, files })
      } catch (error) {
        sendJson(response, 500, { error: errorMessage(error) })
      }
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/comfyui/current-image',
    handler: withHint(async (request, response) => {
      if (!methodIs(request, 'POST')) {
        sendJson(response, 405, { error: 'method not allowed' })
        return
      }
      const body = await readSameOriginPost(request, response)
      if (body === undefined) return
      // Slot operations of the load area. `pick` (the default, and the body
      // shape older clients send) puts a file into a slot; the others manage
      // the slots themselves.
      const action = typeof body.action === 'string' ? body.action : 'pick'
      const slots = await runtime.loadSlots()
      const index = typeof body.index === 'number' && Number.isInteger(body.index) && body.index >= 0
        ? body.index
        : undefined
      try {
        switch (action) {
          case 'addSlot':
            slots.push(null)
            break
          case 'clear': {
            // "清除素材": the slot stays, its file is dropped.
            if (index === undefined || index >= slots.length) {
              sendJson(response, 400, { error: 'index is required and must point at an existing slot' })
              return
            }
            slots[index] = null
            break
          }
          case 'removeSlot': {
            // "删除加载区": the slot itself goes away.
            if (index === undefined || index >= slots.length) {
              sendJson(response, 400, { error: 'index is required and must point at an existing slot' })
              return
            }
            slots.splice(index, 1)
            break
          }
          case 'pick': {
            const name = typeof body.name === 'string' ? body.name : ''
            if (name === '') {
              sendJson(response, 400, { error: 'name is required' })
              return
            }
            const kind = body.kind === 'video' ? 'video' : body.kind === 'audio' ? 'audio' : 'image'
            const source = body.source === 'generated' ? 'generated' : 'imported'
            // No index: fill the first empty slot, or open a new one. This is
            // what the picker sends when the user adds material to the load
            // area without targeting a particular slot. Resolve and validate
            // the target before copying anything, so a bad index cannot leave
            // a file copied into ComfyUI with no slot to show for it.
            const firstEmpty = slots.findIndex((slot) => slot === null)
            const target = index ?? (firstEmpty === -1 ? slots.length : firstEmpty)
            if (target > slots.length) {
              sendJson(response, 400, { error: 'index is out of range' })
              return
            }
            if (source === 'generated') {
              // Generated outputs live in ComfyUI's output dir; copy the
              // selected one into the input dir (same name) so loader nodes
              // can use it.
              const assets = await runtime.listAssets()
              const ref = findOutputRef(assets, name)
              if (ref !== undefined) {
                const client = runtime.createClient(await runtime.getApiKey())
                const { bytes, contentType } = await client.fetchView(ref)
                await client.uploadMedia(bytes, name, contentType)
              }
            }
            slots[target] = { name, kind, source }
            break
          }
          default:
            sendJson(response, 400, { error: `unknown action "${action}"` })
            return
        }
        await runtime.saveSlots(slots)
        sendJson(response, 200, { ok: true, slots: slots.length, loaded: slots.filter((slot) => slot !== null).length })
      } catch (error) {
        sendJson(response, 500, { error: errorMessage(error) })
      }
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/comfyui/upload',
    handler: withHint(async (request, response) => {
      if (!methodIs(request, 'POST')) {
        sendJson(response, 405, { error: 'method not allowed' })
        return
      }
      const contentType = request.headers['content-type'] ?? ''
      if (!contentType.startsWith('multipart/form-data')) {
        sendJson(response, 400, { error: 'multipart/form-data required' })
        return
      }
      try {
        // Forward the multipart body verbatim (field "image" matches ComfyUI's
        // /upload/image contract); the browser never talks to ComfyUI directly.
        const raw = await readRawBody(request)
        const client = runtime.createClient(await runtime.getApiKey())
        const result = await client.uploadFile(new Uint8Array(raw), contentType)
        sendJson(response, 200, { ok: true, name: result.name ?? '' })
      } catch (error) {
        sendJson(response, 502, { error: errorMessage(error) })
      }
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/comfyui/media-size',
    handler: withHint(async (request, response) => {
      if (!methodIs(request, 'POST')) {
        sendJson(response, 405, { error: 'method not allowed' })
        return
      }
      const body = await readSameOriginPost(request, response)
      if (body === undefined) return
      const name = typeof body.name === 'string' && body.name !== '' ? body.name : ''
      const width = typeof body.width === 'number' && Number.isFinite(body.width) && body.width > 0 ? Math.round(body.width) : undefined
      const height = typeof body.height === 'number' && Number.isFinite(body.height) && body.height > 0 ? Math.round(body.height) : undefined
      if (name === '' || width === undefined || height === undefined) {
        sendJson(response, 400, { error: 'name, width and height are required' })
        return
      }
      await runtime.saveMediaSize(name, { width, height })
      sendJson(response, 200, { ok: true })
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/comfyui/media-lookup',
    handler: withHint(async (request, response) => {
      if (!methodIs(request, 'POST')) {
        sendJson(response, 405, { error: 'method not allowed' })
        return
      }
      const body = await readSameOriginPost(request, response)
      if (body === undefined) return
      const hash = typeof body.hash === 'string' && body.hash !== '' ? body.hash : ''
      if (hash === '') {
        sendJson(response, 400, { error: 'hash is required' })
        return
      }
      const name = await runtime.lookupMediaHash(hash)
      if (name === undefined) {
        sendJson(response, 200, { ok: true, found: false })
      } else {
        sendJson(response, 200, { ok: true, found: true, name })
      }
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/comfyui/media-hash',
    handler: withHint(async (request, response) => {
      if (!methodIs(request, 'POST')) {
        sendJson(response, 405, { error: 'method not allowed' })
        return
      }
      const body = await readSameOriginPost(request, response)
      if (body === undefined) return
      const hash = typeof body.hash === 'string' && body.hash !== '' ? body.hash : ''
      const name = typeof body.name === 'string' && body.name !== '' ? body.name : ''
      if (hash === '' || name === '') {
        sendJson(response, 400, { error: 'hash and name are required' })
        return
      }
      await runtime.saveMediaHash(hash, name)
      sendJson(response, 200, { ok: true })
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/comfyui/workflows/delete',
    handler: withHint(async (request, response) => {
      if (!methodIs(request, 'POST')) {
        sendJson(response, 405, { error: 'method not allowed' })
        return
      }
      const body = await readSameOriginPost(request, response)
      if (body === undefined) return
      const id = typeof body.id === 'string' ? body.id : ''
      if (id === '') {
        sendJson(response, 400, { error: 'id is required' })
        return
      }
      await runtime.deleteWorkflow(id)
      sendJson(response, 200, { ok: true })
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/comfyui/workflows/run',
    handler: withHint(async (request, response) => {
      if (!methodIs(request, 'POST')) {
        sendJson(response, 405, { error: 'method not allowed' })
        return
      }
      const body = await readSameOriginPost(request, response)
      if (body === undefined) return
      const id = typeof body.id === 'string' ? body.id : ''
      if (id === '') {
        sendJson(response, 400, { error: 'id is required' })
        return
      }
      const saved = await runtime.getWorkflow(id)
      if (saved === undefined) {
        sendJson(response, 404, { error: `workflow "${id}" not found` })
        return
      }
      try {
        const values = typeof body.parameters === 'object' && body.parameters !== null
          ? (body.parameters as Record<string, unknown>)
          : {}
        const promptId = await runtime.queue(saved.workflow, {
          workflowName: saved.name,
          workflowId: saved.id,
          source: 'panel',
          parameters: saved.parameters,
          values,
        })
        sendJson(response, 200, { ok: true, promptId, workflowName: saved.name })
      } catch (error) {
        sendJson(response, 502, { error: errorMessage(error) })
      }
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/comfyui/comfy-workflows',
    handler: withHint(async (request, response) => {
      if (!methodIs(request, 'GET')) {
        sendJson(response, 405, { error: 'method not allowed' })
        return
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      const file = url.searchParams.get('file')
      if (file !== null) {
        try {
          const workflow = await runtime.getComfyWorkflow(file)
          sendJson(response, 200, { ok: true, file, workflow })
        } catch (error) {
          sendJson(response, 200, { ok: false, error: errorMessage(error) })
        }
        return
      }
      try {
        const workflows = await runtime.listComfyWorkflows()
        sendJson(response, 200, { ok: true, workflows })
      } catch (error) {
        sendJson(response, 200, { ok: false, error: errorMessage(error) })
      }
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/comfyui/comfy-workflows/analyze',
    handler: withHint(async (request, response) => {
      if (!methodIs(request, 'GET')) {
        sendJson(response, 405, { error: 'method not allowed' })
        return
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      const file = url.searchParams.get('file')
      if (file === null || file === '') {
        sendJson(response, 400, { error: 'file is required' })
        return
      }
      try {
        const analysis = await runtime.analyzeComfyWorkflow(file)
        sendJson(response, 200, { ok: true, file, analysis })
      } catch (error) {
        sendJson(response, 200, { ok: false, error: errorMessage(error) })
      }
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/comfyui/comfy-workflows/extract',
    handler: withHint(async (request, response) => {
      if (!methodIs(request, 'POST')) {
        sendJson(response, 405, { error: 'method not allowed' })
        return
      }
      const body = await readSameOriginPost(request, response)
      if (body === undefined) return
      const file = typeof body.file === 'string' ? body.file : ''
      const mode = body.mode === 'all' || body.mode === 'split' || body.mode === 'main' ? body.mode : undefined
      if (file === '' || mode === undefined) {
        sendJson(response, 400, { error: 'file and mode (all|split|main) are required' })
        return
      }
      const result = await runtime.extractComfyWorkflow({ file, mode })
      if (!result.ok) {
        sendJson(response, 422, { error: result.error })
        return
      }
      sendJson(response, 200, { ok: true, saved: result.saved, analysis: result.analysis, warnings: result.warnings })
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/comfyui/assets',
    handler: withHint(async (request, response) => {
      if (!methodIs(request, 'GET')) {
        sendJson(response, 405, { error: 'method not allowed' })
        return
      }
      // Sweep completed tracked runs into the index before listing, so the
      // panel sees results as soon as the next poll lands.
      await runtime.sweep()
      sendJson(response, 200, { ok: true, assets: healAssetUrls(await runtime.listAssets()) })
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/comfyui/assets/delete',
    handler: withHint(async (request, response) => {
      if (!methodIs(request, 'POST')) {
        sendJson(response, 405, { error: 'method not allowed' })
        return
      }
      const body = await readSameOriginPost(request, response)
      if (body === undefined) return
      const promptId = typeof body.promptId === 'string' ? body.promptId : ''
      if (promptId === '') {
        sendJson(response, 400, { error: 'promptId is required' })
        return
      }
      try {
        // Resolve the output directory from the index *before* the record is
        // removed: the path hint may live on the very record being deleted.
        const assets = await runtime.listAssets()
        const outputDir = resolveOutputDir(runtime.getConfig().outputDir, assets)
        const removed = await runtime.deleteAsset(promptId)
        if (removed === undefined) {
          sendJson(response, 404, { error: `asset ${promptId} not found` })
          return
        }
        let deleted = 0
        let missing = 0
        let skipped = 0
        const failures: string[] = []
        if (outputDir !== undefined) {
          for (const item of removed.media) {
            try {
              const result = await deleteOutputFile(outputDir, { filename: item.filename, subfolder: item.subfolder, type: item.type })
              if (result === 'deleted') deleted += 1
              else if (result === 'missing') missing += 1
              else skipped += 1
            } catch (error) {
              // The record is already gone; report which files survived it.
              failures.push(`${item.filename}: ${errorMessage(error)}`)
            }
          }
        } else {
          skipped = removed.media.length
        }
        sendJson(response, 200, {
          ok: true,
          promptId,
          files: removed.media.length,
          deleted,
          missing,
          skipped,
          outputDir: outputDir ?? null,
          failures,
        })
      } catch (error) {
        sendJson(response, 500, { error: errorMessage(error) })
      }
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/comfyui/queue',
    handler: withHint(async (request, response) => {
      if (!methodIs(request, 'GET')) {
        sendJson(response, 405, { error: 'method not allowed' })
        return
      }
      try {
        const client = runtime.createClient(await runtime.getApiKey())
        const queue = await client.getQueue()
        const tracked = runtime.trackedRuns()
        const trackedBy = new Map(tracked.map((run) => [run.promptId, run]))
        const mapEntry = (entry: { prompt_id: string }) => {
          const ours = trackedBy.get(entry.prompt_id)
          const progress = runtime.queueProgress(entry.prompt_id)
          return {
            promptId: entry.prompt_id,
            ours: ours !== undefined,
            workflowName: ours?.workflowName ?? null,
            progress: progress !== undefined ? { value: progress.value, max: progress.max } : null,
          }
        }
        sendJson(response, 200, {
          ok: true,
          running: (queue.queue_running ?? []).map(mapEntry),
          pending: (queue.queue_pending ?? []).map(mapEntry),
          tracked: tracked.slice(0, 20),
        })
      } catch (error) {
        sendJson(response, 200, { ok: false, error: errorMessage(error) })
      }
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/comfyui/jobs',
    handler: withHint(async (request, response) => {
      if (!methodIs(request, 'GET')) {
        sendJson(response, 405, { error: 'method not allowed' })
        return
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      const statusParam = url.searchParams.get('status') ?? 'all'
      const statuses = statusParam === 'all' || statusParam === ''
        ? undefined
        : statusParam.split(',').filter((s) => s === 'pending' || s === 'in_progress' || s === 'completed' || s === 'failed' || s === 'cancelled')
      const parseCount = (raw: string | null, fallback: number): number => {
        const n = Number(raw ?? '')
        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
      }
      try {
        const client = runtime.createClient(await runtime.getApiKey())
        const tracked = runtime.trackedRuns()
        const trackedBy = new Map(tracked.map((run) => [run.promptId, run]))
        // Fallback names from the asset index: survives web-server restarts,
        // which clear the in-memory tracked runs.
        const assets = await runtime.listAssets()
        const assetNameByPrompt = new Map(assets.map((asset) => [asset.promptId, asset.workflowName]))
        const result = await client.getJobs({
          status: statuses,
          limit: parseCount(url.searchParams.get('limit'), 100),
          offset: parseCount(url.searchParams.get('offset'), 0),
          sortBy: 'created_at',
          sortOrder: 'desc',
        })
        const jobs = result.jobs.map((job) => {
          const ours = trackedBy.get(job.id)
          const progress = runtime.queueProgress(job.id)
          return {
            id: job.id,
            status: job.status,
            createTime: job.create_time,
            executionStartTime: job.execution_start_time ?? null,
            executionEndTime: job.execution_end_time ?? null,
            executionError: job.execution_error ?? null,
            outputsCount: job.outputs_count,
            previewOutput: previewThumb(job.preview_output ?? null),
            workflowId: job.workflow_id ?? null,
            workflowName: ours?.workflowName ?? assetNameByPrompt.get(job.id) ?? null,
            ours: ours !== undefined,
            progress: progress !== undefined ? { value: progress.value, max: progress.max } : null,
          }
        })
        sendJson(response, 200, {
          ok: true,
          jobs,
          total: result.pagination.total,
          hasMore: result.pagination.has_more,
        })
      } catch (error) {
        sendJson(response, 200, { ok: false, error: errorMessage(error) })
      }
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/comfyui/jobs/media',
    handler: withHint(async (request, response) => {
      if (!methodIs(request, 'GET')) {
        sendJson(response, 405, { error: 'method not allowed' })
        return
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      const promptId = url.searchParams.get('promptId') ?? ''
      if (promptId === '') {
        sendJson(response, 400, { error: 'promptId is required' })
        return
      }
      try {
        const client = runtime.createClient(await runtime.getApiKey())
        const entry = await client.getHistory(promptId)
        if (entry === undefined) {
          sendJson(response, 200, { ok: true, status: 'unknown' })
          return
        }
        const statusStr = entry.status?.status_str
        if (statusStr === 'error') {
          sendJson(response, 200, { ok: true, status: 'failed', error: historyErrorMessage(promptId, entry) })
          return
        }
        if (statusStr !== 'success' && entry.status?.completed !== true) {
          sendJson(response, 200, { ok: true, status: 'running' })
          return
        }
        const config = runtime.getConfig()
        const media = collectMedia({ promptId, entry, maxItems: config.maxMediaItems, proxyBase: runtime.proxyBase() })
        sendJson(response, 200, { ok: true, status: 'completed', media })
      } catch (error) {
        sendJson(response, 200, { ok: false, error: errorMessage(error) })
      }
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/comfyui/jobs/actions',
    handler: withHint(async (request, response) => {
      if (!methodIs(request, 'POST')) {
        sendJson(response, 405, { error: 'method not allowed' })
        return
      }
      const body = await readSameOriginPost(request, response)
      if (body === undefined) return
      const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : []
      try {
        const client = runtime.createClient(await runtime.getApiKey())
        switch (body.action) {
          case 'delete':
            await client.deleteQueueItems(ids)
            break
          case 'clear':
            await client.clearQueue()
            break
          case 'interrupt':
            await client.interruptPrompt(typeof body.promptId === 'string' ? body.promptId : undefined)
            break
          case 'cancel':
            if (typeof body.jobId !== 'string') {
              sendJson(response, 400, { error: 'jobId is required for cancel' })
              return
            }
            await client.cancelJob(body.jobId)
            break
          case 'cancelBatch':
            await client.cancelJobs(ids)
            break
          case 'clearHistory':
            await client.clearHistory()
            break
          case 'deleteHistory':
            await client.deleteHistory(ids)
            break
          case 'free':
            await client.freeMemory({ unloadModels: body.unloadModels === true, freeMemory: body.freeMemory === true })
            break
          case 'rerun': {
            if (typeof body.jobId !== 'string') {
              sendJson(response, 400, { error: 'jobId is required for rerun' })
              return
            }
            const entry = await client.getHistory(body.jobId)
            const prompt = entry?.prompt
            if (prompt === undefined) {
              sendJson(response, 404, { error: 'job has no stored workflow to rerun (history may be evicted)' })
              return
            }
            await runtime.queue(prompt, { workflowName: null, source: 'rerun' })
            break
          }
          default:
            sendJson(response, 400, { error: `unknown action: ${String(body.action)}` })
            return
        }
        sendJson(response, 200, { ok: true })
      } catch (error) {
        sendJson(response, 200, { ok: false, error: errorMessage(error) })
      }
    }),
  }))

  return () => {
    for (const dispose of disposers) dispose()
  }
}
