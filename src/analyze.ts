/**
 * Canvas analysis for ComfyUI UI-graph workflows. A saved canvas is often a
 * test bench holding several independent flows at once: `groups` are visual
 * rectangles only, and the executable unit is a connected component over the
 * graph links (with bypassed and dangling nodes excluded). The analysis feeds
 * the extract (拆分) choices in the panel and the agent-facing skill.
 */

export interface GraphNodeLike {
  id: number
  type: string
  mode?: number
  inputs?: Array<{ link: number | null }>
  pos?: [number, number] | number[]
}

export interface GraphGroupLike {
  title?: string
  bounding: [number, number, number, number] | number[]
}

export interface GraphLike {
  nodes: GraphNodeLike[]
  links: Array<[number, number, number, number, number, string] | number[]>
  groups?: GraphGroupLike[]
}

export interface IsolatedNode {
  id: number
  type: string
}

export interface ComponentInfo {
  /** 1-based index, ordered largest first. */
  index: number
  nodeIds: number[]
  size: number
  /** Group titles that contain at least one node of the component. */
  groups: string[]
  /** Distinct node class types in the component (preview). */
  nodeTypes: string[]
}

export interface GraphAnalysis {
  ok: true
  /** Executable components, largest first. */
  components: ComponentInfo[]
  /** Dangling nodes ignored by extraction (Markdown, UI-only, unused primitives). */
  isolated: IsolatedNode[]
  /** Count of bypassed (mode 4) nodes skipped by extraction. */
  bypassedCount: number
  /** 'single' when at most one component exists; 'multi' when several. */
  mode: 'single' | 'multi'
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nodeInGroup(node: GraphNodeLike, group: GraphGroupLike): boolean {
  const [gx, gy, gw, gh] = group.bounding
  const pos = node.pos ?? [0, 0]
  const nx = pos[0] ?? 0
  const ny = pos[1] ?? 0
  return nx >= gx && ny >= gy && nx <= gx + gw && ny <= gy + gh
}

/**
 * Analyze a saved ComfyUI graph: split its active nodes into connected
 * components, associate group titles, and list the dangling nodes that
 * extraction ignores.
 * @param graph - parsed ComfyUI UI graph (v0.4 format).
 * @returns the analysis, or an error object when the graph is not readable.
 */
export function analyzeGraph(graph: unknown): GraphAnalysis | { ok: false; error: string } {
  if (!isObject(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) {
    return { ok: false, error: '无法解析图文件（缺少 nodes/links）' }
  }
  const nodes = graph.nodes as GraphNodeLike[]
  const links = graph.links as Array<number[]>
  const groups = Array.isArray(graph.groups) ? (graph.groups as GraphGroupLike[]) : []

  const active = nodes.filter((node) => node.mode !== 4)
  const activeById = new Map(active.map((node) => [node.id, node]))
  const bypassedCount = nodes.length - active.length

  // Dangling nodes: active but touching no link at all.
  const linkedIds = new Set<number>()
  for (const link of links) {
    if (typeof link[1] === 'number' && activeById.has(link[1])) linkedIds.add(link[1])
    if (typeof link[3] === 'number' && activeById.has(link[3])) linkedIds.add(link[3])
  }
  const isolated: IsolatedNode[] = active
    .filter((node) => !linkedIds.has(node.id))
    .map((node) => ({ id: node.id, type: node.type }))

  // Connected components over linked active nodes.
  const adjacency = new Map<number, Set<number>>()
  for (const node of active) adjacency.set(node.id, new Set())
  for (const link of links) {
    const a = link[1]
    const b = link[3]
    if (typeof a !== 'number' || typeof b !== 'number') continue
    if (!adjacency.has(a) || !adjacency.has(b)) continue
    adjacency.get(a)!.add(b)
    adjacency.get(b)!.add(a)
  }

  const seen = new Set<number>()
  const components: ComponentInfo[] = []
  for (const node of active) {
    if (!linkedIds.has(node.id) || seen.has(node.id)) continue
    const stack = [node.id]
    const memberIds: number[] = []
    while (stack.length > 0) {
      const current = stack.pop()!
      if (seen.has(current)) continue
      seen.add(current)
      memberIds.push(current)
      for (const next of adjacency.get(current) ?? []) {
        if (!seen.has(next)) stack.push(next)
      }
    }
    const members = memberIds.map((id) => activeById.get(id)!)
    const groupTitles = groups
      .filter((group) => members.some((member) => nodeInGroup(member, group)))
      .map((group) => group.title ?? '(未命名组)')
    const nodeTypes = [...new Set(members.map((member) => member.type).filter((type) => type !== ''))]
    components.push({ index: components.length + 1, nodeIds: memberIds, size: memberIds.length, groups: groupTitles, nodeTypes })
  }
  components.sort((a, b) => b.size - a.size)
  components.forEach((component, position) => {
    component.index = position + 1
  })

  return {
    ok: true,
    components,
    isolated,
    bypassedCount,
    mode: components.length > 1 ? 'multi' : 'single',
  }
}
