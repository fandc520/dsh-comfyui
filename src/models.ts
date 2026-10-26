/**
 * Local model library: lists every model file the local ComfyUI can actually
 * load, grouped by the `models/<type>` folder the file belongs to.
 *
 * Sources of scan roots, in order:
 *  1. the directories configured in `comfyuiDirs`, expanded for the layouts a
 *     real install uses (a ComfyUI install root, a bare `models` folder, one
 *     category folder, or the ComfyUI-Desktop tree with ComfyUI-Shared /
 *     ComfyUI-Installs);
 *  2. the running ComfyUI server's own folder list
 *     (`GET /experiment/models`), which is the only way to see models that live
 *     outside the install: SD-WebUI style `models/Lora`, a second drive, an
 *     `extra_model_paths.yaml` the user never told us about. This is requested
 *     with a short timeout and silently skipped when the server is offline;
 *  3. `extra_model_paths.yaml` / `.yml` next to a configured directory, for the
 *     offline case.
 *
 * The directory name decides the category, not the position: `models/Lora`,
 * `models/loras` and `models/Lora/loras` all end up as LoRA, and ComfyUI's own
 * `text_encoders` / SD-WebUI's `CLIP` both map to Text Encoder. Preview images
 * are ordinary sibling files (`<model>.png`, `<model>.preview.png`,
 * `previews/<model>.png`) served through a same-origin route, so the browser
 * never reads arbitrary paths.
 */
import { createReadStream, type Dirent, type Stats } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { guessContentType } from './comfyui.js'

/** Extensions ComfyUI loaders recognise as model weights. */
export const MODEL_EXTENSIONS = new Set([
  '.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf', '.onnx', '.pkl',
])

/** Files every ComfyUI models folder ships with; never models. */
const PLACEHOLDER_PATTERN = /^put_.*_here$/i

/** ComfyUI-Desktop metadata sidecar (`<name>.metadata.json`). */
const SIDECAR_SUFFIX = '.metadata.json'
const SIDECAR_MAX_BYTES = 256 * 1024
/** Archive provenance written next to a weights file (`<file>.civarchive.json`). */
const ARCHIVE_META_SUFFIX = '.civarchive.json'

/** Preview candidates tried next to a model file. */
const IMAGE_PREVIEW_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']
const VIDEO_PREVIEW_EXTENSIONS = ['.mp4', '.webm']
const PREVIEW_EXTENSIONS = new Set([...IMAGE_PREVIEW_EXTENSIONS, ...VIDEO_PREVIEW_EXTENSIONS])

/** Directories that never contain user models but can be huge. */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.cache', '.venv', 'venv', 'env', '.pytest_cache',
  '.mypy_cache', '.disabled', 'custom_nodes', 'web', 'input', 'output', 'user', 'tests',
  'site-packages',
])

const MAX_SCAN_ENTRIES = 30_000
const MAX_DEPTH = 6
const CACHE_TTL_MS = 30_000
const MAX_WARNINGS = 12
const SERVER_TIMEOUT_MS = 4_000

/** ComfyUI's shared-model configuration, tried in this order. */
const EXTRA_CONFIG_NAMES = ['extra_model_paths.yaml', 'extra_model_paths.yml']
/** Keys in an extra_model_paths block that are not model categories. */
const EXTRA_CONFIG_NON_MODEL_KEYS = new Set(['base_path', 'is_default', 'custom_nodes', 'download_model_base'])

/** Display order for the common ComfyUI model folders; unknown folders follow. */
export const MODEL_TYPE_ORDER = [
  'checkpoints', 'loras', 'diffusion_models', 'vae', 'vae_approx', 'text_encoders', 'clip',
  'clip_vision', 'controlnet', 't2i_adapter', 'style_models', 'ipadapter', 'embeddings',
  'upscale_models', 'hypernetworks', 'gligen', 'photomaker', 'model_patches', 'pulid',
  'facerestore_models', 'sams', 'ultralytics', 'detection', 'audio_encoders',
  'background_removal', 'frame_interpolation', 'geometry_estimation', 'latent_upscale_models',
  'optical_flow', 'diffusers', 'onnx', 'classifiers',
]

/**
 * Directory-name aliases. ComfyUI, ComfyUI-Desktop, SD-WebUI and A1111 all use
 * slightly different names for the same category, and users create their own
 * ones (`SDXL`, `Lora`, `upscale`); anything not listed keeps its own name.
 */
