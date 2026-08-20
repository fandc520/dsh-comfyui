/**
 * Workflow parameters: the adjustable inputs exposed on a saved API workflow
 * so the agent (and the panel runner) can pass different values per run.
 *
 * Auto-detection is deliberately conservative: only text prompts, resolution
 * (EmptyLatentImage width/height), sampler steps and seed are recognized.
 * Every other input stays as authored. Users can add custom "advanced"
 * parameters in the panel by picking any node input manually.
 */
import { randomUUID } from 'node:crypto'

/** One exposed, adjustable parameter of a saved workflow. */
export interface WorkflowParameter {
  id: string
  /** English identifier the caller passes values by, e.g. "prompt". */
  name: string
  /** Short display label (localized by the UI). */
  label: string
  type: 'string' | 'number' | 'boolean'
  /** Node id in the API workflow the value is written back to. */
  nodeId: string
  /** Input key on that node. */
  inputKey: string
  /** Value used when the caller omits it; also the "as authored" value. */
  default: string | number | boolean
  /** Note shown to the agent alongside the parameter. */
  description?: string
  /** Number parameters (seeds): randomize on every run when true. */
  random?: boolean
  /** Allowed values when the node input is a dropdown (object_info combo). */
  options?: Array<string | number>
  /** Loader-node inputs (LoadImage/LoadVideo/LoadAudio): the value is a
   * server-side filename; the panel offers upload via drag & drop.
   * 'media' is a multi-slot media list (e.g. MiniMaxH3 media_state): one
   * parameter per reference slot, merged back into the JSON array on apply. */
  upload?: 'image' | 'video' | 'audio' | 'media'
  /** Upload subdirectory (e.g. 'minimax_h3'); media files land there. */
  subfolder?: string
}

type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>
export type { Workflow }

/** Node classes whose text inputs are treated as prompts. */
const TEXT_CLASSES = new Set([
  'CLIPTextEncode',
  'CLIPTextEncodeFlux',
  'CLIPTextEncodeSDXL',
  'CLIPTextEncodeWithModel',
  'CLIPTextEncodeWithContext',
  'PrimitiveString',
  'PrimitiveStringMultiline',
  'TextGenerate',
])

/** Input keys whose string values are treated as prompt text. */
const TEXT_KEYS = new Set(['text', 'value', 'prompt'])

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/** Parse a media-state JSON array (MiniMaxH3 loader media_state); undefined when not one. */
function parseMediaState(raw: string): Array<Record<string, unknown>> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      : undefined
  } catch {
    return undefined
  }
}

/** Media kind for a filename in a loader media list. */
function mediaKindOf(name: string): 'picture' | 'video' {
  return /\.(mp4|webm|mov|mkv|avi|m4v)$/i.test(name) ? 'video' : 'picture'
}

/**
 * Whether a node input is a loader file picker (LoadImage/LoadVideo/LoadAudio
 * and friends), recognized generically from object_info: an explicit
 * image/video/audio upload flag, or a classic COMBO whose options are a file
 * list and whose key name is loader-shaped. Returns the upload kind.
 */
export function uploadKindOf(
  objectInfo: Record<string, unknown> | undefined,
  classType: string,
  inputKey: string,
): 'image' | 'video' | 'audio' | undefined {
  if (objectInfo === undefined) return undefined
  const def = objectInfo[classType] as { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } } | undefined
  const spec = def?.input?.required?.[inputKey] ?? def?.input?.optional?.[inputKey]
  if (!Array.isArray(spec)) return undefined
  const meta = spec[1]
  const flags = meta !== null && typeof meta === 'object' ? meta as Record<string, unknown> : {}
  if (flags.video_upload === true) return 'video'
  if (flags.audio_upload === true) return 'audio'
  if (flags.image_upload === true) return 'image'
  if (!Array.isArray(spec[0])) return undefined
  // Classic COMBO with a file list and a loader-shaped key name.
  if (/audio/i.test(inputKey)) return 'audio'
  if (/video/i.test(inputKey)) return 'video'
  if (/image|file|path/i.test(inputKey)) return 'image'
  return undefined
}

function displayName(workflow: Workflow, nodeId: string, inputKey: string): string {
  const node = workflow[nodeId]
  if (node === undefined) return inputKey
  if (TEXT_CLASSES.has(node.class_type)) return inputKey === 'value' ? '文本' : '提示词'
  return `${node.class_type} · ${inputKey}`
}

