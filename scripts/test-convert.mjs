/**
 * Offline self-test for canvas analysis and graph → API conversion (needs
 * `npm run build` first; imports lib/analyze.js and lib/convert.js).
 *
 * Covers the regressions fixed from GitHub issues: DynamicCombo V3 stays flat
 * (#10), bypass pass-through keeps a chain in one component and extraction
 * rejects references outside its node set (#8), and the virtual nodes —
 * KJNodes SetNode/GetNode wireless links and rgthree Mute/Bypass
 * Relay/Repeater mode links — are rewired out (#8).
 *
 *   node scripts/test-convert.mjs
 */
import assert from 'node:assert/strict'
import { analyzeGraph } from '../lib/analyze.js'
import { convertGraphToApi, flattenDynamicCombos } from '../lib/convert.js'

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log(`PASS: ${name}`)
}

const objectInfo = {
  Src: { input: { required: {} }, output: ['VIDEO'] },
  Mid: { input: { required: { video: ['VIDEO'] } }, output: ['VIDEO'] },
  Sink: { input: { required: { video: ['VIDEO'] } }, output: [] },
  SaveVideo: {
    input: {
      required: {
        video: ['VIDEO'],
        filename_prefix: ['STRING', {}],
        format: [['auto', 'mp4'], {}],
        codec: ['COMFY_DYNAMICCOMBO_V3', {
          options: [
            { key: 'auto', inputs: { required: {} } },
            { key: 'h264', inputs: { required: { crf: ['INT', {}] } } },
          ],
        }],
      },
    },
    output: [],
  },
}

/** A node with one wired input and one output (links listed by id). */
const node = (id, type, { inputLink = null, outLinks = [], mode = 0, order = id, widgets } = {}) => ({
  id, type, mode, order,
  inputs: inputLink === undefined ? [] : [{ name: 'video', type: 'VIDEO', link: inputLink }],
  outputs: [{ name: 'VIDEO', type: 'VIDEO', links: outLinks }],
  ...(widgets !== undefined ? { widgets_values: widgets } : {}),
})
const link = (id, from, to, fromSlot = 0, toSlot = 0) => [id, from, fromSlot, to, toSlot, 'VIDEO']

// ---------------------------------------------------------------- #10 / #8 bypass

const saveGraph = {
  nodes: [
    { id: 1, type: 'Src', mode: 0, inputs: [], outputs: [{ links: [10] }], widgets_values: [] },
    { id: 2, type: 'Mid', mode: 4, inputs: [{ name: 'video', link: 10 }], outputs: [{ links: [11] }] },
    {
      id: 3, type: 'SaveVideo', mode: 0,
      inputs: [
        { name: 'video', link: 11 },
        { name: 'filename_prefix', widget: { name: 'filename_prefix' }, link: null },
        { name: 'format', widget: { name: 'format' }, link: null },
        { name: 'codec', widget: { name: 'codec' }, link: null },
      ],
      outputs: [],
      widgets_values: ['video/x', 'auto', 'auto'],
    },
  ],
  links: [link(10, 1, 2), link(11, 2, 3)],
}

check('bypassed node keeps its chain in one component', () => {
  const analysis = analyzeGraph(saveGraph)
  assert.equal(analysis.components.length, 1)
  assert.deepEqual([...analysis.components[0].nodeIds].sort(), [1, 3])
})

check('DynamicCombo V3 stays flat and bypass passes through', () => {
  const result = convertGraphToApi(saveGraph, objectInfo, { includeNodeIds: new Set([1, 3]) })
  assert.ok(result.ok, result.error)
  assert.equal(result.workflow['3'].inputs.codec, 'auto')
  assert.deepEqual(result.workflow['3'].inputs.video, ['1', 0])
})

check('a DynamicCombo value outside its options is rejected at extraction', () => {
  const bad = structuredClone(saveGraph)
  bad.nodes[2].widgets_values = ['video/x', 'auto', 'nope']
  assert.equal(convertGraphToApi(bad, objectInfo).ok, false)
})