const TYPE_ALIASES: Array<[alias: string, type: string]> = [
  ['checkpoints', 'checkpoints'], ['checkpoint', 'checkpoints'], ['ckpt', 'checkpoints'],
  ['stable-diffusion', 'checkpoints'], ['stablediffusion', 'checkpoints'],
  ['loras', 'loras'], ['lora', 'loras'], ['lycoris', 'loras'], ['locon', 'loras'],
  ['diffusion_models', 'diffusion_models'], ['diffusion-models', 'diffusion_models'],
  ['diffusionmodels', 'diffusion_models'], ['unet', 'diffusion_models'], ['unets', 'diffusion_models'],
  ['vae', 'vae'], ['vaes', 'vae'],
  ['vae_approx', 'vae_approx'], ['vae-approx', 'vae_approx'], ['vaeapprox', 'vae_approx'],
  ['text_encoders', 'text_encoders'], ['text-encoders', 'text_encoders'], ['textencoders', 'text_encoders'],
  ['text_encoder', 'text_encoders'], ['clip', 'text_encoders'], ['clip_model', 'text_encoders'],
  ['t5', 'text_encoders'], ['llm', 'text_encoders'],
  ['clip_vision', 'clip_vision'], ['clip-vision', 'clip_vision'], ['clipvision', 'clip_vision'],
  ['controlnet', 'controlnet'], ['control-nets', 'controlnet'], ['control-nets-models', 'controlnet'],
  ['lllite', 'controlnet'], ['t2i_adapter', 't2i_adapter'], ['t2i-adapter', 't2i_adapter'], ['t2iadapter', 't2i_adapter'],
  ['style_models', 'style_models'], ['style-models', 'style_models'], ['stylemodels', 'style_models'],
  ['ipadapter', 'ipadapter'], ['ip-adapter', 'ipadapter'], ['ip_adapter', 'ipadapter'],
  ['embeddings', 'embeddings'], ['embedding', 'embeddings'], ['textual_inversion', 'embeddings'],
  ['upscale_models', 'upscale_models'], ['upscale-models', 'upscale_models'], ['upscalers', 'upscale_models'],
  ['esrgan', 'upscale_models'], ['real-esrgan', 'upscale_models'], ['realesrgan', 'upscale_models'],
  ['swinir', 'upscale_models'], ['gfpgan', 'upscale_models'], ['codeformer', 'upscale_models'],
  ['hypernetworks', 'hypernetworks'], ['hypernetwork', 'hypernetworks'],
  ['gligen', 'gligen'], ['photomaker', 'photomaker'],
  ['model_patches', 'model_patches'], ['model-patches', 'model_patches'], ['modelpatches', 'model_patches'],
  ['pulid', 'pulid'],
  ['facerestore_models', 'facerestore_models'], ['facerestore-models', 'facerestore_models'],
  ['facerestore', 'facerestore_models'],
  ['sams', 'sams'], ['sam', 'sams'], ['segment-anything', 'sams'],
  ['ultralytics', 'ultralytics'], ['ultralytics_bbox', 'ultralytics'], ['ultralytics_segm', 'ultralytics'],
  ['detection', 'detection'], ['adetailer', 'detection'], ['deepbooru', 'detection'], ['bbox', 'detection'],
  ['audio_encoders', 'audio_encoders'], ['audio-encoders', 'audio_encoders'],
  ['background_removal', 'background_removal'], ['background-removal', 'background_removal'],
  ['frame_interpolation', 'frame_interpolation'], ['frame-interpolation', 'frame_interpolation'],
  ['geometry_estimation', 'geometry_estimation'], ['geometry-estimation', 'geometry_estimation'],
  ['latent_upscale_models', 'latent_upscale_models'], ['latent-upscale-models', 'latent_upscale_models'],
  ['optical_flow', 'optical_flow'], ['optical-flow', 'optical_flow'],
  ['diffusers', 'diffusers'], ['onnx', 'onnx'], ['classifiers', 'classifiers'],
]

function normalizeSegment(segment: string): string {
  return segment.trim().toLowerCase().replace(/\s+/g, '-')
}

const TYPE_BY_SEGMENT = new Map<string, string>()
for (const [alias, type] of TYPE_ALIASES) {
  const key = normalizeSegment(alias)
  TYPE_BY_SEGMENT.set(key, type)
  // Underscore and dash are interchangeable in these names.
  if (key.includes('_')) TYPE_BY_SEGMENT.set(key.replace(/_/g, '-'), type)
  if (key.includes('-')) TYPE_BY_SEGMENT.set(key.replace(/-/g, '_'), type)
}

/** Canonical model type for one directory name, or undefined when unknown. */
export function canonicalModelType(segment: string): string | undefined {
  return TYPE_BY_SEGMENT.get(normalizeSegment(segment))
}

