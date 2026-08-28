/**
 * Convert a ComfyUI UI-graph workflow (the format the ComfyUI frontend saves
 * to the server via /api/userdata) into the API format accepted by POST
 * /prompt. Modeled on the frontend's convertToApiFormat: input links become
 * [nodeId, slot] references, widgets_values are zipped onto input names in
 * object_info order (control_after_generate is the extra seed widget), and
 * Reroute / bypassed (mode 4) nodes are skipped with their links rewired.
 * Nodes the conversion cannot represent fail loudly with the offending type.
 */
export interface ApiWorkflow {
  [nodeId: string]: { class_type: string; inputs: Record<string, unknown> }
}

export type ConvertResult =
  | { ok: true; workflow: ApiWorkflow; warnings: string[] }
  | { ok: false; error: string }

interface GraphNode {
  id: number
  type: string
  mode?: number
  inputs?: Array<{ name: string; link: number | null; widget?: { name?: string } }>
  outputs?: Array<{ links: Array<number | null> }>
  widgets_values?: unknown
}

/** ComfyUI link row: [linkId, originId, originSlot, targetId, targetSlot, type]. */
type GraphLink = [number, number, number, number, number, string]

/** Node types that exist only in the UI and carry no data flow. */
const UI_ONLY = new Set(['Note', 'StickyNote', 'Reroute', 'Fast Groups Bypasser (rgthree)'])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWidgetSpec(typeSpec: unknown, options: Record<string, unknown> | undefined): boolean {
  return (
    typeof typeSpec === 'string' &&
    (typeSpec === 'INT' || typeSpec === 'FLOAT' || typeSpec === 'STRING' || typeSpec === 'BOOLEAN')
  ) || Array.isArray(typeSpec) || (options?.widget as { name?: unknown } | undefined)?.name !== undefined
}

/** The object_info input spec for one input name of a node class, if declared. */
function inputSpec(
  objectInfo: Record<string, unknown>,
  classType: string,
  name: string,
): unknown {
  const def = objectInfo[classType]
  const input = isObject(def) && isObject(def.input) ? def.input : undefined
  if (input === undefined) return undefined
  for (const group of ['required', 'optional'] as const) {
    const fields = isObject(input[group]) ? input[group] : {}
    if (name in fields) return fields[name]
  }
  return undefined
}

/**
 * Derive the ordered widget-input names for one node. The graph's own input
 * array is the source of truth — widgets_values is stored in UI widget order,
 * which includes dynamic sub-widgets (e.g. TextGenerate's sampling_mode.*) and
 * still holds values for linked widget inputs. object_info only supplies the
 * control_after_generate combo that follows an INT widget with that option.
 */
function widgetNamesFor(
  classType: string,
  objectInfo: Record<string, unknown>,
  node: GraphNode,
): string[] {
  const names: string[] = []
  const addUnique = (name: string): void => {
    if (!names.includes(name)) names.push(name)
  }

  for (const entry of node.inputs ?? []) {
    const name = entry.widget?.name
    if (typeof name !== 'string' || name === '') continue
    addUnique(name)
    const spec = inputSpec(objectInfo, classType, entry.name)
    const typeSpec = Array.isArray(spec) ? spec[0] : undefined
    const options = Array.isArray(spec) && isObject(spec[1]) ? spec[1] : undefined
    if (typeSpec === 'INT' && options?.control_after_generate === true) {
      addUnique('control_after_generate')
    }
  }

  // DynamicCombo V3 widgets serialize in UI order: the master combo's value
  // comes BEFORE its sub-widgets, while the graph's inputs array lists the
  // sub-widgets first. Reorder the master combo ahead of its `prefix.*`
  // sub-widgets so the zip below aligns with widgets_values.
  const dynamicCombos = (node.inputs ?? [])
    .map((entry) => entry.widget?.name)
    .filter((name): name is string => typeof name === 'string' && name !== '')
    .filter((name) => {
      const spec = inputSpec(objectInfo, classType, name)
      return Array.isArray(spec) && spec[0] === 'COMFY_DYNAMICCOMBO_V3'
    })
  if (dynamicCombos.length > 0) {
    const reordered: string[] = []
    for (const name of names) {
      const master = dynamicCombos.find((prefix) => name.startsWith(`${prefix}.`))
      if (master !== undefined) {
        if (!reordered.includes(master)) reordered.push(master)
        reordered.push(name)
        continue
      }
      if (!dynamicCombos.includes(name) || !names.some((other) => other.startsWith(`${name}.`))) {
        reordered.push(name)
      }
    }
    names.splice(0, names.length, ...reordered)
  }

  // Fallback: object_info-declared widget inputs the graph did not list.
  const def = objectInfo[classType]
  const input = isObject(def) && isObject(def.input) ? def.input : undefined
  if (input !== undefined) {
    const collect = (group: 'required' | 'optional'): void => {
      const fields = isObject(input![group]) ? input![group] : {}
      for (const [key, spec] of Object.entries(fields)) {
        if (spec === null || spec === undefined) continue
        const [typeSpec, options] = Array.isArray(spec)
          ? [spec[0], isObject(spec[1]) ? spec[1] : undefined]
          : [undefined, undefined]
        if (!isWidgetSpec(typeSpec, options)) continue
        addUnique((options?.widget as { name?: string } | undefined)?.name ?? key)
      }
    }
    collect('required')
    collect('optional')
  }
  return names
}

