/**
 * Local model library: scans the ComfyUI installation directories the user
 * configured (`comfyuiDirs`) and groups model files by the models/<type>
 * directory they live in. Each install can also share models through
 * `extra_model_paths.yaml`; those paths are merged in with the category name
 * as the group type, so a shared `D:\models\ckpt` folder still shows up as
 * Checkpoint. This is deliberately filesystem-only: the panel must list models
 * even when no ComfyUI server is running (and on this machine none is
 * installed). Preview images are ordinary sibling files, served through a
 * same-origin route so the browser never reads arbitrary paths.
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

/** Preview candidates tried next to a model file. */
const IMAGE_PREVIEW_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif']
const VIDEO_PREVIEW_EXTENSIONS = ['.mp4', '.webm']
const PREVIEW_EXTENSIONS = new Set([...IMAGE_PREVIEW_EXTENSIONS, ...VIDEO_PREVIEW_EXTENSIONS])

/** Directories that never contain user models but can be huge. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.cache', '.venv', 'venv', 'env'])

const MAX_SCAN_ENTRIES = 20_000
const MAX_DEPTH = 8
const CACHE_TTL_MS = 15_000

/** ComfyUI's shared-model configuration, tried in this order. */
const EXTRA_CONFIG_NAMES = ['extra_model_paths.yaml', 'extra_model_paths.yml']
/** Keys in an extra_model_paths block that are not model categories. */
const EXTRA_CONFIG_NON_MODEL_KEYS = new Set(['base_path', 'is_default', 'custom_nodes', 'download_model_base'])

/** Display order for the common ComfyUI model folders; unknown folders follow. */
export const MODEL_TYPE_ORDER = [
  'checkpoints', 'loras', 'lora', 'vae', 'clip', 'text_encoders', 'clip_vision',
  'controlnet', 't2i_adapter', 'unet', 'diffusion_models', 'embeddings',
  'upscale_models', 'hypernetworks', 'gligen', 'photomaker', 'style_models',
  'model_patches', 'pulid', 'facerestore_models', 'sams', 'ultralytics',
]

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
  /** Same-origin preview URL, or absent when no sibling preview exists. */
  preview?: string
  previewKind?: 'image' | 'video'
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
}

interface ScanRoot {
  path: string
  forcedType?: string
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
const expandedRootsCache = new Map<string, { at: number; roots: ScanRoot[]; warnings: string[] }>()

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Resolve one configured entry to the directory that actually contains model
 * category folders. Accepts a ComfyUI install root (`<root>/models`), a
 * `models` directory, or a single category directory such as
 * `models/checkpoints` (the latter pins the group type).
 */
async function describeScanRoot(input: string): Promise<ScanRoot | null> {
  const absolute = resolve(input)
  if (!(await directoryExists(absolute))) return null
  const nested = join(absolute, 'models')
  if (await directoryExists(nested)) return { path: nested }
  const base = basename(absolute).toLowerCase()
  if (MODEL_TYPE_ORDER.includes(base)) return { path: absolute, forcedType: base }
  return { path: absolute }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Locate `extra_model_paths.yaml` for a configured directory. A ComfyUI root
 * keeps it at the root; a `models` directory or a single category directory
 * keeps it one/two levels above. A directory that is itself a shared models
 * folder may also contain the file.
 */
async function findExtraModelConfig(input: string): Promise<string | null> {
  const absolute = resolve(input)
  const base = basename(absolute).toLowerCase()
  const candidates = new Set<string>([absolute])
  if (base === 'models') candidates.add(dirname(absolute))
  if (MODEL_TYPE_ORDER.includes(base)) candidates.add(dirname(dirname(absolute)))
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
      roots.push({ path, forcedType: category.type })
    }
  }
  return roots
}

/**
 * Expand configured ComfyUI directories into concrete scan roots. Shared
 * model paths come first so that, when the same file is also inside the
 * install's own models folder, the category from extra_model_paths wins.
 */
