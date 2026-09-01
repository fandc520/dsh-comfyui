/**
 * Durable plugin data: the saved-workflow library and the generated-asset
 * index, both persisted as JSON files under the plugin data directory
 * (`dataDir`, default DSH_HOME/data/dsh-comfyui). ComfyUI's own history is
 * ephemeral, so the asset index is the plugin's memory of what it generated.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { WorkflowParameter } from './params.js'

/** Trailing newline for the JSON files this store writes. */
const NEWLINE = '\n'

/** One saved workflow in the library. */
export interface StoredWorkflow {
  id: string
  name: string
  /** What the workflow does — the overview the agent reads to pick one. */
  description: string
  /** ComfyUI API-format workflow: node id → { class_type, inputs }. */
  workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }>
  /** Exposed adjustable parameters (auto-detected + user advanced). */
  parameters?: WorkflowParameter[]
  /** Classification tags (preset kinds like 图生图 plus user-defined). */
  tags?: string[]
  /** Skill-pack directory name under `<dataDir>/skills/`; absent = no pack. */
  skillDir?: string
  /** Refuse `action: run` until the agent has read this workflow's skill pack. */
  requireSkill?: boolean
  /** Where the workflow came from: 'user' (panel/tool) or 'comfyui' (imported). */
  source?: 'user' | 'comfyui'
  /** Original ComfyUI-side user-data file name when imported from the server. */
  comfyuiFile?: string
  updatedAt: string
}

/** One media file reference inside an asset record. */
export interface AssetMediaRef {
  filename: string
  subfolder: string
  type: string
  node: string
  index: number
  kind: 'image' | 'video' | 'audio' | 'other'
  url: string
}

/** One completed generation in the asset index. */
export interface AssetRecord {
  promptId: string
  ts: string
  workflowName: string | null
  source: string
  media: AssetMediaRef[]
}

/** One load-area slot: a picked file, or `null` for an empty slot. */
export type LoadSlot = CurrentImage | null

/** The load-area selection: the image the user picked for image-to-image.
 * `name` is always a file name ComfyUI can load (generated outputs are copied
 * into the input dir on selection). */
export interface CurrentImage {
  name: string
  kind: 'image' | 'video' | 'audio'
  source: 'imported' | 'generated'
}

/** Validate a workflow-shaped value; returns an error message or undefined. */
export function validateWorkflow(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'workflow must be an object mapping node id → { class_type, inputs }'
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return 'workflow must contain at least one node'
  for (const [id, node] of entries) {
    if (typeof node !== 'object' || node === null) return `node "${id}" must be an object`
    const record = node as Record<string, unknown>
    if (typeof record.class_type !== 'string' || record.class_type === '') {
      return `node "${id}" needs a non-empty class_type`
    }
    if (typeof record.inputs !== 'object' || record.inputs === null) {
      return `node "${id}" needs an inputs object`
    }
  }
  return undefined
}

function sanitizeText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    return parsed as T
  } catch {
    return fallback
  }
}

/** Persistent queue-tracker memory (survives web-server restarts). */
export interface TrackedState {
  runs: Array<{ promptId: string; ts: string; workflowName: string | null; source: string }>
  archived: string[]
}

/** JSON-file-backed store for workflows and assets. */
export class ComfyUIStore {
  private readonly workflowsPath: string
  private readonly assetsPath: string
  private readonly trackedPath: string
  private readonly mediaSizesPath: string
  private readonly mediaHashesPath: string
  private readonly currentImagePath: string
  /** Root of the per-workflow skill packs (one directory per pack). */
  readonly skillsRoot: string

  constructor(dir: string, private readonly maxAssets: number) {
    this.skillsRoot = join(dir, 'skills')
    this.workflowsPath = join(dir, 'workflows.json')
    this.assetsPath = join(dir, 'assets.json')
    this.trackedPath = join(dir, 'tracked.json')
    this.mediaSizesPath = join(dir, 'media-sizes.json')
    this.mediaHashesPath = join(dir, 'media-hashes.json')
    this.currentImagePath = join(dir, 'current-image.json')
  }

  /** Ensure the data directory exists. */
  async init(): Promise<void> {
    await mkdir(dirname(this.workflowsPath), { recursive: true })
  }