/** Resolve a link to its effective origin, following Reroute and bypassed nodes. */
function resolveOutput(
  linkId: number,
  links: Map<number, GraphLink>,
  nodesById: Map<number, GraphNode>,
  objectInfo: Record<string, unknown>,
  warnings: string[],
  dropReasons?: Map<string, string>,
): [string, number] | unknown | 'missing' {
  const link = links.get(linkId)
  if (link === undefined) return 'missing'
  return resolveOrigin(link[1], link[2], links, nodesById, objectInfo, warnings, dropReasons)
}

function resolveOrigin(
  nodeId: number,
  slot: number,
  links: Map<number, GraphLink>,
  nodesById: Map<number, GraphNode>,
  objectInfo: Record<string, unknown>,
  warnings: string[],
  dropReasons?: Map<string, string>,
): [string, number] | unknown | 'missing' {
  const node = nodesById.get(nodeId)
  if (node === undefined) return 'missing'

  // Reroute: the output mirrors the node's input.
  if (node.type === 'Reroute') {
    const inputLink = (node.inputs ?? []).find((entry) => entry.link !== null)?.link
    if (inputLink === undefined || inputLink === null) {
      dropReasons?.set(`${nodeId}:${slot}`, `上游节点 ${node.type}（id ${nodeId}）的直通输入没有连接`)
      return 'missing'
    }
    return resolveOutput(inputLink, links, nodesById, objectInfo, warnings, dropReasons)
  }

  // Bypassed nodes act as pass-throughs: the output follows the first wired input.
  if (node.mode === 4) {
    const inputLink = (node.inputs ?? []).find((entry) => entry.link !== null)?.link
    if (inputLink === undefined || inputLink === null) {
      dropReasons?.set(`${nodeId}:${slot}`, `上游节点 ${node.type}（id ${nodeId} 已绕过）的直通输入没有连接`)
      return 'missing'
    }
    return resolveOutput(inputLink, links, nodesById, objectInfo, warnings, dropReasons)
  }

  // Unregistered node types: a UI-only value source inlines its first widget;
  // anything else wired into the chain is a hard conversion error.
  if (objectInfo[node.type] === undefined) {
    const value = Array.isArray(node.widgets_values) ? node.widgets_values[0] : undefined
    if (value === undefined) {
      dropReasons?.set(`${nodeId}:${slot}`, `上游节点 ${node.type}（id ${nodeId}）是未注册的 UI-only 节点且没有内联值`)
      return 'missing'
    }
    return value
  }

  // Node id references must be strings: the server keys prompts by string id
  // and does a direct dict lookup (execution.py validate_inputs). Slots beyond
  // the server-side output count are graph artifacts (e.g. SaveImage saving an
  // extra UI output) — drop the reference and surface a warning.
  const outputCount = Array.isArray((objectInfo[node.type] as { output?: unknown[] } | undefined)?.output)
    ? (objectInfo[node.type] as { output?: unknown[] }).output!.length
    : undefined
  if (outputCount !== undefined && slot >= outputCount) {
    dropReasons?.set(
      `${nodeId}:${slot}`,
      `上游节点 ${node.type}（id ${nodeId}）的第 ${slot} 号输出在服务端不存在（该节点在 API 模式下只有 ${outputCount} 个输出）`,
    )
    warnings.push(`节点 ${node.type} 的第 ${slot} 号输出在服务端不存在，已断开相关连线`)
    return 'missing'
  }
  return [String(nodeId), slot]
}