/** The object_info input spec for one input name of a node class, if declared. */
export function inputOptions(
  objectInfo: Record<string, unknown> | undefined,
  classType: string,
  inputKey: string,
): Array<string | number> | undefined {
  if (objectInfo === undefined) return undefined
  const def = objectInfo[classType] as { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } } | undefined
  const spec = def?.input?.required?.[inputKey] ?? def?.input?.optional?.[inputKey]
  if (!Array.isArray(spec)) return undefined
  const first = spec[0]
  if (Array.isArray(first)) {
    // Classic COMBO: the options are the spec array itself.
    const options = first.filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
    return options.length > 0 ? options : undefined
  }
  // DynamicCombo V3 (new standard): spec = ["COMFY_DYNAMICCOMBO_V3", { options: [{ key, ... }] }].
  // Other V3 variants (MATCHTYPE / AUTOGROW) carry a template, not options.
  if (first !== 'COMFY_DYNAMICCOMBO_V3') {
    // COMBO with options in its metadata (e.g. LoadVideo.file / LoadAudio.audio).
    if (first === 'COMBO') {
      const meta = spec[1]
      const list = meta !== null && typeof meta === 'object' ? (meta as { options?: unknown }).options : undefined
      if (Array.isArray(list)) {
        const values = list.filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
        if (values.length > 0) return values
      }
    }
    return undefined
  }
  const meta = spec[1]
  if (meta === null || typeof meta !== 'object') return undefined
  const options = (meta as { options?: unknown }).options
  if (!Array.isArray(options)) return undefined
  const keys = options
    .map((option) => (option !== null && typeof option === 'object' ? (option as { key?: unknown }).key : undefined))
    .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
  return keys.length > 0 ? keys : undefined
}

/** One DynamicCombo V3 option's linked child input (e.g. size presets). */
interface ComboChild {
  /** Full workflow input key, e.g. "aspect_ratio.size". */
  childInputKey: string
  /** Key inside object_info (without the parent prefix), e.g. "size". */
  internalKey: string
  defaults: Record<string, string>
}

function comboChild(
  objectInfo: Record<string, unknown> | undefined,
  classType: string,
  inputKey: string,
): ComboChild | undefined {
  if (objectInfo === undefined) return undefined
  const def = objectInfo[classType] as { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } } | undefined
  const spec = def?.input?.required?.[inputKey] ?? def?.input?.optional?.[inputKey]
  if (!Array.isArray(spec) || spec[0] !== 'COMFY_DYNAMICCOMBO_V3') return undefined
  const meta = spec[1] as { options?: Array<{ key?: string; inputs?: { required?: Record<string, unknown> } }> } | undefined
  if (meta?.options === undefined || meta.options.length === 0) return undefined
  const childInputs = meta.options[0]?.inputs?.required
  if (childInputs === undefined) return undefined
  const internalKey = Object.keys(childInputs).find((key) => {
    const childSpec = childInputs[key]
    return Array.isArray(childSpec) && childSpec[0] === 'COMBO'
  })
  if (internalKey === undefined) return undefined
  const defaults: Record<string, string> = {}
  for (const option of meta.options) {
    if (typeof option.key !== 'string') continue
    const childSpec = option.inputs?.required?.[internalKey]
    const childMeta = Array.isArray(childSpec) ? childSpec[1] : undefined
    const childDefault = childMeta !== null && typeof childMeta === 'object'
      ? (childMeta as { default?: unknown }).default
      : undefined
    if (typeof childDefault === 'string') defaults[option.key] = childDefault
  }
  return { childInputKey: `${inputKey}.${internalKey}`, internalKey, defaults }
}

