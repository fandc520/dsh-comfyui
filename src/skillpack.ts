/**
 * Per-workflow skill packs: a small on-disk bundle (SKILL.md plus optional
 * `references/`, `scripts/`, `assets/`) that documents one runnable workflow.
 *
 * Why a directory instead of another field in workflows.json: a workflow with
 * real pitfalls needs more than one page — style collections, per-stage notes,
 * helper scripts — and the agent should pull them one at a time. The bundle is
 * the third rung of a disclosure ladder that starts in `comfyui_workflow`:
 * `action: list` shows only a one-line summary, `action: skill` returns
 * SKILL.md plus this directory's absolute path, and the model opens individual
 * reference files itself only when the body names one. Nothing here is
 * registered with the host `ctx.skills` registry: that registry publishes every
 * model-invocable skill into a durable always-on catalog, which is exactly the
 * cost this design avoids.
 *
 * The layout (four fixed buckets, one level deep) matches the bundle shape the
 * host's own filesystem skill provider recognizes, so a pack stays portable.
 *
 * Every path in this module arrives from the browser or from workflows.json and
 * is therefore untrusted: names are matched against a strict grammar, buckets
 * against a whitelist, and the resolved path is re-checked with `relative()`
 * before any read, write, or unlink — the same rule the asset deletion path
 * follows.
 */
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

/**
 * Sub-directories offered by default. These are suggestions, not a whitelist:
 * a pack may hold any directory whose name matches {@link DIR_NAME}, so a user
 * can follow whatever layout their other tooling expects. The list covers the
 * conventions this plugin's packs are most likely to meet — the host skill
 * bundle shape (`references` / `scripts` / `assets`) plus the names agent and
 * prompt tooling commonly use.
 */
export const SKILL_PRESET_DIRS = [
  'references', 'scripts', 'assets', 'templates', 'agents',
  'examples', 'prompts', 'commands', 'docs', 'data',
] as const

/** A pack sub-directory name. Any {@link DIR_NAME}-valid name is accepted. */
export type SkillBucket = string

/** The main document; it is the body `action: skill` returns and cannot be renamed or deleted. */
export const SKILL_MAIN = 'SKILL.md'

/** Text extensions accepted in the root, `references/`, and `scripts/`. */
const TEXT_EXTENSIONS = ['.md', '.txt', '.json', '.yaml', '.yml', '.mjs', '.js', '.ts', '.py', '.sh']

/** Extensions that default into `scripts/` when imported. */
const SCRIPT_EXTENSIONS = ['.mjs', '.js', '.ts', '.py', '.sh']

/** Extra extensions accepted in `assets/` — images and data the editor cannot type. */
const ASSET_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.csv']

/** One text file may not exceed this: SKILL.md is injected into the model context whole. */
export const MAX_FILE_BYTES = 256 * 1024

/** Imported binaries live in `assets/` and never enter the prompt as text, so
 * they get a larger budget than the documents the model reads verbatim. */
export const MAX_ASSET_BYTES = 4 * 1024 * 1024

/** A pack is documentation, not storage — these caps keep it that way. */
export const MAX_PACK_FILES = 100
export const MAX_PACK_BYTES = 20 * 1024 * 1024

/** File names: letters, digits, CJK, dot, dash, underscore. No separators, no leading dot. */
const FILE_NAME = /^[A-Za-z0-9_一-龥][A-Za-z0-9._一-龥-]{0,63}$/

/** Directory names this module generates and later trusts only after re-validation. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/

/** Sub-directory names inside a pack: same shape as a file name, no dots. */
const DIR_NAME = /^[A-Za-z0-9_一-龥][A-Za-z0-9_一-龥-]{0,39}$/

/** One file inside a pack. */
export interface SkillFileInfo {
  /** Path relative to the pack root, always forward-slashed (`references/styles.md`). */
  path: string
  size: number
  updatedAt: string
}