/**
 * Convert a UI-graph workflow (or one extracted component of it) to API
 * format using the live node definitions.
 * @param graph - parsed ComfyUI UI graph (v0.4 format).
 * @param objectInfo - the server's `/object_info` response.
 * @param options - `includeNodeIds` restricts conversion to one connected
 *   component (extraction); link resolution still uses the full graph, which
 *   is safe because components never share links.
 */
export function convertGraphToApi(
  graph: unknown,
  objectInfo: Record<string, unknown>,
  options?: { includeNodeIds?: Set<number> },
): ConvertResult {
  if (!isObject(graph)) return { ok: false, error: '不是 ComfyUI 图格式（缺少 nodes/links）' }
  const rawNodes = graph.nodes
  const rawLinks = graph.links
  if (!Array.isArray(rawNodes)) return { ok: false, error: '缺少 nodes 数组' }
  if (!Array.isArray(rawLinks)) return { ok: false, error: '缺少 links 数组' }

  const nodes = rawNodes.filter(isObject).map((raw) => {
    const id = typeof raw.id === 'number' ? raw.id : Number(raw.id)
    const inputs = Array.isArray(raw.inputs) ? raw.inputs.filter(isObject).map((entry) => ({
      name: typeof entry.name === 'string' ? entry.name : '',
      link: typeof entry.link === 'number' ? entry.link : null,
      widget: isObject(entry.widget) ? entry.widget : undefined,
    })) : []
    const outputs = Array.isArray(raw.outputs) ? raw.outputs.filter(isObject).map((entry) => ({
      links: Array.isArray(entry.links) ? entry.links.filter((link): link is number => typeof link === 'number') : [],
    })) : []
    return {
      id,
      type: typeof raw.type === 'string' ? raw.type : '',
      mode: typeof raw.mode === 'number' ? raw.mode : 0,
      inputs,
      outputs,
      widgets_values: Array.isArray(raw.widgets_values) || isObject(raw.widgets_values)
        ? raw.widgets_values
        : undefined,
    }
  })

  const links = new Map<number, GraphLink>()
  for (const raw of rawLinks) {
    if (!Array.isArray(raw) || raw.length < 6) continue
    const link = raw as unknown as GraphLink
    if (typeof link[0] === 'number') links.set(link[0], link)
  }
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  const included = options?.includeNodeIds
  const candidates = included !== undefined ? nodes.filter((node) => included.has(node.id)) : nodes
  const hasUsedOutput = (node: GraphNode): boolean =>
    (node.outputs ?? []).some((output) => output.links.some((linkId) => {
      if (linkId === null) return false
      const link = links.get(linkId)
      return link !== undefined && nodesById.get(link[3]) !== undefined
    }))

  const workflow: ApiWorkflow = {}
  const warnings: string[] = []
  // Inputs that ARE wired in the source graph but whose connection was dropped
  // during conversion (usually because the upstream slot does not exist on the
  // server): key `${targetNodeId}.${inputName}` -> drop reasons.
  const brokenInputs = new Map<string, string[]>()
  const dropReasons = new Map<string, string>()
  for (const node of candidates) {
    if (node.type === '' || UI_ONLY.has(node.type)) continue
    if (node.mode === 4) continue
    if (node.type.startsWith('workflow')) {
      return { ok: false, error: `包含子图节点 "${node.type}"，暂不支持转换` }
    }
    if (objectInfo[node.type] === undefined) {
      if (!hasUsedOutput(node) || node.type.startsWith('Primitive')) continue
      return { ok: false, error: `包含未注册的 UI-only 节点 "${node.type}"，无法转换` }
    }

    const inputs: Record<string, unknown> = {}
    for (const entry of node.inputs ?? []) {
      if (entry.link === undefined || entry.link === null) continue
      const resolved = resolveOutput(entry.link, links, nodesById, objectInfo, warnings, dropReasons)
      if (resolved !== 'missing') {
        inputs[entry.name] = resolved
      } else {
        const link = links.get(entry.link)
        const srcKey = link !== undefined ? `${link[1]}:${link[2]}` : undefined
        const hint = srcKey !== undefined && dropReasons.has(srcKey)
          ? dropReasons.get(srcKey)!
          : '该连线无法解析（源图链接损坏或上游断线）'
        const key = `${node.id}.${entry.name}`
        const arr = brokenInputs.get(key) ?? []
        arr.push(hint)
        brokenInputs.set(key, arr)
      }
    }
    const values = node.widgets_values
    if (Array.isArray(values)) {
      let valueIndex = 0
      for (const name of widgetNamesFor(node.type, objectInfo, node)) {
        if (valueIndex >= values.length) break
        if (!(name in inputs)) inputs[name] = values[valueIndex]
        valueIndex++
      }
    } else if (isObject(values)) {
      // Some nodes (e.g. VHS_VideoCombine) serialize widgets as a keyed object
      // including internal UI state; copy the plain input values by name.
      for (const [name, value] of Object.entries(values)) {
        if (name === 'videopreview') continue
        if (isObject(value) && value.hidden === true) continue
        if (!(name in inputs)) inputs[name] = value
      }
    }

    // Collapse DynamicCombo V3 flat keys back into the API object shape:
    // { key, inputs: { subWidget: value } } — the master combo's value is the
    // selected option key, and its `master.sub` siblings become the sub-inputs.
    for (const [name, value] of Object.entries(inputs)) {
      const spec = inputSpec(objectInfo, node.type, name)
      if (!Array.isArray(spec) || spec[0] !== 'COMFY_DYNAMICCOMBO_V3') continue
      const sub: Record<string, unknown> = {}
      for (const [other, otherValue] of Object.entries(inputs)) {
        if (other.startsWith(`${name}.`)) sub[other.slice(name.length + 1)] = otherValue
      }
      inputs[name] = { key: value, inputs: sub }
      for (const subName of Object.keys(sub)) delete inputs[`${name}.${subName}`]
    }

    workflow[String(node.id)] = { class_type: node.type, inputs }
  }

  if (Object.keys(workflow).length === 0) {
    return { ok: false, error: '转换结果为空（图中没有可执行的节点）' }
  }

  // Fail loudly on nodes whose required inputs are missing — the source graph
  // itself is broken (inputs never wired), and the server would only echo a
  // confusing per-node error at run time. Growable/lazy v3 inputs (template
  // types like COMFY_AUTOGROW_V3) are skipped: their generated sub-inputs
  // (values.a, sampling_mode.temperature, ...) satisfy them.
  for (const [id, node] of Object.entries(workflow)) {
    const def = objectInfo[node.class_type]
    const required = isObject(def) && isObject(def.input) && isObject(def.input.required)
      ? Object.keys(def.input.required)
      : []
    const missing = required.filter((name) => {
      if (name in node.inputs) return false
      const spec = inputSpec(objectInfo, node.class_type, name)
      const options = Array.isArray(spec) && isObject(spec[1]) ? spec[1] : undefined
      return options?.lazy !== true && options?.template === undefined
    })
    if (missing.length > 0) {
      const parts = missing.map((name) => {
        const hints = brokenInputs.get(`${id}.${name}`)
        return hints !== undefined && hints.length > 0
          ? `${name}（源图有连线，但转换时被断开：${hints[0]}）`
          : name
      })
      const hadBroken = missing.some((name) => (brokenInputs.get(`${id}.${name}`)?.length ?? 0) > 0)
      return {
        ok: false,
        error: `节点 ${node.class_type}（id ${id}）缺少必需输入：${parts.join('、')}`
          + (hadBroken
            ? '——被断开的连接在 API 模式下无法表达，请在 ComfyUI 画布上把该输入改接到有效的输出（例如开关节点的 out0），或删除这条连线后再提取'
            : '——源工作流中这些输入没有连线'),
      }
    }
  }

  return { ok: true, workflow, warnings }
}
