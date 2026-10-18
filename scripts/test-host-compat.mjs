/**
 * Offline host-compatibility test: install gate, load seam and the jobs
 * contract, across every dsh line `engines.dsh` admits (0.1.2 … 0.2.x).
 *
 * Drives the plugin's public entry `apply(ctx, entryConfig)` from the built
 * bundle (../lib/index.js) against a stub host context that models ONLY the
 * host boundary the plugin duck-types: tools registry, settings, skills,
 * webServer, jobs, event bus, credentials. No plugin internals are mocked;
 * ComfyUI itself is a stubbed `fetch`. Also asserts the manifest's
 * `engines.dsh` (read by dsh 0.2.1+) and `@deepseek-ai/dsh-settings` peer range
 * (read by older hosts) the way the host gates them (semver with
 * { includePrerelease: true }).
 *
 * Deterministic and offline. The progress tracker still best-effort dials the
 * (refused) ComfyUI WebSocket and keeps a 3s retry timer alive, so this script
 * always process.exit()s explicitly. Needs `npm run build` first.
 *
 * Adapted from the seam test contributed in PR #18.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// The cordis.patch.yml insert entry: `name` is the module specifier the loader
// imports (see section 4). Parsed leniently — a YAML dependency is not allowed.
const patchName = /(?:^|\n)[ \t]*-?[ \t]*name:[ \t]*['"]?([^'"\n]+?)['"]?[ \t]*$/m.exec(
  readFileSync(join(repoRoot, 'cordis.patch.yml'), 'utf8'),
)?.[1]?.trim()

// ---------------------------------------------------------------------------
// Minimal semver comparator. Covers ONLY caret segments (`^x.y.z` and
// `^x.y.z-prerelease`) and plain comparator sets (`>=a <b`) joined by ` || `
// — exactly the range shapes this manifest uses (peer / engines.dsh).
// `semver` itself is not resolvable from this repo root. If the manifest ever
// adopts ~, *, x-ranges or hyphen ranges, extend this before trusting it.
// ---------------------------------------------------------------------------
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

function parseVersion(v) {
  const m = VERSION_RE.exec(v)
  if (m === null) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] === undefined ? null : m[4].split('.') }
}

function comparePrerelease(a, b) {
  if (a === null && b === null) return 0
  if (a === null) return 1 // a release sorts above any prerelease of the same triple
  if (b === null) return -1
  for (let i = 0; ; i++) {
    if (i >= a.length && i >= b.length) return 0
    if (i >= a.length) return -1 // fewer identifiers sort lower when equal so far
    if (i >= b.length) return 1
    const x = a[i]
    const y = b[i]
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      const d = Number(x) - Number(y)
      if (d !== 0) return Math.sign(d)
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1 // numeric identifiers sort below alphanumeric ones
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
}

function compareVersions(a, b) {
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] !== b[k]) return Math.sign(a[k] - b[k])
  }
  return comparePrerelease(a.pre, b.pre)
}

// Caret bounds mirror real semver: lower bound is the segment version itself
// (prerelease included), upper bound bumps the leftmost nonzero component and
// always carries a `-0` prerelease, e.g. `^0.2.0-rc.1` → [0.2.0-rc.1, 0.3.0-0).
function caretBounds(segment) {
  const lo = parseVersion(segment)
  if (lo === null) throw new Error(`unparseable range segment: ^${segment}`)
  let upper
  if (lo.major > 0) upper = `${lo.major + 1}.0.0-0`
  else if (lo.minor > 0) upper = `${lo.major}.${lo.minor + 1}.0-0`
  else upper = `${lo.major}.${lo.minor}.${lo.patch + 1}-0`
  return { lo, hi: parseVersion(upper) }
}

// Space-separated comparator set (`>=a <b`) — the shape of engines.dsh.
function satisfiesComparatorSet(v, set) {
  return set.split(/\s+/).filter(Boolean).every((part) => {
    const m = /^(>=|<=|>|<|=)?(.+)$/.exec(part)
    const bound = m === null ? null : parseVersion(m[2])
    if (bound === null) throw new Error(`unsupported comparator "${part}"`)
    const d = compareVersions(v, bound)
    switch (m[1] ?? '=') {
      case '>=': return d >= 0
      case '<=': return d <= 0
      case '>': return d > 0
      case '<': return d < 0
      default: return d === 0
    }
  })
}

// Mirrors the host gate: semver.satisfies(version, range, { includePrerelease: true }).
function satisfiesRange(version, range) {
  const v = parseVersion(version)
  if (v === null) throw new Error(`unparseable version: ${version}`)
  return range
    .split('||')
    .map((s) => s.trim())
    .filter(Boolean)
    .some((segment) => {
      if (!segment.startsWith('^')) return satisfiesComparatorSet(v, segment)
      const { lo, hi } = caretBounds(segment.slice(1))
      return compareVersions(v, lo) >= 0 && compareVersions(v, hi) < 0
    })
}

// ---------------------------------------------------------------------------
// Tiny assertion helpers (no test framework, same shape as scripts/test-*.mjs).
// ---------------------------------------------------------------------------
let failures = 0
let passed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

function checkDeepEqual(name, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  check(name, a === b, `actual=${a} expected=${b}`)
}

// ---------------------------------------------------------------------------
// Stub host context — models only the host boundary seam, never plugin internals.
// ---------------------------------------------------------------------------
function createHostStub(extraServices = {}) {
  const calls = {
    tools: [],
    configure: [],
    skillsRegister: [],
    routes: [],
    tapIndex: 0,
    events: {},
    credentialResolve: [],
  }
  const disposers = []
  const services = {
    // 0.1.7+/0.2.x host shape: volatile Config page policy — NO installSection.
    settings: {
      configure: (options, fiber) => {
        calls.configure.push({ options, fiber })
        return () => {}
      },
    },
    skills: {
      register: (skill) => {
        calls.skillsRegister.push(skill)
        return () => {}
      },
    },
    webServer: {
      port: 3080,
      register: (route) => {
        calls.routes.push(route)
        return () => {}
      },
      tapIndex: () => {
        calls.tapIndex += 1
        return () => {}
      },
    },
    // Credential store that never resolves — exercises the absent-credential
    // path (resolve → undefined → env fallback).
    credentials: {
      resolve: async (ref) => {
        calls.credentialResolve.push(ref)
        return undefined
      },
    },
    ...extraServices,
  }

  const ctx = {
    fiber: { id: 'host-compat-stub-fiber' },
    tools: {
      register: (definition) => {
        calls.tools.push(definition)
        return () => {}
      },
    },
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    on: (event, cb) => {
      ;(calls.events[event] ??= []).push(cb)
      return () => {}
    },
    get: (name) => services[name],
    inject: (deps, cb) => {
      if (!deps.every((dep) => services[dep] !== undefined)) return () => {}
      const child = Object.create(ctx)
      for (const dep of deps) child[dep] = services[dep]
      cb(child)
      return () => {}
    },
  }
  return { ctx, calls, disposers }
}

function disposeAll(disposers) {
  for (const dispose of disposers.reverse()) {
    try {
      dispose()
    } catch {
      // best-effort teardown only
    }
  }
}

const { apply } = await import('../lib/index.js')

// ---------------------------------------------------------------------------
// 1. Load seam: apply(ctx, entryConfig) against a 0.2.x-shaped host.
// ---------------------------------------------------------------------------
const dataDir = mkdtempSync(join(tmpdir(), 'dsh-comfyui-host-compat-'))
const { ctx, calls, disposers } = createHostStub()

let applyCompleted = false
try {
  await apply(ctx, {
    baseUrl: 'http://127.0.0.1:8188',
    dataDir,
    apiKeyEnv: 'COMFYUI_API_KEY_HOST_COMPAT_TEST',
  })
  applyCompleted = true
} catch (error) {
  console.log(`  FAIL apply(ctx, entryConfig) threw — ${error && error.stack ? error.stack : error}`)
  failures += 1
}
// The signal is the registrations apply left behind, not the absence of a throw.
check(
  'apply(ctx, entryConfig) completes against a 0.2.x-shaped host (no installSection) and registers onto it',
  applyCompleted && calls.tools.length > 0 && calls.configure.length > 0,
  `completed=${applyCompleted} tools=${calls.tools.length} configure=${calls.configure.length}`,
)

const toolNames = calls.tools.map((t) => t.name).sort()
checkDeepEqual('exactly 4 tools register with the expected names', toolNames, [
  'comfyui_object_info',
  'comfyui_run',
  'comfyui_skill',
  'comfyui_workflow',
])
{
  let refused = ''
  try {
    await calls.tools.find((t) => t.name === 'comfyui_run').execute({ template: 'txt2img' }, { signal: new AbortController().signal })
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error)
  }
  check(
    'comfyui_run: a leftover `template` argument is refused with a pointer to comfyui_workflow',
    refused.includes('templates were removed') && refused.includes('comfyui_workflow (action: list, then run)'),
    refused,
  )
}
for (const tool of calls.tools) {
  const out = tool.output
  const usable =
    out !== null && typeof out === 'object' && out.schema !== null && typeof out.schema === 'object' &&
    typeof out.render === 'function'
  check(`tool ${tool.name} carries a usable output (schema + render)`, usable, `output=${JSON.stringify(out)}`)
}

check(
  'settings.configure({ auto: false }, fiber) called exactly once (volatile branch)',
  calls.configure.length === 1 &&
    JSON.stringify(calls.configure[0]?.options) === JSON.stringify({ auto: false }) &&
    calls.configure[0]?.fiber === ctx.fiber,
  `configure calls=${JSON.stringify(calls.configure)}`,
)
check(
  'skills.register called (companion skill)',
  calls.skillsRegister.length >= 1 &&
    typeof calls.skillsRegister[0]?.name === 'string' &&
    calls.skillsRegister[0].name.length > 0,
  `registered=${JSON.stringify(calls.skillsRegister.map((s) => s.name))}`,
)
check('webServer route mounting called', calls.routes.length > 0, `routes registered=${calls.routes.length}`)
check('webServer index-page tap registered', calls.tapIndex >= 1, `tapIndex calls=${calls.tapIndex}`)
check(
  "event subscription for 'loader/volatile-update' registered",
  (calls.events['loader/volatile-update']?.length ?? 0) >= 1,
  `events=${JSON.stringify(Object.keys(calls.events))}`,
)

// Credentials resolution exercised without throwing when the credential is
// absent: the one fully-offline tool path (comfyui_workflow action 'list').
const workflowTool = calls.tools.find((t) => t.name === 'comfyui_workflow')
if (workflowTool === undefined) {
  failures += 1
  console.log('  FAIL comfyui_workflow tool not found — cannot exercise credentials path')
} else {
  try {
    const result = await workflowTool.execute({ action: 'list' }, {})
    check(
      'comfyui_workflow action:list executes offline without throwing',
      result !== null && typeof result === 'object' && result.action === 'list',
      `result.action=${JSON.stringify(result?.action)}`,
    )
    check(
      'credentials.resolve consulted and absent credential handled (env fallback)',
      calls.credentialResolve.length >= 1,
      `resolve calls=${calls.credentialResolve.length}`,
    )
  } catch (error) {
    failures += 1
    console.log(`  FAIL credentials path threw — ${error && error.stack ? error.stack : error}`)
  }
}
disposeAll(disposers)
rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })

// ---------------------------------------------------------------------------
// 2. Install gate: dsh 0.2.1+ reads ONLY engines.dsh (and ignores the peer
// when it is present); older hosts read ONLY the dsh-settings peer. Both must
// admit every target host line and reject out-of-range versions, so the check
// cannot pass vacuously.
// ---------------------------------------------------------------------------
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const gates = {
  'engines.dsh': manifest.engines?.dsh,
  'dsh-settings peer': manifest.peerDependencies?.['@deepseek-ai/dsh-settings'],
}
const mustSatisfy = [
  '0.1.2-alpha.4',
  '0.1.5-alpha.1',
  '0.1.6-alpha.1',
  '0.1.7-alpha.1',
  '0.1.7-rc.2',
  '0.2.0-rc.1',
  '0.2.0-rc.2',
  '0.2.0',
  '0.2.1-alpha.1',
  '0.2.1-rc.2',
]
const mustNotSatisfy = ['0.1.1', '0.3.0-alpha.1', '0.3.0']
for (const [gate, range] of Object.entries(gates)) {
  check(`manifest declares ${gate}`, typeof range === 'string' && range.length > 0, `range=${JSON.stringify(range)}`)
  if (typeof range !== 'string') continue
  for (const version of mustSatisfy) {
    check(`${gate} admits host ${version}`, satisfiesRange(version, range), `range=${range}`)
  }
  for (const version of mustNotSatisfy) {
    check(`${gate} rejects host ${version}`, !satisfiesRange(version, range), `range=${range}`)
  }
}

// ---------------------------------------------------------------------------
// 3. Jobs contract: mode:"async" against both jobs shapes. dsh 0.1.2–0.1.6
// take the Agent handle as owner and read `output`; 0.1.7+ (has `readAt`)
// take the SessionId and read `result`. ComfyUI is a stubbed fetch.
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch
let historyStatus = 'success'
globalThis.fetch = async (url, init) => {
  const path = new URL(String(url)).pathname
  const json = (body) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  if (path === '/prompt' && init?.method === 'POST') return json({ prompt_id: 'compat-prompt', number: 1 })
  if (path === '/history/compat-prompt') {
    return json({
      'compat-prompt': {
        status: { status_str: historyStatus, completed: historyStatus === 'success', messages: [] },
        outputs: historyStatus === 'success' ? { 9: { images: [{ filename: 'compat_00001_.png', subfolder: '', type: 'output' }] } } : {},
      },
    })
  }
  return new Response('not found', { status: 404 })
}

const agent = { id: 'compat-session' }
// A minimal hand-written API workflow — comfyui_run takes nothing else now.
const handWritten = () => ({
  8: { class_type: 'EmptyImage', inputs: { width: 64, height: 64, batch_size: 1, color: 0 } },
  9: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'compat' } },
})
for (const legacy of [true, false]) {
  const host = legacy ? 'dsh 0.1.2–0.1.6 jobs' : 'dsh 0.1.7+ jobs'
  const textKey = legacy ? 'output' : 'result'
  const otherKey = legacy ? 'result' : 'output'
  for (const outcome of ['success', 'error']) {
    historyStatus = outcome
    const specs = []
    const jobs = {
      start: (spec) => {
        specs.push(spec)
        return 'job-1'
      },
      ...(legacy ? {} : { readAt: () => undefined }),
    }
    const stub = createHostStub({ jobs })
    const jobDataDir = mkdtempSync(join(tmpdir(), 'dsh-comfyui-host-compat-jobs-'))
    try {
      await apply(stub.ctx, { baseUrl: 'http://127.0.0.1:8188', dataDir: jobDataDir, pollIntervalMs: 10 })
      const run = stub.calls.tools.find((t) => t.name === 'comfyui_run')
      const value = await run.execute(
        { workflow: handWritten(), mode: 'async' },
        { agent, signal: new AbortController().signal },
      )
      check(
        `${host} (${outcome}): comfyui_run async starts a background job`,
        value?.kind === 'background' && value.jobId === 'job-1' && specs.length === 1,
        JSON.stringify(value),
      )
      // The receipt the model reads: end the turn where the host notifies.
      const receipt = run.output.render({}, value)[0]?.text ?? ''
      check(
        `${host} (${outcome}): background receipt ${legacy ? 'does not promise a notice' : 'says to end the turn and await the notice'}`,
        legacy
          ? !receipt.includes('completion notice') && receipt.includes('job_output')
          : receipt.includes('end your turn') && receipt.includes('completion notice'),
        receipt,
      )
      const spec = specs[0]
      check(
        `${host} (${outcome}): owner is ${legacy ? 'the Agent handle' : 'the SessionId'}`,
        spec?.owner === (legacy ? agent : agent.id),
        `owner=${JSON.stringify(spec?.owner)}`,
      )
      const done = await spec.run().done
      if (outcome === 'success') {
        const text = typeof done[textKey] === 'string' ? done[textKey] : ''
        check(
          `${host}: completed outcome carries the result text in \`${textKey}\` only`,
          done.status === 'completed' && text.includes('prompt compat-prompt') && !(otherKey in done),
          JSON.stringify(done),
        )
        check(
          `${host}: result text embeds the image as ready-to-paste Markdown`,
          /^!\[image 1\]\(\S*\/comfyui\/media\?file=compat_00001_\.png\S*\)$/m.test(text),
          text,
        )
      } else {
        const surfaced = legacy
          ? typeof done.output === 'string' && done.output.length > 0
          : typeof done.detail === 'string' && done.detail.startsWith('comfyui: ')
        check(
          `${host}: failed outcome surfaces the ComfyUI error in \`${legacy ? 'output' : 'detail'}\``,
          done.status === 'failed' && surfaced && !(otherKey in done),
          JSON.stringify(done),
        )
      }
      // No key may be present-but-undefined (lossless-JSON validation, #9).
      check(
        `${host} (${outcome}): outcome has no undefined-valued keys`,
        Object.values(done).every((v) => v !== undefined),
        JSON.stringify(done),
      )
    } catch (error) {
      failures += 1
      console.log(`  FAIL ${host} (${outcome}) threw — ${error && error.stack ? error.stack : error}`)
    } finally {
      disposeAll(stub.disposers)
      rmSync(jobDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  }
}
globalThis.fetch = realFetch

// ---------------------------------------------------------------------------
// 3a. job_kill cancels THIS prompt only: dequeue while pending, prompt-scoped
// interrupt while running — never a bare /interrupt that would stop whatever
// ComfyUI is running (another session's job). The killed job settles as
// `killed`, and the 0.1.7+ handle receives a status-line progress update.
// ---------------------------------------------------------------------------
for (const where of ['pending', 'running']) {
  const posts = []
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname
    const json = (body) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (path === '/prompt' && init?.method === 'POST') return json({ prompt_id: 'cancel-prompt', number: 1 })
    if (path === '/history/cancel-prompt') return json({})
    if (init?.method === 'POST') {
      posts.push(`${path} ${init.body ?? ''}`)
      return json({})
    }
    if (path === '/queue') {
      const self = [[1, 'cancel-prompt', {}, {}, []]]
      const other = [[0, 'someone-else', {}, {}, []]]
      return json(where === 'pending' ? { queue_running: other, queue_pending: self } : { queue_running: self, queue_pending: [] })
    }
    return new Response('not found', { status: 404 })
  }
  const specs = []
  const stub = createHostStub({
    jobs: {
      start: (spec) => {
        specs.push(spec)
        return 'job-cancel'
      },
      readAt: () => undefined,
    },
  })
  const cancelDataDir = mkdtempSync(join(tmpdir(), 'dsh-comfyui-host-compat-cancel-'))
  try {
    await apply(stub.ctx, { baseUrl: 'http://127.0.0.1:8188', dataDir: cancelDataDir, pollIntervalMs: 10 })
    const run = stub.calls.tools.find((t) => t.name === 'comfyui_run')
    await run.execute({ workflow: handWritten(), mode: 'async' }, { agent, signal: new AbortController().signal })
    const progress = []
    const hooks = specs[0].run({ id: 'job-cancel', append: () => {}, updateProgress: (line) => progress.push(line) })
    await new Promise((resolve) => setTimeout(resolve, 50))
    hooks.cancel('test')
    const done = await hooks.done
    const expected = where === 'pending'
      ? '/queue {"delete":["cancel-prompt"]}'
      : '/interrupt {"prompt_id":"cancel-prompt"}'
    check(
      `job_kill while ${where}: cancels only this prompt (${expected})`,
      posts.length === 1 && posts[0] === expected,
      `posts=${JSON.stringify(posts)}`,
    )
    check(`job_kill while ${where}: job settles as killed`, done.status === 'killed', JSON.stringify(done))
    check(
      `job_kill while ${where}: 0.1.7+ handle got a progress line (published once, not every poll)`,
      progress.length === 1 && progress[0] === 'waiting for ComfyUI',
      JSON.stringify(progress),
    )
  } catch (error) {
    failures += 1
    console.log(`  FAIL job_kill while ${where} threw — ${error && error.stack ? error.stack : error}`)
  } finally {
    disposeAll(stub.disposers)
    rmSync(cancelDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}
globalThis.fetch = realFetch

// ---------------------------------------------------------------------------
// 3b. Sync result: always final, always ready-to-paste Markdown — the model's
// reply is the display path in every host mode (dsh 0.2 collapses finished
// tool rows; run_code / PTC mode renders no tool card), so there is no
// "already shown in the card" variant any more.
// ---------------------------------------------------------------------------
{
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url))
    const json = (body) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (parsed.pathname === '/prompt' && init?.method === 'POST') return json({ prompt_id: 'sync-prompt', number: 1 })
    if (parsed.pathname === '/history/sync-prompt') {
      return json({
        'sync-prompt': {
          status: { status_str: 'success', completed: true, messages: [] },
          outputs: { 9: { images: [{ filename: 'sync_00001_.png', subfolder: '', type: 'output' }] } },
        },
      })
    }
    return new Response('not found', { status: 404 })
  }
  const stub = createHostStub()
  const syncDataDir = mkdtempSync(join(tmpdir(), 'dsh-comfyui-host-compat-sync-'))
  try {
    await apply(stub.ctx, { baseUrl: 'http://127.0.0.1:8188', dataDir: syncDataDir, pollIntervalMs: 10 })
    const run = stub.calls.tools.find((t) => t.name === 'comfyui_run')
    const value = await run.execute({ workflow: handWritten() }, { agent, signal: new AbortController().signal })
    const text = run.output.render({}, value)[0]?.text ?? ''
    check(
      'sync result: final, with the image as ready-to-paste Markdown (rendered text and `report` alike)',
      text.includes('final result') && /^!\[image 1\]\(\S+sync_00001_\.png\S*\)$/m.test(text) &&
        !text.includes('already displayed') && value.report === text,
      text,
    )
  } catch (error) {
    failures += 1
    console.log(`  FAIL sync result check threw — ${error && error.stack ? error.stack : error}`)
  } finally {
    disposeAll(stub.disposers)
    rmSync(syncDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
  globalThis.fetch = realFetch
}

// ---------------------------------------------------------------------------
// 3c. Saved-workflow runs: unknown parameter names are refused before
// anything is queued; the result names the prompt actually submitted (and
// flags a saved default); a code-dispatched call (run_code) never claims the
// card shows the media and carries its guidance in the value's `report`.
// ---------------------------------------------------------------------------
{
  const submitted = []
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url))
    const json = (body) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (parsed.pathname === '/prompt' && init?.method === 'POST') {
      submitted.push(JSON.parse(init.body).prompt)
      return json({ prompt_id: `wf-${submitted.length}`, number: submitted.length })
    }
    const hist = /^\/history\/(wf-\d+)$/.exec(parsed.pathname)
    if (hist !== null) {
      return json({
        [hist[1]]: {
          status: { status_str: 'success', completed: true, messages: [] },
          outputs: { 9: { images: [{ filename: `${hist[1]}.png`, subfolder: '', type: 'output' }] } },
        },
      })
    }
    if (parsed.pathname === '/view') {
      return init?.method === 'HEAD'
        ? new Response(null, { status: 200, headers: { 'content-length': '4' } })
        : new Response('x', { status: 206 })
    }
    return new Response('not found', { status: 404 })
  }
  const wfDataDir = mkdtempSync(join(tmpdir(), 'dsh-comfyui-host-compat-wf-'))
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(wfDataDir, 'workflows.json'), JSON.stringify([{
    id: 'wf-test',
    name: 'Compat T2I',
    description: '',
    workflow: {
      3: { class_type: 'KSampler', inputs: { seed: 1, steps: 8 } },
      6: { class_type: 'CLIPTextEncode', inputs: { text: 'a default cat', clip: ['4', 1] } },
      9: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'ComfyUI' } },
    },
    parameters: [
      { id: 'p1', name: 'prompt', label: '提示词', type: 'string', nodeId: '6', inputKey: 'text', default: 'a default cat' },
      { id: 'p2', name: 'seed', label: '种子', type: 'number', nodeId: '3', inputKey: 'seed', default: 1 },
    ],
  }]))
  const stub = createHostStub()
  try {
    await apply(stub.ctx, { baseUrl: 'http://127.0.0.1:8188', dataDir: wfDataDir, pollIntervalMs: 10 })
    const ping = stub.calls.routes.find((r) => r.path === '/comfyui/ping')
    await ping.handler(
      { method: 'GET', url: '/comfyui/ping', headers: { host: '192.168.1.5:3080' } },
      { writeHead: () => {}, end: () => {}, setHeader: () => {} },
    )
    const tool = stub.calls.tools.find((t) => t.name === 'comfyui_workflow')
    const direct = { agent, signal: new AbortController().signal, callId: 'call-1', rootCallId: 'call-1' }
    const render = (value) => tool.output.render({}, value)[0]?.text ?? ''

    const listing = render(await tool.execute({ action: 'list' }, direct))
    check(
      'workflow list: says unpassed parameters use defaults; the prompt is marked to fill (its default hidden), seed keeps its default',
      listing.includes('未传的参数使用默认值') &&
        listing.includes('  prompt(提示词) — 按用户需求填写，未明确时据需求自行发挥') && !listing.includes('a default cat') &&
        listing.includes('  seed(种子，默认 1)'),
      listing,
    )

    let refused = ''
    try {
      await tool.execute({ action: 'run', id: 'wf-test', parameters: { promt: 'a red fox' } }, direct)
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error)
    }
    check(
      'workflow run: a misspelt parameter name is refused and nothing is queued',
      refused.includes('no parameter "promt"') && refused.includes('Valid parameter names: prompt, seed') && submitted.length === 0,
      `error=${JSON.stringify(refused)} submitted=${submitted.length}`,
    )

    const passed = await tool.execute({ action: 'run', id: 'wf-test', parameters: { prompt: 'a red fox in snow' } }, direct)
    const passedText = render(passed)
    check(
      'workflow run: the passed prompt is submitted and reported, with the subject-report instruction',
      submitted.at(-1)?.['6']?.inputs?.text === 'a red fox in snow' &&
        passedText.includes('Prompt used (prompt): "a red fox in snow"') && passedText.includes('state in one sentence what was generated') &&
        /^!\[image 1\]\(/m.test(passedText),
      passedText,
    )

    const defaulted = render(await tool.execute({ action: 'run', id: 'wf-test' }, direct))
    check(
      'workflow run: a prompt left out is reported as the default',
      defaulted.includes('Prompt used (prompt, default — not passed): "a default cat"'),
      defaulted,
    )

    const nested = await tool.execute(
      { action: 'run', id: 'wf-test', parameters: { prompt: 'a lighthouse' } },
      { agent, signal: new AbortController().signal, callId: 'call-2:ptc:1', rootCallId: 'call-2', parent: { token: 'run_code' } },
    )
    check(
      'workflow run from run_code: value carries `report` with the Markdown and the prompt used',
      typeof nested.report === 'string' && /^!\[image 1\]\(/m.test(nested.report) && !nested.report.includes('already displayed') &&
        nested.report.includes('Prompt used (prompt): "a lighthouse"'),
      JSON.stringify(nested.report),
    )
  } catch (error) {
    failures += 1
    console.log(`  FAIL saved-workflow run checks threw — ${error && error.stack ? error.stack : error}`)
  } finally {
    disposeAll(stub.disposers)
    rmSync(wfDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
  globalThis.fetch = realFetch
}

// ---------------------------------------------------------------------------
// 4. Identity consistency: every artifact the host resolves BY PACKAGE NAME
// must carry the current package name (a fork that renames the package must
// not have to chase literals). Two failure modes were hit in the field:
//   - cordis.patch.yml `name` is the module specifier the cordis loader
//     imports; a stale value leaves the bundle layer composed while the plugin
//     module never loads.
//   - the client bundle banner registers the factory id the renderer's module
//     graph looks up by graph-row id (= package name); a stale banner makes the
//     row fall back to its one-resource URL, re-executes the bundle and aborts
//     web boot with `duplicate factory registration` (host never starts).
// ---------------------------------------------------------------------------
check(
  'cordis.patch.yml entry name equals the npm package name',
  patchName === manifest.name,
  `patch=${JSON.stringify(patchName)} package=${JSON.stringify(manifest.name)}`,
)
const clientBundlePath = join(repoRoot, 'client', 'client.js')
if (existsSync(clientBundlePath)) {
  const clientBundle = readFileSync(clientBundlePath, 'utf8')
  const bannerId = /__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(clientBundle)?.[1]
  check(
    'client bundle registers under the npm package name (renderer module-graph id)',
    bannerId === manifest.name,
    `banner=${JSON.stringify(bannerId)} package=${JSON.stringify(manifest.name)}`,
  )
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log(`\nall ${passed} checks passed — install gates, load seam and jobs contract hold for every admitted dsh line`)
process.exit(0)