export interface ModelEntry {
  id: string
  name: string
  /** Model-relative path used by the preview route. */
  file: string
  relativePath: string
  type: string
  format: string
  size: number
  modifiedAt: string
  /** Absolute models folder this file was found under. */
  root: string
  /** Same-origin preview URL (or a remote URL from a model sidecar), absent when none. */
  preview?: string
  previewKind?: 'image' | 'video'
  /** `file` = sibling image scanned on disk, `sidecar` = URL from <name>.metadata.json. */
  previewSource?: 'file' | 'sidecar'
  /**
   * Cover is flagged NSFW by the archive it came from (`<file>.civarchive.json`);
   * the panel blurs it until the user reveals it.
   */
  previewNsfw?: boolean
}

export interface ModelGroup {
  type: string
  models: ModelEntry[]
}

export interface ModelLibrary {
  roots: string[]
  groups: ModelGroup[]
  total: number
  previewCount: number
  warnings: string[]
  scannedAt: string
  /** Where each root came from; lets the panel explain what was scanned. */
  sources: { config: number; server: number; yaml: number }
  /** True when the running ComfyUI reported its folder list. */
  serverUsed: boolean
}

export interface ScanOptions {
  /** Configured ComfyUI directories (settings page / Loader config). */
  roots: string[]
  /** ComfyUI server base URL; used to ask for its authoritative folder list. */
  baseUrl?: string
  /** Optional bearer token for the server probe. */
  apiKey?: string
  /** Server probe timeout (ms). */
  timeoutMs?: number
  /** Ignore every cache and probe the server again. */
  refresh?: boolean
}

type Origin = 'config' | 'server' | 'yaml'

interface ScanRoot {
  path: string
  /** Category pinned by configuration (extra_model_paths / server folder). */
  forcedType?: string
  origin: Origin
}

interface CacheEntry {
  at: number
  models: ModelEntry[]
  warnings: string[]
}

interface ExtraModelConfig {
  /** File the block came from (used in warnings). */
  configPath: string
  basePath?: string
  categories: Array<{ type: string; value: string }>
}

interface YamlEntry {
  indent: number
  key: string
  value: string
}

const rootCache = new Map<string, CacheEntry>()
const expandedRootsCache = new Map<string, { at: number; roots: ScanRoot[]; warnings: string[]; serverUsed: boolean }>()
/** Roots the last scan proved trustworthy; the preview route accepts these. */
const trustedRoots = new Set<string>()

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function listDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    const dirs: string[] = []
    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirs.push(join(path, entry.name))
        continue
      }
      if (!entry.isSymbolicLink()) continue
      const target = join(path, entry.name)
      if (await directoryExists(target)) dirs.push(target)
    }
    return dirs.sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/**
 * Expand one configured directory into models folders. Handles the four
 * layouts users actually have: the ComfyUI-Desktop tree (`ComfyUI-Shared` and
 * `ComfyUI-Installs/<install>/ComfyUI/models`), a ComfyUI install root, a bare
 * `models` directory, and a single category directory.
 */
async function expandConfiguredDir(input: string, add: (root: ScanRoot) => void, warnings: string[]): Promise<void> {
  const absolute = resolve(input)
  if (!(await directoryExists(absolute))) {
    warnings.push(`目录不存在：${absolute}`)
    return
  }

  let foundLayout = false
  const shared = join(absolute, 'ComfyUI-Shared', 'models')
  if (await directoryExists(shared)) {
    add({ path: shared, origin: 'config' })
    foundLayout = true
  }
  const installs = join(absolute, 'ComfyUI-Installs')
  if (await directoryExists(installs)) {
    const listed = await listDirectories(installs)
    for (const install of listed) {
      for (const candidate of [join(install, 'ComfyUI', 'models'), join(install, 'models')]) {
        if (await directoryExists(candidate)) {
          add({ path: candidate, origin: 'config' })
          foundLayout = true
        }
      }
    }
  }
  if (foundLayout) return

  const nested = join(absolute, 'models')
  if (await directoryExists(nested)) {
    add({ path: nested, origin: 'config' })
    return
  }

  const forced = canonicalModelType(basename(absolute))
  if (forced !== undefined) {
    add({ path: absolute, forcedType: forced, origin: 'config' })
    return
  }

  // A bare models folder (or a directory whose children are category folders).
  add({ path: absolute, origin: 'config' })
}

/**
 * Locate `extra_model_paths.yaml` for a configured directory. A ComfyUI root
 * keeps it at the root; a `models` directory or a single category directory
 * keeps it one/two levels above. A directory that is itself a shared models
 * folder may also contain the file.
 */
async function findExtraModelConfig(input: string): Promise<string | null> {
  const absolute = resolve(input)
  const base = normalizeSegment(basename(absolute))
  const candidates = new Set<string>([absolute])
  if (base === 'models') {
    candidates.add(dirname(absolute))
    candidates.add(dirname(dirname(absolute)))
  }
  if (canonicalModelType(base) !== undefined) candidates.add(dirname(dirname(absolute)))
  for (const dir of candidates) {
    for (const name of EXTRA_CONFIG_NAMES) {
      const candidate = join(dir, name)
      if (await fileExists(candidate)) return candidate
    }
  }
  return null
}