  /** Pixel sizes of files uploaded through the panel, keyed by file name —
   * used to default the workflow output size to the source image. */
  async loadMediaSizes(): Promise<Record<string, { width: number; height: number }>> {
    const parsed = await readJsonFile<Record<string, { width: number; height: number }>>(this.mediaSizesPath, {})
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
  }

  async saveMediaSize(name: string, size: { width: number; height: number }): Promise<void> {
    const sizes = await this.loadMediaSizes()
    sizes[name] = size
    await writeFile(this.mediaSizesPath, `${JSON.stringify(sizes, null, 2)}\n`, 'utf8')
  }

  /** Content-hash → file name index: re-uploading identical bytes reuses the
   * existing file instead of creating a duplicate. */
  async loadMediaHashes(): Promise<Record<string, string>> {
    const parsed = await readJsonFile<Record<string, string>>(this.mediaHashesPath, {})
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
  }

  async lookupMediaHash(hash: string): Promise<string | undefined> {
    return (await this.loadMediaHashes())[hash]
  }

  async saveMediaHash(hash: string, name: string): Promise<void> {
    const hashes = await this.loadMediaHashes()
    hashes[hash] = name
    await writeFile(this.mediaHashesPath, `${JSON.stringify(hashes, null, 2)}\n`, 'utf8')
  }

  /** The load-area slots: an ordered list where each entry is either a picked
   * file or `null` for an empty slot the user added but has not filled yet.
   * Slot 0 is the primary source (the big preview, and the default source
   * image for image-to-image).
   *
   * The file held a single `{name,kind,source}` object before the load area
   * had more than one slot; that shape is still read and lifted into a
   * one-slot list, so an existing selection survives the upgrade. */
  async loadSlots(): Promise<LoadSlot[]> {
    const parsed = await readJsonFile<{ items?: unknown } | CurrentImage>(this.currentImagePath, undefined as unknown as CurrentImage)
    if (typeof parsed !== 'object' || parsed === null) return []
    const raw = Array.isArray((parsed as { items?: unknown }).items)
      ? (parsed as { items: unknown[] }).items
      : [parsed]
    const slots: LoadSlot[] = []
    for (const entry of raw) {
      if (entry === null) {
        slots.push(null)
        continue
      }
      if (typeof entry !== 'object') continue
      const { name, kind, source } = entry as Partial<CurrentImage>
      if (typeof name !== 'string' || name === '') {
        slots.push(null)
        continue
      }
      slots.push({
        name,
        kind: kind === 'video' || kind === 'audio' ? kind : 'image',
        source: source === 'generated' ? 'generated' : 'imported',
      })
    }
    return slots
  }

  async saveSlots(slots: LoadSlot[]): Promise<void> {
    await writeFile(this.currentImagePath, JSON.stringify({ items: slots }, null, 2) + NEWLINE, 'utf8')
  }

  async listWorkflows(): Promise<StoredWorkflow[]> {
    const list = await readJsonFile<StoredWorkflow[]>(this.workflowsPath, [])
    return Array.isArray(list) ? list : []
  }

  async getWorkflow(id: string): Promise<StoredWorkflow | undefined> {
    return (await this.listWorkflows()).find((workflow) => workflow.id === id)
  }

  private async writeWorkflows(list: StoredWorkflow[]): Promise<void> {
    await writeFile(this.workflowsPath, `${JSON.stringify(list, null, 2)}\n`, 'utf8')
  }