/** A pack's listing plus the catalog summary derived from SKILL.md. */
export interface SkillPackInfo {
  slug: string
  /** Absolute directory path; handed to the model as the skill's resource base. */
  dir: string
  /** Short routing line shown by `comfyui_workflow action: list`. */
  summary: string
  files: SkillFileInfo[]
  /** Sub-directories present in the pack, including empty ones. */
  dirs: string[]
  totalBytes: number
}

/** A successful operation, or a message the panel and tools show verbatim. */
export type SkillPackResult<T> = { ok: true; value: T } | { ok: false; error: string }

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

/** Content types for serving pack assets back to the panel preview. */
const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
}

/** The MIME type used when serving one pack file. */
export function contentTypeOf(path: string): string {
  return CONTENT_TYPES[extensionOf(path)] ?? 'application/octet-stream'
}

/**
 * Where an imported file belongs when the user did not pick a bucket.
 *
 * Host-side on purpose: the panel sends a file name and gets the resolved path
 * back, so the extension→bucket rule has exactly one definition.
 * @param file - the imported file's base name.
 * @returns the bucket to place it in, or undefined when the type is not accepted.
 */
export function defaultBucketFor(file: string): Exclude<SkillBucket, ''> | undefined {
  const extension = extensionOf(file)
  if (SCRIPT_EXTENSIONS.includes(extension)) return 'scripts'
  if (ASSET_EXTENSIONS.includes(extension)) return 'assets'
  if (TEXT_EXTENSIONS.includes(extension)) return 'references'
  return undefined
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot).toLowerCase()
}

/** The workflow-id half of a pack slug; the same rule finds an existing pack. */
function idSuffix(id: string): string {
  return id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase()
}

/**
 * Build a stable directory name for a workflow's pack.
 *
 * The readable half is for whoever opens the folder in an editor; the id suffix
 * makes it unique and, more importantly, keeps the directory put when the user
 * renames the workflow — a pack that moved on every rename would strand the
 * absolute path already handed to a running agent.
 * @param name - the workflow's display name.
 * @param id - the workflow id.
 * @returns a slug matching the {@link SLUG} grammar.
 */
export function skillSlug(name: string, id: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const suffix = idSuffix(id)
  const base = ascii === '' ? 'workflow' : ascii
  const slug = `${base}-${suffix === '' ? 'pack' : suffix}`
  return SLUG.test(slug) ? slug : `workflow-${suffix === '' ? 'pack' : suffix}`
}

/**
 * Split and validate a pack-relative path.
 * @param path - candidate relative path such as `references/styles.md`.
 * @returns the bucket and file name, or an error message.
 */
export function parseSkillPath(path: string): SkillPackResult<{ bucket: SkillBucket; file: string }> {
  const normalized = path.replace(/\\/g, '/').trim()
  if (normalized === '') return fail('路径为空')
  if (normalized.includes('..')) return fail('路径不合法')
  const parts = normalized.split('/').filter((part) => part !== '')
  if (parts.length === 1) {
    const file = parts[0]!
    if (!FILE_NAME.test(file)) return fail(`文件名不合法：${file}`)
    return { ok: true, value: { bucket: '', file } }
  }
  if (parts.length !== 2) return fail('技能包只有一层子目录')
  const bucket = parts[0]!
  const file = parts[1]!
  if (!DIR_NAME.test(bucket)) return fail(`子目录名不合法：${bucket}`)
  if (!FILE_NAME.test(file)) return fail(`文件名不合法：${file}`)
  // The accepted types are the same in every directory; only the size cap
  // differs (see writeBytes), because that depends on whether the model reads
  // the file as text, not on where it sits.
  const extension = extensionOf(file)
  if (![...TEXT_EXTENSIONS, ...ASSET_EXTENSIONS].includes(extension)) {
    return fail(`不支持的文件类型：${extension === '' ? '(无扩展名)' : extension}`)
  }
  return { ok: true, value: { bucket, file } }
}

/**
 * Validate one sub-directory name from the browser or a tool call.
 * @param name - candidate directory name.
 * @returns the name, or why it was refused.
 */