/** The child COMBO options for one selected DynamicCombo parent value. */
function comboChildOptions(
  objectInfo: Record<string, unknown> | undefined,
  classType: string,
  inputKey: string,
  parentValue: string,
): Array<string | number> | undefined {
  if (objectInfo === undefined) return undefined
  const child = comboChild(objectInfo, classType, inputKey)
  if (child === undefined) return undefined
  const def = objectInfo[classType] as { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } } | undefined
  const spec = def?.input?.required?.[inputKey] ?? def?.input?.optional?.[inputKey]
  const meta = Array.isArray(spec) ? spec[1] : undefined
  const options = meta !== null && typeof meta === 'object'
    ? (meta as { options?: Array<{ key?: string; inputs?: { required?: Record<string, unknown> } }> }).options
    : undefined
  if (!Array.isArray(options)) return undefined
  const option = options.find((entry) => entry.key === parentValue)
  const childSpec = option?.inputs?.required?.[child.internalKey]
  const childMeta = Array.isArray(childSpec) ? childSpec[1] : undefined
  const childOptions = childMeta !== null && typeof childMeta === 'object'
    ? (childMeta as { options?: unknown }).options
    : undefined
  if (!Array.isArray(childOptions)) return undefined
  const values = childOptions.filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
  return values.length > 0 ? values : undefined
}

/** Full child info (key, options, default) for one selected DynamicCombo parent value. */
export function comboChildInfo(
  objectInfo: Record<string, unknown> | undefined,
  classType: string,
  inputKey: string,
  parentValue: string,
): { childInputKey: string; options: Array<string | number>; default: string } | undefined {
  if (objectInfo === undefined) return undefined
  const child = comboChild(objectInfo, classType, inputKey)
  if (child === undefined) return undefined
  const def = objectInfo[classType] as { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } } | undefined
  const spec = def?.input?.required?.[inputKey] ?? def?.input?.optional?.[inputKey]
  const meta = Array.isArray(spec) ? spec[1] : undefined
  const options = meta !== null && typeof meta === 'object'
    ? (meta as { options?: Array<{ key?: string; inputs?: { required?: Record<string, unknown> } }> }).options
    : undefined
  if (!Array.isArray(options)) return undefined
  const option = options.find((entry) => entry.key === parentValue)
  if (option === undefined) return undefined
  const childSpec = option.inputs?.required?.[child.internalKey]
  const childMeta = Array.isArray(childSpec) ? childSpec[1] : undefined
  const childMetaObj = childMeta !== null && typeof childMeta === 'object'
    ? childMeta as { options?: unknown; default?: unknown }
    : undefined
  const childOptions = Array.isArray(childMetaObj?.options)
    ? childMetaObj.options.filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
    : []
  const childDefault = typeof childMetaObj?.default === 'string' ? childMetaObj.default : ''
  return { childInputKey: child.childInputKey, options: childOptions, default: childDefault }
}

/**
 * Detect the conservative parameter set of a workflow: prompt text inputs,
 * EmptyLatentImage width/height, and KSampler steps/seed. Returns them in a
 * stable order (text, size, steps, seed) with defaults from current values.
 */