check('a reference outside the extracted node set is rejected', () => {
  assert.equal(convertGraphToApi(saveGraph, objectInfo, { includeNodeIds: new Set([3]) }).ok, false)
})

check('legacy { key, inputs } DynamicCombo values are flattened at queue time', () => {
  const flat = flattenDynamicCombos({ 3: { class_type: 'SaveVideo', inputs: { codec: { key: 'h264', inputs: { crf: 20 } }, format: 'auto' } } })
  assert.deepEqual(flat['3'].inputs, { codec: 'h264', 'codec.crf': 20, format: 'auto' })
  const untouched = { 1: { class_type: 'X', inputs: { a: 1 } } }
  assert.equal(flattenDynamicCombos(untouched), untouched)
})

// ---------------------------------------------------------------- #8 Set/Get

// Src(1) → SetNode "clip"(2)   …   GetNode "clip"(3) → Sink(4)
const setGetGraph = {
  nodes: [
    node(1, 'Src', { inputLink: undefined, outLinks: [20] }),
    node(2, 'SetNode', { inputLink: 20, outLinks: [], widgets: ['clip'] }),
    node(3, 'GetNode', { inputLink: undefined, outLinks: [21], widgets: ['clip'] }),
    node(4, 'Sink', { inputLink: 21, outLinks: [] }),
  ],
  links: [link(20, 1, 2), link(21, 3, 4)],
}

check('Set/Get: the pair joins one component without showing up in it', () => {
  const analysis = analyzeGraph(setGetGraph)
  assert.equal(analysis.components.length, 1)
  assert.deepEqual([...analysis.components[0].nodeIds].sort(), [1, 4])
  assert.equal(analysis.isolated.length, 0)
})

check('Set/Get: the consumer is wired straight to the setter\'s source', () => {
  const result = convertGraphToApi(setGetGraph, objectInfo)
  assert.ok(result.ok, result.error)
  assert.deepEqual(Object.keys(result.workflow).sort(), ['1', '4'])
  assert.deepEqual(result.workflow['4'].inputs.video, ['1', 0])
})

check('Set/Get: a same-name setter resolves by the latest order before the getter', () => {
  // Two setters named "v": Src(1) at order 1, Src(5) at order 6; the getter
  // at order 7 takes the later one, a getter at order 3 the earlier one.
  const graph = {
    nodes: [
      node(1, 'Src', { inputLink: undefined, outLinks: [30], order: 1 }),
      node(2, 'SetNode', { inputLink: 30, widgets: ['v'], order: 2 }),
      node(5, 'Src', { inputLink: undefined, outLinks: [31], order: 5 }),
      node(6, 'SetNode', { inputLink: 31, widgets: ['v'], order: 6 }),
      node(7, 'GetNode', { inputLink: undefined, outLinks: [32], widgets: ['v'], order: 7 }),
      node(8, 'Sink', { inputLink: 32, order: 8 }),
      node(3, 'GetNode', { inputLink: undefined, outLinks: [33], widgets: ['v'], order: 3 }),
      node(4, 'Sink', { inputLink: 33, order: 4 }),
    ],
    links: [link(30, 1, 2), link(31, 5, 6), link(32, 7, 8), link(33, 3, 4)],
  }
  const result = convertGraphToApi(graph, objectInfo)
  assert.ok(result.ok, result.error)
  assert.deepEqual(result.workflow['8'].inputs.video, ['5', 0])
  assert.deepEqual(result.workflow['4'].inputs.video, ['1', 0])
})