  /** Create or update a workflow (update when `input.id` matches an existing one). */
  async saveWorkflow(input: {
    id?: string
    name: string
    description: string
    workflow: unknown
    parameters?: WorkflowParameter[]
    tags?: string[]
    source?: 'user' | 'comfyui'
    comfyuiFile?: string
  }): Promise<{ ok: true; workflow: StoredWorkflow } | { ok: false; error: string }> {
    const problem = validateWorkflow(input.workflow)
    if (problem !== undefined) return { ok: false, error: problem }
    const name = sanitizeText(input.name, 80) || 'unnamed-workflow'
    const description = sanitizeText(input.description, 2000)
    const workflow = input.workflow as StoredWorkflow['workflow']
    const parameters = Array.isArray(input.parameters) && input.parameters.length > 0 ? input.parameters : undefined
    const tags = Array.isArray(input.tags)
      ? [...new Set(input.tags.map((tag) => sanitizeText(tag, 24)).filter((tag) => tag !== ''))]
      : undefined
    const now = new Date().toISOString()
    const list = await this.listWorkflows()
    if (input.id !== undefined) {
      const index = list.findIndex((entry) => entry.id === input.id)
      if (index === -1) return { ok: false, error: `workflow "${input.id}" not found` }
      const updated: StoredWorkflow = {
        ...list[index]!, name, description, workflow,
        parameters,
        tags: tags !== undefined ? tags : list[index]!.tags,
        // Skill-pack fields are owned by the skill routes, not the workflow
        // editor: a plain save must never drop a pack the user attached.
        skillDir: list[index]!.skillDir,
        requireSkill: list[index]!.requireSkill,
        source: input.source ?? list[index]!.source,
        comfyuiFile: input.comfyuiFile ?? list[index]!.comfyuiFile,
        updatedAt: now,
      }
      list[index] = updated
      await this.writeWorkflows(list)
      return { ok: true, workflow: updated }
    }
    const created: StoredWorkflow = {
      id: randomUUID(), name, description, workflow,
      parameters,
      tags: tags !== undefined && tags.length > 0 ? tags : undefined,
      source: input.source,
      comfyuiFile: input.comfyuiFile,
      updatedAt: now,
    }
    list.push(created)
    await this.writeWorkflows(list)
    return { ok: true, workflow: created }
  }

  /** Patch the skill-pack fields of one workflow without touching its JSON or
   * parameters. `skillDir: null` detaches the pack (the directory stays on
   * disk until an explicit destroy). */
  async updateWorkflowSkill(id: string, patch: { skillDir?: string | null; requireSkill?: boolean }): Promise<StoredWorkflow | undefined> {
    const list = await this.listWorkflows()
    const index = list.findIndex((entry) => entry.id === id)
    if (index === -1) return undefined
    const current = list[index]!
    const next: StoredWorkflow = { ...current, updatedAt: new Date().toISOString() }
    if (patch.skillDir !== undefined) {
      if (patch.skillDir === null) {
        delete next.skillDir
        delete next.requireSkill
      } else {
        next.skillDir = patch.skillDir
      }
    }
    if (patch.requireSkill !== undefined) {
      if (patch.requireSkill) next.requireSkill = true
      else delete next.requireSkill
    }
    list[index] = next
    await this.writeWorkflows(list)
    return next
  }

  /** Delete a workflow by id; false when it did not exist. */
  async deleteWorkflow(id: string): Promise<boolean> {
    const list = await this.listWorkflows()
    const next = list.filter((entry) => entry.id !== id)
    if (next.length === list.length) return false
    await this.writeWorkflows(next)
    return true
  }

  async listAssets(): Promise<AssetRecord[]> {
    const list = await readJsonFile<AssetRecord[]>(this.assetsPath, [])
    return Array.isArray(list) ? list : []
  }

  /** Prepend an asset record (deduplicated by promptId, capped at maxAssets). */
  /** Drop one asset record from the index; returns the record that was
   * removed so the caller can delete the files it referenced. */
  async deleteAsset(promptId: string): Promise<AssetRecord | undefined> {
    const list = await this.listAssets()
    const index = list.findIndex((record) => record.promptId === promptId)
    if (index === -1) return undefined
    const [removed] = list.splice(index, 1)
    await writeFile(this.assetsPath, JSON.stringify(list, null, 2) + NEWLINE, 'utf8')
    return removed
  }

  async appendAsset(record: AssetRecord): Promise<void> {
    const list = await this.listAssets()
    if (list.some((entry) => entry.promptId === record.promptId)) return
    list.unshift(record)
    if (list.length > this.maxAssets) list.length = this.maxAssets
    await writeFile(this.assetsPath, `${JSON.stringify(list, null, 2)}\n`, 'utf8')
  }

  /** Load the persisted queue-tracker state (empty when absent/corrupt). */
  async loadTracked(): Promise<TrackedState> {
    const data = await readJsonFile<Partial<TrackedState>>(this.trackedPath, {})
    const runs = Array.isArray(data.runs) ? data.runs.filter((run) =>
      typeof run === 'object' && run !== null && typeof run.promptId === 'string')
      : []
    const archived = Array.isArray(data.archived) ? data.archived.filter((id): id is string => typeof id === 'string') : []
    return { runs, archived }
  }

  /** Persist the queue-tracker state so completed runs survive restarts. */
  async saveTracked(state: TrackedState): Promise<void> {
    await writeFile(this.trackedPath, `${JSON.stringify(state)}\n`, 'utf8')
  }
}