async function expandConfiguredRoots(configRoots: string[], refresh: boolean): Promise<{ roots: ScanRoot[]; warnings: string[] }> {
  const inputs = configRoots.map((root) => root.trim()).filter((root) => root !== '')
  const cacheKey = inputs.join('\0')
  const cached = expandedRootsCache.get(cacheKey)
  if (!refresh && cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
    return { roots: cached.roots, warnings: cached.warnings }
  }

  const roots: ScanRoot[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  const add = (root: ScanRoot): void => {
    const key = `${root.path}\0${root.forcedType ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    roots.push(root)
  }

  for (const input of inputs) {
    const described = await describeScanRoot(input)
    if (described === null) {
      warnings.push(`目录不存在：${resolve(input)}`)
      continue
    }
    const configPath = await findExtraModelConfig(input)
    if (configPath !== null) {
      try {
        const text = await readFile(configPath, 'utf8')
        for (const config of parseExtraModelConfig(configPath, text)) {
          for (const root of await extraRootsFor(config, warnings)) add(root)
        }
      } catch (error) {
        warnings.push(`无法读取共享目录配置 ${configPath}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    add(described)
  }

  expandedRootsCache.set(cacheKey, { at: Date.now(), roots, warnings: warnings.slice() })
  return { roots, warnings }
}

function modelTypeOf(root: ScanRoot, fullPath: string): string {
  if (root.forcedType !== undefined) return root.forcedType
  const rel = relative(root.path, fullPath)
  const parts = rel.split(sep)
  return parts.length > 1 ? parts[0]!.toLowerCase() : 'other'
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
  const candidates: Array<{ abs: string; rel: string; kind: 'image' | 'video' }> = []
  for (const ext of IMAGE_PREVIEW_EXTENSIONS) {
    candidates.push({ abs: `${stem}${ext}`, rel: `${relStem}${ext}`, kind: 'image' })
    candidates.push({ abs: `${stem}.preview${ext}`, rel: `${relStem}.preview${ext}`, kind: 'image' })
    candidates.push({ abs: `${modelPath}${ext}`, rel: `${modelRel}${ext}`, kind: 'image' })
    candidates.push({ abs: join(dir, 'previews', `${basename(stem)}${ext}`), rel: join(dirname(modelRel), 'previews', `${basename(relStem)}${ext}`), kind: 'image' })
  }
  for (const ext of VIDEO_PREVIEW_EXTENSIONS) {
    candidates.push({ abs: `${stem}${ext}`, rel: `${relStem}${ext}`, kind: 'video' })
    candidates.push({ abs: `${stem}.preview${ext}`, rel: `${relStem}.preview${ext}`, kind: 'video' })
  }
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate.abs)
      if (info.isFile()) return { url: previewUrl(root, candidate.rel), kind: candidate.kind }
    } catch {
      // try the next candidate
    }
  }
  return null
}

async function walkModels(root: ScanRoot, dir: string, depth: number, out: { models: ModelEntry[]; entries: number; warnings: string[] }, visited: Set<string>): Promise<void> {
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
      if (depth >= MAX_DEPTH) {
        out.warnings.push(`目录层级超过上限，已跳过 ${full}`)
        continue
      }
      await walkModels(root, full, depth + 1, out, visited)
      continue
    }
    if (!isFile) continue
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
    out.models.push({
      id: `${root.path}|${rel}`,
      name: entry.name,
      file: rel,
      relativePath: rel,
      type,
      format: suffix.slice(1),
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      ...(preview === null ? {} : { preview: preview.url, previewKind: preview.kind }),
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
  const out = { models: [] as ModelEntry[], entries: 0, warnings: [] as string[] }
  await walkModels(root, root.path, 0, out, new Set<string>())
  rootCache.set(cacheKey, { at: Date.now(), models: out.models, warnings: out.warnings })
  return { models: out.models, warnings: out.warnings }
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

/** Scan every configured ComfyUI directory and group the models by type. */
export async function scanModelLibrary(roots: string[], refresh = false): Promise<ModelLibrary> {
  const expanded = await expandConfiguredRoots(roots, refresh)
  const warnings = expanded.warnings.slice()
  const byFile = new Map<string, ModelEntry>()
  for (const root of expanded.roots) {
    const result = await scanRoot(root, refresh)
    for (const model of result.models) {
      const absolute = resolve(root.path, model.file)
      const existing = byFile.get(absolute)
      // A shared category is more informative than the generic folder name
      // (`ckpt` vs `checkpoints`), so keep the better-known type.
      if (existing === undefined || typeRank(model.type) < typeRank(existing.type)) {
        byFile.set(absolute, model)
      }
    }
    for (const warning of result.warnings) {
      if (!warnings.includes(warning)) warnings.push(warning)
    }
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
    roots: [...new Set(expanded.roots.map((root) => root.path))],
    groups,
    total: models.length,
    previewCount: models.filter((model) => model.preview !== undefined).length,
    warnings,
    scannedAt: new Date().toISOString(),
  }
}

/**
 * Resolve a preview request to a concrete file. Both the requested root and
 * the resolved file must stay inside a directory the user configured — the
 * query string is untrusted, same as every other browser input.
 */
export async function resolveModelPreview(
  configRoots: string[],
  requestedRoot: string,
  file: string,
): Promise<{ path: string; contentType: string; size: number } | null> {
  if (requestedRoot === '' || file === '' || isAbsolute(file)) return null
  const rootAbs = resolve(requestedRoot)
  // Shared model folders are allowed too, but only when the current
  // extra_model_paths configuration actually expanded to this directory.
  const expanded = await expandConfiguredRoots(configRoots, false)
  if (!expanded.roots.some((root) => resolve(root.path) === rootAbs)) return null
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