/** Remove a YAML comment while respecting quoted strings. */
function stripYamlComment(line: string): string {
  let quote: '"' | "'" | null = null
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!
    if (quote !== null) {
      if (char === quote) {
        if (quote === "'" && line[index + 1] === "'") {
          index += 1
          continue
        }
        quote = null
      } else if (quote === '"' && char === '\\') {
        index += 1
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1]!))) {
      return line.slice(0, index)
    }
  }
  return line
}

function unquoteYamlValue(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length < 2) return trimmed
  const quote = trimmed[0]
  if ((quote === '"' || quote === "'") && trimmed[trimmed.length - 1] === quote) {
    const inner = trimmed.slice(1, -1)
    return quote === "'" ? inner.replace(/''/g, "'") : inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return trimmed
}

/** Split `key: value` at the first colon that is not inside a quoted string. */
function splitYamlKeyValue(content: string): { key: string; value: string } | null {
  let quote: '"' | "'" | null = null
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!
    if (quote !== null) {
      if (char === quote) {
        if (quote === "'" && content[index + 1] === "'") {
          index += 1
          continue
        }
        quote = null
      } else if (quote === '"' && char === '\\') {
        index += 1
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ':') {
      const key = content.slice(0, index).trim()
      if (key === '') return null
      return { key, value: content.slice(index + 1).trim() }
    }
  }
  return null
}

/**
 * A deliberately small YAML reader for extra_model_paths files: nested
 * `key: value` pairs, quoted values, comments, and `|` block scalars (ComfyUI
 * supports newline-separated paths). It does not try to be a general parser;
 * anchors, flow maps and sequences are not part of this file's format.
 */
function parseYamlEntries(text: string): YamlEntry[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const entries: YamlEntry[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!.replace(/\t/g, '  ').trimEnd()
    const content = stripYamlComment(raw)
    if (content.trim() === '') continue
    const indent = content.length - content.trimStart().length
    const parsed = splitYamlKeyValue(content.trimStart())
    if (parsed === null) continue
    let value = parsed.value
    if (/^[|>][+-]?$/.test(value)) {
      const block: string[] = []
      let next = index + 1
      for (; next < lines.length; next += 1) {
        const blockRaw = lines[next]!.replace(/\t/g, '  ').trimEnd()
        if (blockRaw.trim() === '') {
          block.push('')
          continue
        }
        const blockIndent = blockRaw.length - blockRaw.trimStart().length
        if (blockIndent <= indent) break
        block.push(blockRaw.trim())
      }
      value = block.join('\n').trim()
      index = next - 1
    } else {
      value = unquoteYamlValue(value)
    }
    entries.push({ indent, key: parsed.key, value })
  }
  return entries
}

function parseExtraModelConfig(configPath: string, text: string): ExtraModelConfig[] {
  const configs: ExtraModelConfig[] = []
  let current: ExtraModelConfig | null = null
  for (const entry of parseYamlEntries(text)) {
    if (entry.indent === 0) {
      current = { configPath, categories: [] }
      configs.push(current)
      continue
    }
    if (current === null) continue
    const key = entry.key.toLowerCase()
    if (key === 'base_path') {
      current.basePath = entry.value
      continue
    }
    if (EXTRA_CONFIG_NON_MODEL_KEYS.has(key)) continue
    if (entry.value.trim() === '') continue
    current.categories.push({ type: key, value: entry.value })
  }
  return configs.filter((config) => config.categories.length > 0)
}

function expandEnvironment(value: string): string {
  return value
    .replace(/%([^%]+)%/g, (match: string, name: string) => process.env[name] ?? match)
    .replace(/\$\{([^}]+)\}/g, (match: string, name: string) => process.env[name] ?? match)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match: string, name: string) => process.env[name] ?? match)
}

function resolveConfigPath(value: string, base: string): string {
  const expanded = expandEnvironment(value.trim())
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded)
}

async function extraRootsFor(config: ExtraModelConfig, warnings: string[]): Promise<ScanRoot[]> {
  const rootDir = dirname(config.configPath)
  const basePath = config.basePath !== undefined && config.basePath.trim() !== ''
    ? resolveConfigPath(config.basePath, rootDir)
    : rootDir
  const roots: ScanRoot[] = []
  for (const category of config.categories) {
    for (const value of category.value.split(/\r?\n/)) {
      if (value.trim() === '') continue
      const path = resolveConfigPath(value, basePath)
      if (!(await directoryExists(path))) {
        warnings.push(`共享目录不存在：${path}（来自 ${config.configPath}）`)
        continue
      }
      roots.push({
        path,
        forcedType: canonicalModelType(category.type) ?? category.type.toLowerCase(),
        origin: 'yaml',
      })
    }
  }
  return roots
}

