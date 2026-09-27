/**
 * ComfyUI UI-graph link normalization. The frontend changed how saved graphs
 * serialize the `links` array: rows used to be positional
 * (`[id, originId, originSlot, targetId, targetSlot, type]`), while the v0.4
 * frontend writes object entries
 * (`{ id, origin_id, origin_slot, target_id, target_slot, type }`). Analysis
 * and conversion both want one canonical shape, so both go through
 * {@link normalizeLinks} before touching a graph.
 */

/** Canonical link row: [linkId, originId, originSlot, targetId, targetSlot, type]. */
export type GraphLink = [number, number, number, number, number, string]

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Normalize one link entry; undefined when the entry is not a readable link. */
export function normalizeLink(raw: unknown): GraphLink | undefined {
  if (Array.isArray(raw)) {
    if (raw.length < 6) return undefined
    const [id, origin, originSlot, target, targetSlot, type] = raw as unknown[]
    if (
      typeof id !== 'number' || typeof origin !== 'number' ||
      typeof originSlot !== 'number' || typeof target !== 'number' ||
      typeof targetSlot !== 'number'
    ) {
      return undefined
    }
    return [id, origin, originSlot, target, targetSlot, typeof type === 'string' ? type : '']
  }
  if (isObject(raw)) {
    const { id, origin_id: origin, origin_slot: originSlot, target_id: target, target_slot: targetSlot, type } = raw
    if (
      typeof id !== 'number' || typeof origin !== 'number' ||
      typeof originSlot !== 'number' || typeof target !== 'number' ||
      typeof targetSlot !== 'number'
    ) {
      return undefined
    }
    return [id, origin, originSlot, target, targetSlot, typeof type === 'string' ? type : '']
  }
  return undefined
}

/** Normalize a whole `links` array, skipping entries that are not readable. */
export function normalizeLinks(raw: unknown): GraphLink[] {
  if (!Array.isArray(raw)) return []
  const links: GraphLink[] = []
  for (const entry of raw) {
    const link = normalizeLink(entry)
    if (link !== undefined) links.push(link)
  }
  return links
}

/**
 * Frontend-only nodes whose links are rewired or dropped before analysis and
 * conversion (Issue #8). None of them exists on the server.
 *
 * - KJNodes `SetNode` / `GetNode`: "wireless" links paired by name. A GetNode's
 *   output is the value wired into the SetNode of the same name (and a
 *   SetNode's own passthrough output is its input).
 * - rgthree `Mute / Bypass Relay` / `Repeater`: their `OPT_CONNECTION` links
 *   only propagate mute/bypass mode between nodes and carry no data. The mode
 *   they set is already saved on each target node, so the links are dropped.
 */
export const SET_NODE = 'SetNode'
export const GET_NODE = 'GetNode'
const MODE_LINK_NODES = new Set(['Mute / Bypass Relay (rgthree)', 'Mute / Bypass Repeater (rgthree)'])

/** Whether a node type is one of the virtual nodes {@link resolveVirtualLinks} removes. */
export function isVirtualNodeType(type: string): boolean {
  return type === SET_NODE || type === GET_NODE || MODE_LINK_NODES.has(type)
}

interface VirtualNodeFacts {
  id: number
  type: string
  order: number
  name: string | undefined
  firstInputLink: number | undefined
}

function virtualNodeFacts(raw: unknown): VirtualNodeFacts | undefined {
  if (!isObject(raw)) return undefined
  const id = typeof raw.id === 'number' ? raw.id : Number(raw.id)
  if (!Number.isFinite(id)) return undefined
  const values = Array.isArray(raw.widgets_values) ? raw.widgets_values : []
  const name = typeof values[0] === 'string' && values[0].trim() !== '' ? values[0] : undefined
  const inputs = Array.isArray(raw.inputs) ? raw.inputs : []
  const wired = inputs.find((entry): entry is { link: number } => isObject(entry) && typeof entry.link === 'number')
  return {
    id,
    type: typeof raw.type === 'string' ? raw.type : '',
    order: typeof raw.order === 'number' ? raw.order : Number.MAX_SAFE_INTEGER,
    name,
    firstInputLink: wired?.link,
  }
}

/**
 * Rewire the virtual nodes out of a graph's links, keeping link ids stable so
 * node `inputs[].link` references stay valid.
 *
 * A GetNode resolves to the SetNode of the same name with the greatest `order`
 * below its own (the scope rule the frontend applies), falling back to any
 * SetNode of that name. A GetNode without a matching, wired SetNode (e.g. an
 * empty optional slot) resolves to nothing, so its consumer stays unconnected.
 * @param rawNodes - the graph's `nodes` array as saved.
 * @param links - normalized links.
 * @returns links with virtual-node hops replaced by their real origins, and
 *   every link touching a virtual node otherwise removed.
 */
export function resolveVirtualLinks(rawNodes: unknown, links: GraphLink[]): GraphLink[] {
  const facts = new Map<number, VirtualNodeFacts>()
  for (const raw of Array.isArray(rawNodes) ? rawNodes : []) {
    const node = virtualNodeFacts(raw)
    if (node !== undefined && isVirtualNodeType(node.type)) facts.set(node.id, node)
  }
  if (facts.size === 0) return links

  const linkById = new Map(links.map((link) => [link[0], link]))
  const setters = new Map<string, VirtualNodeFacts[]>()
  for (const node of facts.values()) {
    if (node.type !== SET_NODE || node.name === undefined) continue
    const list = setters.get(node.name) ?? []
    list.push(node)
    setters.set(node.name, list)
  }
  const setterFor = (getter: VirtualNodeFacts): VirtualNodeFacts | undefined => {
    const candidates = getter.name === undefined ? [] : setters.get(getter.name) ?? []
    const before = candidates.filter((node) => node.order < getter.order)
    const pool = before.length > 0 ? before : candidates
    return pool.reduce<VirtualNodeFacts | undefined>((best, node) => (best === undefined || node.order > best.order ? node : best), undefined)
  }

  /** The real [originId, originSlot] behind an origin, or undefined when it resolves to nothing. */
  const realOrigin = (originId: number, originSlot: number, seen: Set<number>): [number, number] | undefined => {
    const node = facts.get(originId)
    if (node === undefined) return [originId, originSlot]
    if (seen.has(originId)) return undefined
    seen.add(originId)
    if (MODE_LINK_NODES.has(node.type)) return undefined
    const source = node.type === GET_NODE ? setterFor(node) : node
    const upstream = source?.firstInputLink === undefined ? undefined : linkById.get(source.firstInputLink)
    return upstream === undefined ? undefined : realOrigin(upstream[1], upstream[2], seen)
  }

  const out: GraphLink[] = []
  for (const link of links) {
    // Links INTO a virtual node only feed the resolution above.
    if (facts.has(link[3])) continue
    const origin = realOrigin(link[1], link[2], new Set())
    if (origin === undefined) continue
    out.push(origin[0] === link[1] && origin[1] === link[2] ? link : [link[0], origin[0], origin[1], link[3], link[4], link[5]])
  }
  return out
}