export function analyzeWorkflowParameters(workflow: Workflow, objectInfo?: Record<string, unknown>): WorkflowParameter[] {
  const params: WorkflowParameter[] = []
  const nameCounters = new Map<string, number>()
  const categoryCounters = new Map<string, number>()

  // Nodes whose output is referenced by some other node's input: their own
  // text inputs are "live" (changing them affects the graph). Isolated nodes
  // (outputs consumed by nothing) are dead inputs and skipped by prompt
  // detection, so a stray text box that nothing connects to is not exposed.
  const consumed = new Set<string>()
  for (const node of Object.values(workflow)) {
    for (const raw of Object.values(node.inputs ?? {})) {
      if (Array.isArray(raw) && typeof raw[0] === 'string') consumed.add(raw[0])
    }
  }

  // Per-category caps keep the heuristic from flooding the list when many
  // nodes share a key (e.g. several width inputs): prompts may repeat (pos +
  // neg), everything else is taken once, and only the first resolution node
  // contributes width/height.
  const take = (category: string, limit: number): boolean => {
    const count = categoryCounters.get(category) ?? 0
    if (count >= limit) return false
    categoryCounters.set(category, count + 1)
    return true
  }
  let sizeNode: string | undefined

  const uniqueName = (base: string): string => {
    const count = (nameCounters.get(base) ?? 0) + 1
    nameCounters.set(base, count)
    return count === 1 ? base : `${base}_${count}`
  }

  const add = (input: {
    name: string
    label: string
    type: 'string' | 'number' | 'boolean'
    nodeId: string
    inputKey: string
    value: string | number | boolean
    random?: boolean
    classType?: string
    options?: Array<string | number>
    upload?: 'image' | 'video' | 'audio' | 'media'
    subfolder?: string
  }): void => {
    const options = input.options ?? (input.classType !== undefined
      ? inputOptions(objectInfo, input.classType, input.inputKey)
      : undefined)
    params.push({
      id: randomUUID(),
      name: uniqueName(input.name),
      label: input.label,
      type: input.type,
      nodeId: input.nodeId,
      inputKey: input.inputKey,
      default: input.value,
      random: input.random,
      options,
      upload: input.upload,
      subfolder: input.subfolder,
    })
  }

  // Stable traversal order: by node id (numeric first, then insertion).
  const ids = Object.keys(workflow).sort((a, b) => {
    const na = Number(a)
    const nb = Number(b)
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
    return a < b ? -1 : a > b ? 1 : 0
  })

  for (const id of ids) {
    const node = workflow[id]
    if (node === undefined) continue
    const { class_type: classType, inputs } = node
    if (typeof classType !== 'string' || inputs === undefined || typeof inputs !== 'object' || inputs === null) continue

    for (const [key, raw] of Object.entries(inputs)) {
      if (!isPrimitive(raw)) continue // links are [nodeId, index] arrays
      if (TEXT_CLASSES.has(classType) && TEXT_KEYS.has(key)) {
        if (consumed.has(id) && take('prompt', 2)) add({ name: 'prompt', label: displayName(workflow, id, key), type: 'string', nodeId: id, inputKey: key, value: raw, classType })
        continue
      }
      if (classType === 'EmptyLatentImage' && (key === 'width' || key === 'height') && typeof raw === 'number') {
        if (sizeNode !== undefined && sizeNode !== id) continue
        sizeNode = id
        add({ name: key, label: key === 'width' ? '宽度' : '高度', type: 'number', nodeId: id, inputKey: key, value: raw, classType })
        continue
      }
      if (classType === 'KSampler' && key === 'steps' && typeof raw === 'number') {
        if (take('steps', 1)) add({ name: 'steps', label: '采样步数', type: 'number', nodeId: id, inputKey: key, value: raw, classType })
        continue
      }
      if (classType === 'KSampler' && key === 'seed' && typeof raw === 'number') {
        if (take('seed', 1)) add({ name: 'seed', label: '随机种子', type: 'number', nodeId: id, inputKey: key, value: raw, random: true, classType })
        continue
      }
      // Key-name heuristics for custom node classes (MiniMax etc.): prompt
      // text, sampler steps, seeds, latent size, video duration, aspect presets.
      if (typeof raw === 'string') {
        const uploadKind = uploadKindOf(objectInfo, classType, key)
        if (uploadKind !== undefined && /^(image|video|audio|file|audio_file|video_file|path|sound)$/i.test(key)) {
          const label = uploadKind === 'video' ? '视频' : uploadKind === 'audio' ? '音频' : '图片'
          add({ name: key, label, type: 'string', nodeId: id, inputKey: key, value: raw, classType, upload: uploadKind })
          continue
        }
        if (key === 'prompt' || key === 'text' || key === 'value') {
          if (consumed.has(id) && take('prompt', 2)) add({ name: 'prompt', label: displayName(workflow, id, key), type: 'string', nodeId: id, inputKey: key, value: raw, classType })
          continue
        }
        if (key === 'aspect_ratio') {
          if (take('aspect_ratio', 1)) add({ name: 'aspect_ratio', label: '宽高比', type: 'string', nodeId: id, inputKey: key, value: raw, classType })
          continue
        }
        // DynamicCombo child (e.g. "aspect_ratio.size"): size presets of the
        // currently selected parent value.
        if (key.endsWith('.size') && typeof inputs[`${key.slice(0, -'.size'.length)}`] === 'string') {
          const parentKey = key.slice(0, -'.size'.length)
          const parentValue = inputs[parentKey] as string
          const sizeOptions = comboChildOptions(objectInfo, classType, parentKey, parentValue)
          if (take('size', 1)) add({ name: 'size', label: '尺寸', type: 'string', nodeId: id, inputKey: key, value: raw, classType, options: sizeOptions })
          continue
        }
      }
      if (typeof raw === 'number') {
        if (key === 'steps') {
          if (take('steps', 1)) add({ name: 'steps', label: '采样步数', type: 'number', nodeId: id, inputKey: key, value: raw, classType })
          continue
        }
        if (/seed/i.test(key)) {
          if (take('seed', 1)) add({ name: 'seed', label: '随机种子', type: 'number', nodeId: id, inputKey: key, value: raw, random: true, classType })
          continue
        }
        if (key === 'width' || key === 'height') {
          if (sizeNode !== undefined && sizeNode !== id) continue
          sizeNode = id
          add({ name: key, label: key === 'width' ? '宽度' : '高度', type: 'number', nodeId: id, inputKey: key, value: raw, classType })
          continue
        }
        if (key === 'duration' || key === 'length' || key === 'frames') {
          if (take('duration', 1)) add({ name: 'duration', label: '时长', type: 'number', nodeId: id, inputKey: key, value: raw, classType })
        }
      }
    }
  }
  return params
}