interface ServerModelCategory {
  name: string
  folders: string[]
}

/**
 * Ask the running ComfyUI for its own folder list. `GET /experiment/models`
 * returns `[{ name, folders }]` and is the only way to learn about model
 * folders outside the install (an SD-WebUI tree, a second drive, an
 * `extra_model_paths.yaml` we never saw). Any failure — offline, old ComfyUI
 * without the route, auth — just means "no server roots".
 */
async function fetchServerCategories(baseUrl: string, apiKey: string | undefined, timeoutMs: number): Promise<ServerModelCategory[] | null> {
  const trimmed = baseUrl.trim()
  if (trimmed === '') return null
  const url = `${trimmed.replace(/\/+$/, '')}/experiment/models`
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        ...(apiKey === undefined || apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` }),
      },
      signal: AbortSignal.timeout(Math.max(500, Math.min(timeoutMs, SERVER_TIMEOUT_MS))),
    })
    if (!response.ok) return null
    const payload = (await response.json()) as unknown
    if (!Array.isArray(payload)) return null
    const categories: ServerModelCategory[] = []
    for (const item of payload) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      if (typeof record.name !== 'string' || !Array.isArray(record.folders)) continue
      const folders = record.folders.filter((folder): folder is string => typeof folder === 'string' && folder.trim() !== '')
      if (folders.length > 0) categories.push({ name: record.name, folders })
    }
    return categories.length > 0 ? categories : null
  } catch {
    return null
  }
}

/**
 * Map one server folder (`<...>/models/<type>`, or a nested variant such as
 * `<...>/models/Stable-diffusion/diffusion_models`) back to its models root so
 * the whole tree is scanned once instead of once per category.
 */
function modelsRootOf(folder: string, category: string): ScanRoot {
  let current = resolve(folder)
  for (let guard = 0; guard < 16; guard += 1) {
    const parent = dirname(current)
    if (parent === current) break
    current = parent
    if (normalizeSegment(basename(current)) === 'models') return { path: current, origin: 'server' }
  }
  return {
    path: resolve(folder),
    forcedType: canonicalModelType(category) ?? normalizeSegment(category),
    origin: 'server',
  }
}

/** Drop roots nested inside another root: one scan of the parent covers them. */
function pruneNestedRoots(roots: ScanRoot[]): ScanRoot[] {
  const sorted = roots.slice().sort((a, b) => a.path.length - b.path.length)
  const kept: ScanRoot[] = []
  for (const root of sorted) {
    const nested = kept.some((parent) => {
      if (parent.path.toLowerCase() === root.path.toLowerCase()) return true
      const rel = relative(parent.path, root.path)
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
    })
    if (!nested) kept.push(root)
  }
  return kept
}

async function expandScanRoots(options: ScanOptions): Promise<{ roots: ScanRoot[]; warnings: string[]; serverUsed: boolean }> {
  const inputs = options.roots.map((root) => root.trim()).filter((root) => root !== '')
  const cacheKey = `${inputs.join('\0')}\0${options.baseUrl ?? ''}`
  const cached = expandedRootsCache.get(cacheKey)
  if (options.refresh !== true && cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
    return { roots: cached.roots, warnings: cached.warnings, serverUsed: cached.serverUsed }
  }

  const collected: ScanRoot[] = []
  const warnings: string[] = []
  const add = (root: ScanRoot): void => { collected.push(root) }

  for (const input of inputs) {
    await expandConfiguredDir(input, add, warnings)
    const configPath = await findExtraModelConfig(input)
    if (configPath === null) continue
    try {
      const text = await readFile(configPath, 'utf8')
      for (const config of parseExtraModelConfig(configPath, text)) {
        for (const root of await extraRootsFor(config, warnings)) add(root)
      }
    } catch (error) {
      warnings.push(`无法读取共享目录配置 ${configPath}：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Server-reported folders win over guesses: they include extra paths the
  // configuration never mentions (SD-WebUI trees, other drives).
  let serverUsed = false
  const categories = await fetchServerCategories(
    options.baseUrl ?? '',
    options.apiKey,
    options.timeoutMs ?? SERVER_TIMEOUT_MS,
  )
  if (categories !== null) {
    const before = collected.length
    for (const category of categories) {
      for (const folder of category.folders) {
        if (!(await directoryExists(folder))) continue
        collected.push(modelsRootOf(folder, category.name))
      }
    }
    serverUsed = collected.length > before
  }

  // Dedupe by path+type, then drop roots covered by a parent root.
  const seen = new Set<string>()
  const unique: ScanRoot[] = []
  for (const root of collected) {
    const key = `${root.path.toLowerCase()}\0${root.forcedType ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(root)
  }
  const roots = pruneNestedRoots(unique)

  expandedRootsCache.set(cacheKey, { at: Date.now(), roots, warnings: warnings.slice(), serverUsed })
  return { roots, warnings, serverUsed }
}

function previewUrl(root: string, file: string): string {
  return `/comfyui/models/preview?root=${encodeURIComponent(root)}&file=${encodeURIComponent(file)}`
}

/** Find a sibling preview (`name.png`, `name.preview.png`, `previews/name.png`). */
async function findPreview(modelPath: string, modelRel: string, root: string): Promise<{ url: string; kind: 'image' | 'video' } | null> {
  const dir = dirname(modelPath)
  const suffix = extname(modelPath)
  const stem = modelPath.slice(0, modelPath.length - suffix.length)
  const relStem = modelRel.slice(0, modelRel.length - extname(modelRel).length)
  const fileBase = basename(modelPath)
  const relFile = basename(modelRel)
  const candidates: Array<{ abs: string; rel: string; kind: 'image' | 'video' }> = []
  for (const ext of IMAGE_PREVIEW_EXTENSIONS) {
    candidates.push({ abs: `${stem}${ext}`, rel: `${relStem}${ext}`, kind: 'image' })
    candidates.push({ abs: `${stem}.preview${ext}`, rel: `${relStem}.preview${ext}`, kind: 'image' })
    candidates.push({ abs: `${stem}.card${ext}`, rel: `${relStem}.card${ext}`, kind: 'image' })
    candidates.push({ abs: `${modelPath}${ext}`, rel: `${modelRel}${ext}`, kind: 'image' })
    for (const name of [basename(stem), fileBase]) {
      candidates.push({ abs: join(dir, 'previews', `${name}${ext}`), rel: join(dirname(modelRel), 'previews', `${name}${ext}`), kind: 'image' })
    }
  }
  for (const ext of VIDEO_PREVIEW_EXTENSIONS) {
    candidates.push({ abs: `${stem}${ext}`, rel: `${relStem}${ext}`, kind: 'video' })
    candidates.push({ abs: `${stem}.preview${ext}`, rel: `${relStem}.preview${ext}`, kind: 'video' })
    for (const name of [basename(stem), fileBase]) {
      candidates.push({ abs: join(dir, 'previews', `${name}${ext}`), rel: join(dirname(modelRel), 'previews', `${name}${ext}`), kind: 'video' })
    }
  }
  const checked = new Set<string>()
  for (const candidate of candidates) {
    if (checked.has(candidate.abs)) continue
    checked.add(candidate.abs)
    try {
      const info = await stat(candidate.abs)
      if (info.isFile()) return { url: previewUrl(root, candidate.rel), kind: candidate.kind }
    } catch {
      // try the next candidate
    }
  }
  return null
}

/**
 * Category of one file: the deepest directory in its relative path that names
 * a known category wins, so `models/Lora/loras/x` is LoRA, not "Lora", and
 * `models/Stable-diffusion/diffusion_models/x` is Diffusion Model.
 */
function modelTypeOf(root: ScanRoot, fullPath: string): string {
  if (root.forcedType !== undefined) return root.forcedType
  const segments = dirname(relative(root.path, fullPath)).split(sep).filter((segment) => segment !== '' && segment !== '.')
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const mapped = canonicalModelType(segments[index]!)
    if (mapped !== undefined) return mapped
  }
  return segments.length > 0 ? normalizeSegment(segments[0]!) : 'other'
}

async function walkModels(
  root: ScanRoot,
  dir: string,
  depth: number,
  out: { models: ModelEntry[]; entries: number; warnings: string[]; sidecars: Map<string, string> },
  visited: Set<string>,
): Promise<void> {
  // Follow directory symlinks (common for model folders on another drive), but
  // remember the real path so a link back to an ancestor cannot loop forever.
  const realDir = await realpath(dir).catch(() => dir)
  if (visited.has(realDir)) return
  visited.add(realDir)
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    out.warnings.push(`无法读取目录 ${dir}：${(error as Error).message}`)
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (out.entries >= MAX_SCAN_ENTRIES) {
      if (!out.warnings.includes(`扫描条目超过上限 ${MAX_SCAN_ENTRIES}，已截断`)) {
        out.warnings.push(`扫描条目超过上限 ${MAX_SCAN_ENTRIES}，已截断`)
      }
      return
    }
    out.entries += 1
    const full = join(dir, entry.name)
    let isDirectory = entry.isDirectory()
    let isFile = entry.isFile()
    if (entry.isSymbolicLink()) {
      try {
        const info = await stat(full)
        isDirectory = info.isDirectory()
        isFile = info.isFile()
      } catch {
        continue
      }
    }
    if (isDirectory) {
      if (SKIP_DIRS.has(entry.name.toLowerCase())) continue
      if (depth >= MAX_DEPTH) continue
      await walkModels(root, full, depth + 1, out, visited)
      continue
    }
    if (!isFile) continue
    if (PLACEHOLDER_PATTERN.test(entry.name)) continue
    // ComfyUI-Desktop / Civitai keep a per-model metadata file next to the
    // weights; its preview_url is the only image a bare install may have.
    if (entry.name.toLowerCase().endsWith(SIDECAR_SUFFIX)) {
      const stem = entry.name.slice(0, entry.name.length - SIDECAR_SUFFIX.length)
      const key = join(dir, stem).toLowerCase()
      if (out.sidecars.size < 5_000) out.sidecars.set(key, full)
      continue
    }
    const suffix = extname(entry.name).toLowerCase()
    if (!MODEL_EXTENSIONS.has(suffix)) continue
    let info: Stats
    try {
      info = await stat(full)
    } catch {
      continue
    }
    const rel = relative(root.path, full)
    const type = modelTypeOf(root, full)
    const preview = await findPreview(full, rel, root.path)
    // The archive sidecar carries the age rating of the cover we downloaded, so a
    // mature thumbnail can start blurred instead of surprising the user.
    const previewNsfw = preview === null ? false : await archiveNsfw(full)
    out.models.push({
      id: `${root.path}|${rel}`,
      name: entry.name,
      file: rel,
      relativePath: rel,
      type,
      format: suffix.slice(1),
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      root: root.path,
      ...(preview === null ? {} : { preview: preview.url, previewKind: preview.kind, previewSource: 'file' as const }),
      ...(previewNsfw ? { previewNsfw: true } : {}),
    })
  }
}

async function scanRoot(root: ScanRoot, refresh: boolean): Promise<{ models: ModelEntry[]; warnings: string[] }> {
  // A category directory pinned by `forcedType` is a different view of the same
  // path than a generic scan, so the group type belongs in the cache key.
  const cacheKey = `${root.path}\0${root.forcedType ?? ''}`
  const cached = rootCache.get(cacheKey)
  if (!refresh && cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
    return { models: cached.models, warnings: cached.warnings }
  }
  const out = { models: [] as ModelEntry[], entries: 0, warnings: [] as string[], sidecars: new Map<string, string>() }
  await walkModels(root, root.path, 0, out, new Set<string>())
  await attachSidecarPreviews(root, out.models, out.sidecars)
  rootCache.set(cacheKey, { at: Date.now(), models: out.models, warnings: out.warnings })
  return { models: out.models, warnings: out.warnings }
}

/**
 * Attach preview images recorded by ComfyUI-Desktop in `<name>.metadata.json`.
 * Civitai downloads populate `preview_url`; a model without a local image then
 * still shows a thumbnail, and an empty value simply leaves the placeholder.
 */
async function attachSidecarPreviews(root: ScanRoot, models: ModelEntry[], sidecars: Map<string, string>): Promise<void> {
  if (sidecars.size === 0) return
  for (const model of models) {
    if (model.preview !== undefined) continue
    const absolute = resolve(root.path, model.file)
    const stem = absolute.slice(0, absolute.length - extname(absolute).length)
    const sidecar = sidecars.get(stem.toLowerCase())
    if (sidecar === undefined) continue
    try {
      const info = await stat(sidecar)
      if (info.size > SIDECAR_MAX_BYTES) continue
      const parsed = JSON.parse(await readFile(sidecar, 'utf8')) as { preview_url?: unknown }
      const url = parsed.preview_url
      if (typeof url !== 'string') continue
      if (!/^https?:\/\//i.test(url.trim())) continue
      model.preview = url.trim()
      model.previewKind = 'image'
      model.previewSource = 'sidecar'
    } catch {
      // A broken sidecar never breaks the scan.
    }
  }
}

/**
 * Whether `<file>.civarchive.json` marks the cover as mature. Written by the
 * preview downloader next to the weights, so a re-scan keeps the rating without
 * any network access; a missing or broken file simply leaves the card sharp.
 */
async function archiveNsfw(absolute: string): Promise<boolean> {
  try {
    const metaPath = absolute + ARCHIVE_META_SUFFIX
    const info = await stat(metaPath)
    if (!info.isFile() || info.size > SIDECAR_MAX_BYTES) return false
    const parsed = JSON.parse(await readFile(metaPath, 'utf8')) as { nsfw?: unknown; nsfwLevel?: unknown }
    if (parsed.nsfw === true) return true
    const level = typeof parsed.nsfwLevel === 'string' ? parsed.nsfwLevel.toLowerCase() : ''
    return /mature|explicit|adult|^x$/.test(level)
  } catch {
    return false
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function typeRank(type: string): number {
  const index = MODEL_TYPE_ORDER.indexOf(type)
  if (index !== -1) return index
  return type === 'other' ? Number.MAX_SAFE_INTEGER : MODEL_TYPE_ORDER.length
}

function pushWarning(list: string[], warning: string): void {
  if (list.includes(warning) || list.length >= MAX_WARNINGS) return
  if (list.some((existing) => existing.split('：')[0] === warning.split('：')[0]) && warning.includes('：')) return
  list.push(warning)
}

/** Scan every discoverable ComfyUI directory and group the models by type. */
export async function scanModelLibrary(options: ScanOptions): Promise<ModelLibrary> {
  const expanded = await expandScanRoots(options)
  const warnings: string[] = []
  for (const warning of expanded.warnings) pushWarning(warnings, warning)
  const byFile = new Map<string, ModelEntry>()
  const roots: string[] = []
  const sources = { config: 0, server: 0, yaml: 0 }
  for (const root of expanded.roots) {
    roots.push(root.path)
    sources[root.origin] += 1
    const result = await scanRoot(root, options.refresh === true)
    for (const model of result.models) {
      const absolute = resolve(root.path, model.file).toLowerCase()
      const existing = byFile.get(absolute)
      // A shared category is more informative than the generic folder name
      // (`ckpt` vs `checkpoints`), so keep the better-known type.
      if (existing === undefined || typeRank(model.type) < typeRank(existing.type)) {
        byFile.set(absolute, model)
      }
    }
    for (const warning of result.warnings) pushWarning(warnings, warning)
    trustedRoots.add(root.path.toLowerCase())
  }
  const models = [...byFile.values()]

  const byType = new Map<string, ModelEntry[]>()
  for (const model of models) {
    const list = byType.get(model.type) ?? []
    list.push(model)
    byType.set(model.type, list)
  }
  const order = new Map(MODEL_TYPE_ORDER.map((type, index) => [type, index]))
  const groups = [...byType.entries()]
    .map(([type, list]) => ({
      type,
      models: list.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => (order.get(a.type) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.type) ?? Number.MAX_SAFE_INTEGER) || a.type.localeCompare(b.type))

  return {
    roots: [...new Set(roots)],
    groups,
    total: models.length,
    previewCount: models.filter((model) => model.preview !== undefined).length,
    warnings,
    scannedAt: new Date().toISOString(),
    sources,
    serverUsed: expanded.serverUsed,
  }
}

/** True when the last scan (or the configuration) vouches for this folder. */
async function rootIsTrusted(options: ScanOptions, rootAbs: string): Promise<boolean> {
  const key = rootAbs.toLowerCase()
  if (trustedRoots.has(key)) return true
  const expanded = await expandScanRoots(options)
  return expanded.roots.some((root) => resolve(root.path).toLowerCase() === key)
}

/**
 * Resolve a preview request to a concrete file. Both the requested root and
 * the resolved file must stay inside a directory this plugin discovered, so the
 * query string (untrusted, same as every other browser input) cannot read
 * arbitrary paths.
 */
export async function resolveModelPreview(
  options: ScanOptions,
  requestedRoot: string,
  file: string,
): Promise<{ path: string; contentType: string; size: number } | null> {
  if (requestedRoot === '' || file === '' || isAbsolute(file)) return null
  const rootAbs = resolve(requestedRoot)
  if (!(await rootIsTrusted(options, rootAbs))) return null
  try {
    const rootReal = await realpath(rootAbs)
    const fileReal = await realpath(resolve(rootReal, file))
    if (!isInside(rootReal, fileReal)) return null
    if (!PREVIEW_EXTENSIONS.has(extname(fileReal).toLowerCase())) return null
    const info = await stat(fileReal)
    if (!info.isFile()) return null
    const contentType = guessContentType(fileReal)
    if (!contentType.startsWith('image/') && !contentType.startsWith('video/')) return null
    return { path: fileReal, contentType, size: info.size }
  } catch {
    return null
  }
}

/** Stream one preview file; images and videos are both small enough to relay. */
export async function streamModelPreview(
  target: { path: string; contentType: string; size: number },
  method: string,
  response: import('node:http').ServerResponse,
): Promise<void> {
  response.writeHead(200, {
    'content-type': target.contentType,
    'content-length': target.size,
    'cache-control': 'private, max-age=300',
    'x-content-type-options': 'nosniff',
  })
  if (method === 'HEAD') {
    response.end()
    return
  }
  await pipeline(createReadStream(target.path), response)
}