check('Set/Get: a setter fed by another getter chains through', () => {
  // Src(1) → Set "a"(2); Get "a"(3) → Set "b"(4); Get "b"(5) → Sink(6)
  const graph = {
    nodes: [
      node(1, 'Src', { inputLink: undefined, outLinks: [40] }),
      node(2, 'SetNode', { inputLink: 40, widgets: ['a'] }),
      node(3, 'GetNode', { inputLink: undefined, outLinks: [41], widgets: ['a'] }),
      node(4, 'SetNode', { inputLink: 41, widgets: ['b'] }),
      node(5, 'GetNode', { inputLink: undefined, outLinks: [42], widgets: ['b'] }),
      node(6, 'Sink', { inputLink: 42 }),
    ],
    links: [link(40, 1, 2), link(41, 3, 4), link(42, 5, 6)],
  }
  const result = convertGraphToApi(graph, objectInfo)
  assert.ok(result.ok, result.error)
  assert.deepEqual(result.workflow['6'].inputs.video, ['1', 0])
})

check('Set/Get: a setter\'s passthrough output resolves to its input', () => {
  const graph = {
    nodes: [
      node(1, 'Src', { inputLink: undefined, outLinks: [50] }),
      node(2, 'SetNode', { inputLink: 50, outLinks: [51], widgets: ['x'] }),
      node(3, 'Sink', { inputLink: 51 }),
    ],
    links: [link(50, 1, 2), link(51, 2, 3)],
  }
  const result = convertGraphToApi(graph, objectInfo)
  assert.ok(result.ok, result.error)
  assert.deepEqual(result.workflow['3'].inputs.video, ['1', 0])
})

check('Set/Get: a getter without a setter leaves its consumer unconnected', () => {
  const graph = {
    nodes: [
      node(3, 'GetNode', { inputLink: undefined, outLinks: [60], widgets: ['missing'] }),
      node(4, 'Mid', { inputLink: 60 }),
    ],
    links: [link(60, 3, 4)],
  }
  const result = convertGraphToApi(graph, objectInfo)
  // Mid's required `video` is now unwired, which conversion reports.
  assert.equal(result.ok, false)
  assert.match(result.error, /video/)
})

// ---------------------------------------------------------------- #8 rgthree relays

check('rgthree Relay/Repeater: mode links are dropped, data flow is kept', () => {
  // Src(1) → Sink(2) is the data flow; Sink(2) → Repeater(3) → Relay(4) → Sink(5)
  // are mode-propagation links that must neither merge nor break anything.
  const graph = {
    nodes: [
      node(1, 'Src', { inputLink: undefined, outLinks: [70] }),
      { ...node(2, 'Sink', { inputLink: 70 }), outputs: [{ name: 'OPT_CONNECTION', links: [71] }] },
      { id: 3, type: 'Mute / Bypass Repeater (rgthree)', mode: 0, inputs: [{ name: '', link: 71 }], outputs: [{ name: 'OPT_CONNECTION', links: [72] }] },
      { id: 4, type: 'Mute / Bypass Relay (rgthree)', mode: 0, inputs: [{ name: '', link: 72 }], outputs: [{ name: 'OPT_CONNECTION', links: [73] }] },
      node(6, 'Src', { inputLink: undefined, outLinks: [74] }),
      { ...node(5, 'Sink', { inputLink: 74 }), inputs: [{ name: 'video', link: 74 }, { name: 'mode', link: 73 }] },
    ],
    links: [link(70, 1, 2), link(71, 2, 3), link(72, 3, 4), link(73, 4, 5, 0, 1), link(74, 6, 5)],
  }
  const analysis = analyzeGraph(graph)
  assert.equal(analysis.components.length, 2, 'the relay must not merge the two flows')
  assert.equal(analysis.isolated.length, 0)
  const result = convertGraphToApi(graph, objectInfo)
  assert.ok(result.ok, result.error)
  assert.deepEqual(Object.keys(result.workflow).sort(), ['1', '2', '5', '6'])
  assert.deepEqual(result.workflow['5'].inputs, { video: ['6', 0] })
})

console.log(`\nALL CONVERT TESTS PASSED (${passed})`)