/**
 * Apply caller-provided values (and randomized seeds) onto a copy of the
 * workflow. Unknown parameters are ignored; omitted ones fall back to the
 * parameter default. The input workflow is not mutated.
 */
export function applyWorkflowParameters(
  workflow: Workflow,
  parameters: WorkflowParameter[],
  values: Record<string, unknown>,
  objectInfo?: Record<string, unknown>,
  imageSizes?: Record<string, { width: number; height: number }>,
  defaultImage?: string,
): Workflow {
  const copy: Workflow = structuredClone(workflow)
  let effectiveValues = values
  // The load-area selection is the default source image: when an image upload
  // parameter is left unset, use it instead of the workflow's stored default.
  if (defaultImage !== undefined && typeof defaultImage === 'string' && defaultImage !== '') {
    const imageParam = parameters.find((param) => param.upload === 'image')
    if (imageParam !== undefined && !Object.prototype.hasOwnProperty.call(effectiveValues, imageParam.name)) {
      effectiveValues = { ...effectiveValues, [imageParam.name]: defaultImage }
    }
  }
  // Auto-match the output size to the source image: when the effective source
  // image (explicit or load-area default) has a recorded pixel size but
  // width/height were left untouched, default them to that size. Explicit
  // width/height values always win.
  if (imageSizes !== undefined) {
    const imageParam = parameters.find((param) =>
      param.upload === 'image' &&
      Object.prototype.hasOwnProperty.call(effectiveValues, param.name) &&
      typeof effectiveValues[param.name] === 'string' &&
      imageSizes[String(effectiveValues[param.name])] !== undefined,
    )
    if (imageParam !== undefined) {
      const size = imageSizes[String(effectiveValues[imageParam.name])]!
      const widthParam = parameters.find((param) => param.name === 'width' && param.type === 'number')
      const heightParam = parameters.find((param) => param.name === 'height' && param.type === 'number')
      const next: Record<string, unknown> = { ...effectiveValues }
      if (widthParam !== undefined && !Object.prototype.hasOwnProperty.call(effectiveValues, widthParam.name)) {
        next[widthParam.name] = size.width
      }
      if (heightParam !== undefined && !Object.prototype.hasOwnProperty.call(effectiveValues, heightParam.name)) {
        next[heightParam.name] = size.height
      }
      effectiveValues = next
    }
  }
  // DynamicCombo parents: the linked child (e.g. "aspect_ratio.size") must
  // always match the parent value. An explicit parent override re-syncs the
  // child to that option's default; a parent left at its default repairs a
  // stale child (e.g. saved before linking existed) but never fights an
  // explicit child value. Linking runs as a second pass.
  const combos = new Map<string, { nodeId: string; inputKey: string; child: ComboChild }>()
  for (const param of parameters) {
    const node = copy[param.nodeId]
    if (node === undefined) continue
    const child = comboChild(objectInfo, node.class_type, param.inputKey)
    if (child !== undefined) combos.set(param.name, { nodeId: param.nodeId, inputKey: param.inputKey, child })
  }
  // Child keys of DynamicCombo parents: their valid options depend on the
  // selected parent value, so static option validation would reject valid
  // combinations (ComfyUI validates the actual pair at queue time).
  const comboChildKeys = new Set([...combos.values()].map(({ nodeId, child }) => `${nodeId}:${child.childInputKey}`))
  for (const param of parameters) {
    const node = copy[param.nodeId]
    if (node === undefined) continue
    let value: unknown
    if (Object.prototype.hasOwnProperty.call(effectiveValues, param.name)) {
      value = effectiveValues[param.name]
    } else if (param.random === true && param.type === 'number') {
      value = Math.floor(Math.random() * 2 ** 32)
    } else {
      value = param.default
    }
    const isComboChild = comboChildKeys.has(`${param.nodeId}:${param.inputKey}`)
    // Upload parameters accept any server-side filename (uploaded files, or
    // ComfyUI's "[output]"-annotated paths); options are only a reference list.
    if (param.options !== undefined && param.options.length > 0 && !isComboChild && param.upload === undefined && !param.options.includes(value as string | number)) {
      throw new Error(`parameter "${param.name}" value ${JSON.stringify(value)} is not one of the allowed options: ${param.options.join(', ')}`)
    }
    if (param.type === 'string' && typeof value !== 'string') continue
    if (param.type === 'number' && typeof value !== 'number') continue
    if (param.type === 'boolean' && typeof value !== 'boolean') continue
    if (param.upload === 'media') continue // merged back into the JSON array below
    node.inputs[param.inputKey] = value
  }
  for (const [paramName, combo] of combos) {
    // An explicit child value (parameter or raw key) wins over linking.
    const childParam = parameters.find((param) => param.nodeId === combo.nodeId && param.inputKey === combo.child.childInputKey)
    const childExplicit = childParam !== undefined
      ? Object.prototype.hasOwnProperty.call(effectiveValues, childParam.name)
      : Object.prototype.hasOwnProperty.call(effectiveValues, combo.child.childInputKey)
    if (childExplicit) continue
    const parentExplicit = Object.prototype.hasOwnProperty.call(effectiveValues, paramName)
    const parentValue = parentExplicit
      ? effectiveValues[paramName]
      : parameters.find((param) => param.name === paramName)?.default
    if (typeof parentValue !== 'string') continue
    const childValue = combo.child.defaults[parentValue]
    if (childValue === undefined) continue
    const node = copy[combo.nodeId]
    if (node === undefined) continue
    const currentChild = node.inputs[combo.child.childInputKey]
    if (parentExplicit) {
      node.inputs[combo.child.childInputKey] = childValue
      continue
    }
    // Parent at default: only repair a child that is not a valid option of
    // that parent value (stale saved state); keep a matching current value.
    if (typeof currentChild === 'string') {
      const valid = comboChildOptions(objectInfo, node.class_type, combo.inputKey, parentValue)
      if (valid !== undefined && valid.includes(currentChild as string | number)) continue
    }
    node.inputs[combo.child.childInputKey] = childValue
  }
  // Loader media lists (MiniMaxH3 media_state etc.): each "media" parameter
  // maps to one reference slot of the JSON array. Filled slots keep their
  // position and inherit existing metadata; empty slots drop that item.
  const mediaParams = parameters.filter((param) => param.upload === 'media')
  if (mediaParams.length > 0) {
    const groups = new Map<string, WorkflowParameter[]>()
    for (const param of mediaParams) {
      const groupKey = `${param.nodeId}:${param.inputKey}`
      const group = groups.get(groupKey)
      if (group === undefined) groups.set(groupKey, [param])
      else group.push(param)
    }
    for (const [groupKey, group] of groups) {
      const first = group[0]
      if (first === undefined) continue
      const node = copy[first.nodeId]
      if (node === undefined) continue
      const current = node.inputs[first.inputKey]
      const items = typeof current === 'string' ? parseMediaState(current) : undefined
      if (items === undefined) continue
      const drop = new Set<number>()
      group.forEach((param, i) => {
        let value: unknown
        if (Object.prototype.hasOwnProperty.call(effectiveValues, param.name)) value = effectiveValues[param.name]
        else value = param.default
        if (typeof value !== 'string') return
        if (value === '') {
          drop.add(i)
          return
        }
        const existing = items[i] ?? {}
        items[i] = {
          ...existing,
          kind: mediaKindOf(value),
          file: param.subfolder !== undefined && param.subfolder !== '' ? `${param.subfolder}/${value} [input]` : value,
          name: value,
          duration: existing.duration ?? null,
          width: existing.width ?? null,
          height: existing.height ?? null,
        }
      })
      node.inputs[first.inputKey] = JSON.stringify(items.filter((_, i) => !drop.has(i)))
    }
  }
  return copy
}