export function parseSkillDir(name: string): SkillPackResult<string> {
  const clean = name.replace(/[\\/]/g, '').trim()
  if (clean === '') return fail('目录名为空')
  if (!DIR_NAME.test(clean)) return fail(`目录名不合法：${name}（字母/数字/汉字/下划线/连字符，最多 40 字符）`)
  return { ok: true, value: clean }
}

/** Root-level files: SKILL.md alone. Everything else belongs in a bucket. */
function checkRootFile(file: string): SkillPackResult<true> {
  if (file !== SKILL_MAIN) return fail(`技能包根目录只允许 ${SKILL_MAIN}，其他文件请放进 references / scripts / assets`)
  return { ok: true, value: true }
}

/**
 * Strip a leading `---` frontmatter block and read its `summary` key.
 *
 * Deliberately not a YAML parser: the only key this plugin interprets is
 * `summary`, and a dependency for one line of text is not worth it. Unknown
 * keys survive untouched in the file for whoever edits it by hand.
 * @param text - the raw SKILL.md contents.
 * @returns the body without frontmatter plus the summary when present.
 */
export function splitFrontmatter(text: string): { body: string; summary: string } {
  if (!text.startsWith('---')) return { body: text, summary: '' }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { body: text, summary: '' }
  const head = text.slice(3, end)
  const rest = text.slice(end + 4).replace(/^[^\n]*\n?/, '')
  let summary = ''
  for (const line of head.split('\n')) {
    const match = /^\s*summary\s*:\s*(.*)$/.exec(line)
    if (match === null) continue
    summary = (match[1] ?? '').trim().replace(/^['"]|['"]$/g, '')
    break
  }
  return { body: rest, summary }
}

/** Compose SKILL.md text from a summary and a body, keeping the frontmatter canonical. */
export function joinFrontmatter(summary: string, body: string): string {
  const clean = summary.replace(/[\r\n]+/g, ' ').trim()
  if (clean === '') return body
  return `---\nsummary: ${clean}\n---\n\n${body.replace(/^\n+/, '')}`
}

/** First heading or first non-empty line, used when SKILL.md carries no summary. */
function fallbackSummary(body: string): string {
  for (const line of body.split('\n')) {
    const text = line.replace(/^#+\s*/, '').trim()
    if (text !== '') return text.slice(0, 60)
  }
  return ''
}

/**
 * The skill-pack directory tree under the plugin data directory.
 *
 * One instance per plugin fiber; every method takes the pack slug so a single
 * store serves the whole library.
 */
export class SkillPackStore {
  private readonly resolveRoot: () => string

  /**
   * @param root - the pack directory tree, or a getter when it follows a config
   *   value the settings page can change while the plugin runs.
   */
  constructor(root: string | (() => string)) {
    this.resolveRoot = typeof root === 'function' ? root : () => root
  }

  /** The current pack root (re-read per call: `skillsDir` is hot-configurable). */
  get root(): string {
    return this.resolveRoot()
  }

  /** Absolute path of one pack, after re-validating the slug from workflows.json. */
  private dirOf(slug: string): SkillPackResult<string> {
    if (!SLUG.test(slug)) return fail(`技能包目录名不合法：${slug}`)
    const root = this.root
    const dir = resolve(join(root, slug))
    const rel = relative(resolve(root), dir)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return fail('技能包路径越界')
    return { ok: true, value: dir }
  }

  /** Absolute path of one file inside a pack, guarded twice: grammar, then containment. */
  private fileOf(slug: string, path: string): SkillPackResult<string> {
    const dir = this.dirOf(slug)
    if (!dir.ok) return dir
    const parsed = parseSkillPath(path)
    if (!parsed.ok) return parsed
    if (parsed.value.bucket === '') {
      const rootCheck = checkRootFile(parsed.value.file)
      if (!rootCheck.ok) return rootCheck
    }
    const target = resolve(join(dir.value, parsed.value.bucket, parsed.value.file))
    const rel = relative(dir.value, target)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return fail('技能包路径越界')
    return { ok: true, value: target }
  }

  /** Create the pack directory and seed SKILL.md when it does not exist yet. */
  async create(slug: string, seed: string): Promise<SkillPackResult<SkillPackInfo>> {
    const dir = this.dirOf(slug)
    if (!dir.ok) return dir
    await mkdir(dir.value, { recursive: true })
    const main = join(dir.value, SKILL_MAIN)
    try {
      await stat(main)
    } catch {
      await writeFile(main, seed, 'utf8')
    }
    return this.info(slug)
  }

  /**
   * Find a pack directory belonging to a workflow id, whatever its readable
   * half says. Detaching a pack keeps the directory, and the workflow may have
   * been renamed since: without this, re-enabling would mint a new slug and
   * strand the user's hand-written notes in the old directory.
   * @param id - the workflow id whose suffix the directory carries.
   * @returns the matching slug, or undefined.
   */
  async findBySuffix(id: string): Promise<string | undefined> {
    const suffix = idSuffix(id)
    if (suffix === '') return undefined
    let entries: string[]
    try {
      entries = await readdir(this.root)
    } catch {
      return undefined
    }
    for (const entry of entries.sort()) {
      if (!SLUG.test(entry) || !entry.endsWith(`-${suffix}`)) continue
      const dir = this.dirOf(entry)
      if (!dir.ok) continue
      try {
        const stats = await stat(dir.value)
        if (stats.isDirectory()) return entry
      } catch {
        continue
      }
    }
    return undefined
  }

  /** Whether the pack directory exists on disk. */
  async exists(slug: string): Promise<boolean> {
    const dir = this.dirOf(slug)
    if (!dir.ok) return false
    try {
      const stats = await stat(dir.value)
      return stats.isDirectory()
    } catch {
      return false
    }
  }

  /** List a pack: SKILL.md plus one level of each bucket, with its derived summary. */
  async info(slug: string): Promise<SkillPackResult<SkillPackInfo>> {
    const dir = this.dirOf(slug)
    if (!dir.ok) return dir
    const files: SkillFileInfo[] = []
    let totalBytes = 0
    // The sub-directories are whatever is on disk: a pack may use the preset
    // names, its own, or none at all. Empty ones are still reported so the
    // panel can show a folder the user just created.
    const dirs: string[] = []
    try {
      for (const entry of (await readdir(dir.value, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() && DIR_NAME.test(entry.name)) dirs.push(entry.name)
      }
    } catch {
      // A pack whose directory vanished lists as empty rather than throwing.
    }
    for (const bucket of ['', ...dirs]) {
      const bucketDir = bucket === '' ? dir.value : join(dir.value, bucket)
      let entries: string[]
      try {
        entries = await readdir(bucketDir)
      } catch {
        continue
      }
      for (const entry of entries.sort()) {
        if (!FILE_NAME.test(entry)) continue
        const full = join(bucketDir, entry)
        let stats
        try {
          stats = await stat(full)
        } catch {
          continue
        }
        if (!stats.isFile()) continue
        if (bucket === '' && entry !== SKILL_MAIN) continue
        totalBytes += stats.size
        files.push({
          path: bucket === '' ? entry : `${bucket}/${entry}`,
          size: stats.size,
          updatedAt: new Date(stats.mtimeMs).toISOString(),
        })
      }
    }
    let summary = ''
    const main = files.find((file) => file.path === SKILL_MAIN)
    if (main !== undefined) {
      try {
        const text = await readFile(join(dir.value, SKILL_MAIN), 'utf8')
        const split = splitFrontmatter(text)
        summary = split.summary !== '' ? split.summary : fallbackSummary(split.body)
      } catch {
        summary = ''
      }
    }
    return { ok: true, value: { slug, dir: dir.value, summary, files, dirs, totalBytes } }
  }

  /** Create one sub-directory. Empty directories are legal — a user may lay a
   * pack out before filling it in. */
  async makeDir(slug: string, name: string): Promise<SkillPackResult<SkillPackInfo>> {
    const dir = this.dirOf(slug)
    if (!dir.ok) return dir
    const parsed = parseSkillDir(name)
    if (!parsed.ok) return parsed
    const target = resolve(join(dir.value, parsed.value))
    const rel = relative(dir.value, target)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return fail('技能包路径越界')
    await mkdir(target, { recursive: true })
    return this.info(slug)
  }

  /** Read one file as text. */
  async read(slug: string, path: string): Promise<SkillPackResult<string>> {
    const target = this.fileOf(slug, path)
    if (!target.ok) return target
    try {
      return { ok: true, value: await readFile(target.value, 'utf8') }
    } catch {
      return fail(`文件不存在：${path}`)
    }
  }

  /** SKILL.md body with frontmatter stripped — the text handed to the model. */
  async body(slug: string): Promise<SkillPackResult<{ body: string; summary: string; dir: string }>> {
    const dir = this.dirOf(slug)
    if (!dir.ok) return dir
    const raw = await this.read(slug, SKILL_MAIN)
    if (!raw.ok) return raw
    const split = splitFrontmatter(raw.value)
    return {
      ok: true,
      value: {
        body: split.body.trim(),
        summary: split.summary !== '' ? split.summary : fallbackSummary(split.body),
        dir: dir.value,
      },
    }
  }

  /** Create or overwrite one text file. */
  async write(slug: string, path: string, content: string): Promise<SkillPackResult<SkillPackInfo>> {
    return this.writeBytes(slug, path, Buffer.from(content, 'utf8'))
  }

  /**
   * Create or overwrite one file from raw bytes, enforcing the per-file and
   * per-pack caps. The text and import paths share this so an imported file
   * can never bypass a limit the editor honours.
   */
  async writeBytes(slug: string, path: string, bytes: Buffer): Promise<SkillPackResult<SkillPackInfo>> {
    const target = this.fileOf(slug, path)
    if (!target.ok) return target
    const parsed = parseSkillPath(path)
    if (!parsed.ok) return parsed
    // The cap follows the file type, not the directory: binaries never enter
    // the prompt as text, so they get the larger budget wherever they live.
    const limit = ASSET_EXTENSIONS.includes(extensionOf(parsed.value.file))
      ? MAX_ASSET_BYTES
      : MAX_FILE_BYTES
    if (bytes.length > limit) {
      return fail(`单个文件不能超过 ${Math.floor(limit / 1024)} KB（当前 ${Math.ceil(bytes.length / 1024)} KB）`)
    }
    const before = await this.info(slug)
    if (!before.ok) return before
    const existing = before.value.files.find((file) => file.path === path)
    if (existing === undefined && before.value.files.length >= MAX_PACK_FILES) {
      return fail(`一个技能包最多 ${MAX_PACK_FILES} 个文件`)
    }
    const projected = before.value.totalBytes - (existing?.size ?? 0) + bytes.length
    if (projected > MAX_PACK_BYTES) {
      return fail(`一个技能包最多 ${Math.floor(MAX_PACK_BYTES / 1024 / 1024)} MB`)
    }
    if (parsed.value.bucket !== '') await mkdir(join(before.value.dir, parsed.value.bucket), { recursive: true })
    await writeFile(target.value, bytes)
    return this.info(slug)
  }

  /** Read one file as raw bytes (the panel's image preview and downloads). */
  async readBytes(slug: string, path: string): Promise<SkillPackResult<Buffer>> {
    const target = this.fileOf(slug, path)
    if (!target.ok) return target
    try {
      return { ok: true, value: await readFile(target.value) }
    } catch {
      return fail(`文件不存在：${path}`)
    }
  }

  /** Rename one file; SKILL.md is fixed and both sides are validated. */
  async rename(slug: string, from: string, to: string): Promise<SkillPackResult<SkillPackInfo>> {
    if (from === SKILL_MAIN) return fail(`${SKILL_MAIN} 不能重命名`)
    const source = this.fileOf(slug, from)
    if (!source.ok) return source
    const target = this.fileOf(slug, to)
    if (!target.ok) return target
    if (to === SKILL_MAIN) return fail(`${SKILL_MAIN} 已存在，请换一个名字`)
    try {
      await stat(target.value)
      return fail(`目标已存在：${to}`)
    } catch {
      // Absent target is the expected case.
    }
    const parsed = parseSkillPath(to)
    if (!parsed.ok) return parsed
    const dir = this.dirOf(slug)
    if (!dir.ok) return dir
    if (parsed.value.bucket !== '') await mkdir(join(dir.value, parsed.value.bucket), { recursive: true })
    try {
      await rename(source.value, target.value)
    } catch {
      return fail(`重命名失败：${from}`)
    }
    return this.info(slug)
  }

  /** Delete one file; SKILL.md is fixed. */
  async remove(slug: string, path: string): Promise<SkillPackResult<SkillPackInfo>> {
    if (path === SKILL_MAIN) return fail(`${SKILL_MAIN} 不能删除，如需移除整个技能包请用"销毁技能包"`)
    const target = this.fileOf(slug, path)
    if (!target.ok) return target
    try {
      await unlink(target.value)
    } catch {
      return fail(`文件不存在：${path}`)
    }
    return this.info(slug)
  }

  /** Delete the whole pack directory. Only the explicit destroy gesture calls this. */
  async destroy(slug: string): Promise<SkillPackResult<true>> {
    const dir = this.dirOf(slug)
    if (!dir.ok) return dir
    await rm(dir.value, { recursive: true, force: true })
    return { ok: true, value: true }
  }
}

/**
 * The SKILL.md a freshly enabled pack starts from.
 *
 * The seed is a table of contents on purpose: the body is what every
 * `action: skill` call pays for, so it should point at reference files rather
 * than hold their content.
 * @param workflowName - the workflow this pack documents.
 * @param parameters - adjustable parameter names, listed as a starting point.
 * @returns SKILL.md text including frontmatter.
 */
export function seedSkillDocument(workflowName: string, parameters: string[]): string {
  const paramLines = parameters.length > 0
    ? parameters.map((name) => `- \`${name}\`：`).join('\n')
    : '- （运行 action: list 可看到完整参数清单）'
  return joinFrontmatter(`${workflowName} 的使用说明`, [
    `# ${workflowName}`,
    '',
    '## 什么时候用这个工作流',
    '',
    '（写清适用场景，Agent 靠它决定选不选这个工作流）',
    '',
    '## 关键参数',
    '',
    paramLines,
    '',
    '## 注意事项',
    '',
    '（容易翻车的环节写在这里）',
    '',
    '## 参考文档',
    '',
    '（把成体系的内容拆进 references/，在这里列出来，Agent 需要时才会去读）',
    '',
  ].join('\n'))
}

/** A pack as the panel and the tools see it: the listing plus its workflow-side flags. */
export interface WorkflowSkillPack extends SkillPackInfo {
  workflowId: string
  workflowName: string
  /** Whether `action: run` refuses until the agent has read this pack. */
  required: boolean
}

/** The pack body handed to the model by `comfyui_workflow action: skill`. */
export interface WorkflowSkillBody {
  workflowId: string
  workflowName: string
  summary: string
  body: string
  /** Absolute directory the model resolves relative paths against. */
  resourceBase: string
  /** Everything in the pack, so the model does not have to list the directory. */
  files: string[]
}

/** Minimal slice of the workflow store the pack API needs. */
interface SkillPackHost {
  /** Pack root; a getter when it follows a config value that can change. */
  readonly skillsRoot: string | (() => string)
  getWorkflow(id: string): Promise<StoredWorkflowLike | undefined>
  updateWorkflowSkill(id: string, patch: { skillDir?: string | null; requireSkill?: boolean }): Promise<StoredWorkflowLike | undefined>
}

/** Structural view of a stored workflow (avoids importing the store class). */
interface StoredWorkflowLike {
  id: string
  name: string
  skillDir?: string
  requireSkill?: boolean
  parameters?: Array<{ name: string }>
}

/** Workflow-aware skill-pack operations shared by the tools and the panel routes. */
export interface WorkflowSkillPacks {
  /** Absolute root of all packs (shown in the panel so users can open it). */
  readonly root: string
  /** One workflow's pack, or undefined when it has none. */
  info(id: string): Promise<WorkflowSkillPack | undefined>
  /** Same as {@link info}, for a workflow record the caller already holds —
   * `action: list` decorates the whole library and must not re-read
   * workflows.json once per pack. */
  infoFor(workflow: { id: string; name: string; skillDir?: string; requireSkill?: boolean }): Promise<WorkflowSkillPack | undefined>
  /** Attach a pack: create the directory, seed SKILL.md, record the slug. */
  enable(id: string): Promise<SkillPackResult<WorkflowSkillPack>>
  /** Detach the pack from the workflow; the directory stays on disk. */
  disable(id: string): Promise<SkillPackResult<true>>
  /** Detach and delete the directory. */
  destroy(id: string): Promise<SkillPackResult<true>>
  /** Toggle the run-time gate. */
  setRequired(id: string, required: boolean): Promise<SkillPackResult<WorkflowSkillPack>>
  /** Create one sub-directory inside the pack. */
  makeDir(id: string, name: string): Promise<SkillPackResult<WorkflowSkillPack>>
  readFile(id: string, path: string): Promise<SkillPackResult<string>>
  /** One file's raw bytes plus its MIME type, for the panel preview. */
  readRaw(id: string, path: string): Promise<SkillPackResult<{ bytes: Buffer; contentType: string }>>
  /** Import one uploaded file. Without an explicit bucket the extension picks
   * it (`defaultBucketFor`), and the resolved path comes back to the caller. */
  importFile(id: string, file: string, bytes: Buffer, bucket?: string): Promise<SkillPackResult<{ path: string; pack: WorkflowSkillPack }>>
  writeFile(id: string, path: string, content: string): Promise<SkillPackResult<WorkflowSkillPack>>
  renameFile(id: string, from: string, to: string): Promise<SkillPackResult<WorkflowSkillPack>>
  deleteFile(id: string, path: string): Promise<SkillPackResult<WorkflowSkillPack>>
  /** The model-facing body plus resource base. */
  load(id: string): Promise<SkillPackResult<WorkflowSkillBody>>
}

/**
 * Bind the pack directory tree to the workflow library.
 * @param host - the workflow store (its data dir owns the pack root).
 * @returns the operations the tools and routes call.
 */
export function createWorkflowSkillPacks(host: SkillPackHost): WorkflowSkillPacks {
  const packs = new SkillPackStore(host.skillsRoot)

  const resolvePack = async (id: string): Promise<SkillPackResult<{ workflow: StoredWorkflowLike; slug: string }>> => {
    const workflow = await host.getWorkflow(id)
    if (workflow === undefined) return fail(`workflow "${id}" not found`)
    const slug = workflow.skillDir
    if (slug === undefined || slug === '') return fail(`工作流 "${workflow.name}" 没有技能包`)
    return { ok: true, value: { workflow, slug } }
  }

  const decorate = async (workflow: StoredWorkflowLike, slug: string): Promise<SkillPackResult<WorkflowSkillPack>> => {
    const info = await packs.info(slug)
    if (!info.ok) return info
    return {
      ok: true,
      value: {
        ...info.value,
        workflowId: workflow.id,
        workflowName: workflow.name,
        required: workflow.requireSkill === true,
      },
    }
  }

  const afterMutation = async (id: string, operation: Promise<SkillPackResult<SkillPackInfo>>): Promise<SkillPackResult<WorkflowSkillPack>> => {
    const resolved = await resolvePack(id)
    if (!resolved.ok) return resolved
    const result = await operation
    if (!result.ok) return result
    return decorate(resolved.value.workflow, resolved.value.slug)
  }

  return {
    get root() {
      return packs.root
    },

    async info(id) {
      const resolved = await resolvePack(id)
      if (!resolved.ok) return undefined
      const decorated = await decorate(resolved.value.workflow, resolved.value.slug)
      return decorated.ok ? decorated.value : undefined
    },

    async infoFor(workflow) {
      const slug = workflow.skillDir
      if (slug === undefined || slug === '') return undefined
      const decorated = await decorate(workflow, slug)
      return decorated.ok ? decorated.value : undefined
    },

    async enable(id) {
      const workflow = await host.getWorkflow(id)
      if (workflow === undefined) return fail(`workflow "${id}" not found`)
      const slug = workflow.skillDir !== undefined && workflow.skillDir !== ''
        ? workflow.skillDir
        : (await packs.findBySuffix(workflow.id)) ?? skillSlug(workflow.name, workflow.id)
      const seed = seedSkillDocument(workflow.name, (workflow.parameters ?? []).map((parameter) => parameter.name))
      const created = await packs.create(slug, seed)
      if (!created.ok) return created
      const updated = await host.updateWorkflowSkill(id, { skillDir: slug })
      if (updated === undefined) return fail(`workflow "${id}" not found`)
      return decorate(updated, slug)
    },

    async disable(id) {
      const updated = await host.updateWorkflowSkill(id, { skillDir: null })
      if (updated === undefined) return fail(`workflow "${id}" not found`)
      return { ok: true, value: true }
    },

    async destroy(id) {
      const resolved = await resolvePack(id)
      if (!resolved.ok) return resolved
      const removed = await packs.destroy(resolved.value.slug)
      if (!removed.ok) return removed
      await host.updateWorkflowSkill(id, { skillDir: null })
      return { ok: true, value: true }
    },

    async setRequired(id, required) {
      const resolved = await resolvePack(id)
      if (!resolved.ok) return resolved
      const updated = await host.updateWorkflowSkill(id, { requireSkill: required })
      if (updated === undefined) return fail(`workflow "${id}" not found`)
      return decorate(updated, resolved.value.slug)
    },

    async makeDir(id, name) {
      const resolved = await resolvePack(id)
      if (!resolved.ok) return resolved
      return afterMutation(id, packs.makeDir(resolved.value.slug, name))
    },

    async readFile(id, path) {
      const resolved = await resolvePack(id)
      if (!resolved.ok) return resolved
      return packs.read(resolved.value.slug, path)
    },

    async readRaw(id, path) {
      const resolved = await resolvePack(id)
      if (!resolved.ok) return resolved
      const bytes = await packs.readBytes(resolved.value.slug, path)
      if (!bytes.ok) return bytes
      return { ok: true, value: { bytes: bytes.value, contentType: contentTypeOf(path) } }
    },

    async importFile(id, file, bytes, bucket) {
      const resolved = await resolvePack(id)
      if (!resolved.ok) return resolved
      const base = file.replace(/^.*[\\/]/, '').trim()
      const target = bucket !== undefined && bucket !== '' ? bucket : defaultBucketFor(base)
      if (target === undefined) return fail(`不支持导入这种文件类型：${base}`)
      const path = `${target}/${base}`
      const written = await packs.writeBytes(resolved.value.slug, path, bytes)
      if (!written.ok) return written
      const pack = await decorate(resolved.value.workflow, resolved.value.slug)
      if (!pack.ok) return pack
      return { ok: true, value: { path, pack: pack.value } }
    },

    async writeFile(id, path, content) {
      const resolved = await resolvePack(id)
      if (!resolved.ok) return resolved
      return afterMutation(id, packs.write(resolved.value.slug, path, content))
    },

    async renameFile(id, from, to) {
      const resolved = await resolvePack(id)
      if (!resolved.ok) return resolved
      return afterMutation(id, packs.rename(resolved.value.slug, from, to))
    },

    async deleteFile(id, path) {
      const resolved = await resolvePack(id)
      if (!resolved.ok) return resolved
      return afterMutation(id, packs.remove(resolved.value.slug, path))
    },

    async load(id) {
      const resolved = await resolvePack(id)
      if (!resolved.ok) return resolved
      const body = await packs.body(resolved.value.slug)
      if (!body.ok) return body
      const info = await packs.info(resolved.value.slug)
      return {
        ok: true,
        value: {
          workflowId: resolved.value.workflow.id,
          workflowName: resolved.value.workflow.name,
          summary: body.value.summary,
          body: body.value.body,
          resourceBase: body.value.dir,
          files: info.ok ? info.value.files.map((file) => file.path) : [SKILL_MAIN],
        },
      }
    },
  }
}
