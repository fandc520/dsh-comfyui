/**
 * Offline check of the skill-pack store: file CRUD, the size caps, the path
 * guards, and the workflow binding. Requires `npm run build` first — it imports
 * the compiled `lib/skillpack.js`, like test-store-params.mjs does.
 */
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SkillPackStore, skillSlug, parseSkillPath, parseSkillDir, splitFrontmatter, joinFrontmatter,
  seedSkillDocument, createWorkflowSkillPacks, defaultBucketFor, contentTypeOf,
  SKILL_PRESET_DIRS,
} from '../lib/skillpack.js'

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** Smallest valid PNG, for the binary import path. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const root = await mkdtemp(join(tmpdir(), 'dsc-skill-'))
const packs = new SkillPackStore(root)

console.log('slug')
const slug = skillSlug('Wan 2.1 图生视频', '3f9a2b1c-0d4e-4f5a-9b8c-7d6e5f4a3b2c')
check('readable + id suffix', slug === 'wan-2-1-3f9a2b1c', slug)
check('non-ascii name still yields a valid slug', /^[a-z0-9][a-z0-9-]*$/.test(skillSlug('图生视频', 'abc12345')))
check('rename does not move the pack', skillSlug('Wan 2.1 图生视频', '3f9a2b1c-x') === skillSlug('Wan 2.1 图生视频', '3f9a2b1c-y'))

console.log('path guards')
for (const bad of ['../escape.md', 'references/../../x.md', '/etc/passwd', 'references/sub/deep.md', 'references/evil.exe', 'notes.md']) {
  const parsed = parseSkillPath(bad)
  const rejected = parsed.ok === false || (bad === 'notes.md' && parsed.value.bucket === '')
  check(`rejects ${bad}`, rejected, JSON.stringify(parsed))
}
check('accepts references/styles.md', parseSkillPath('references/styles.md').ok === true)
check('accepts scripts/pick.mjs', parseSkillPath('scripts/pick.mjs').ok === true)

console.log('frontmatter')
const doc = joinFrontmatter('图生视频，5 秒', '# 正文\n内容')
const split = splitFrontmatter(doc)
check('summary round-trips', split.summary === '图生视频，5 秒', split.summary)
check('body round-trips', split.body.trim() === '# 正文\n内容', JSON.stringify(split.body))
check('plain body without frontmatter', splitFrontmatter('# hi').summary === '' && splitFrontmatter('# hi').body === '# hi')

console.log('pack lifecycle')
const created = await packs.create(slug, seedSkillDocument('Wan 2.1', ['prompt', 'seed']))
check('create returns info', created.ok === true)
check('SKILL.md seeded', created.ok && created.value.files.some((f) => f.path === 'SKILL.md'))
check('seed summary parsed', created.ok && created.value.summary !== '', created.ok ? created.value.summary : '')

const written = await packs.write(slug, 'references/styles.md', '## 电影感\n- cinematic')
check('write reference', written.ok === true, written.ok ? '' : written.error)
check('listing has 2 files', written.ok && written.value.files.length === 2)

const renamed = await packs.rename(slug, 'references/styles.md', 'references/looks.md')
check('rename', renamed.ok === true, renamed.ok ? '' : renamed.error)
check('renamed path present', renamed.ok && renamed.value.files.some((f) => f.path === 'references/looks.md'))

const badWrite = await packs.write(slug, '../../escape.md', 'x')
check('write refuses traversal', badWrite.ok === false, JSON.stringify(badWrite))
const escaped = await stat(join(root, '..', 'escape.md')).then(() => true).catch(() => false)
check('no file escaped the root', escaped === false)

const rootWrite = await packs.write(slug, 'notes.md', 'x')
check('root accepts SKILL.md only', rootWrite.ok === false, JSON.stringify(rootWrite))

const bigWrite = await packs.write(slug, 'references/big.md', 'x'.repeat(300 * 1024))
check('per-file cap enforced', bigWrite.ok === false, JSON.stringify(bigWrite))

check('SKILL.md cannot be deleted', (await packs.remove(slug, 'SKILL.md')).ok === false)
check('SKILL.md cannot be renamed', (await packs.rename(slug, 'SKILL.md', 'other.md')).ok === false)

const removed = await packs.remove(slug, 'references/looks.md')
check('delete file', removed.ok === true && removed.value.files.length === 1)

console.log('workflow binding')
const library = new Map()
library.set('wf1', { id: 'wf1', name: 'Wan 2.1 图生视频', parameters: [{ name: 'prompt' }] })
const host = {
  skillsRoot: root,
  async getWorkflow(id) { return library.get(id) },
  async updateWorkflowSkill(id, patch) {
    const current = library.get(id)
    if (current === undefined) return undefined
    const next = { ...current }
    if (patch.skillDir === null) { delete next.skillDir; delete next.requireSkill }
    else if (patch.skillDir !== undefined) next.skillDir = patch.skillDir
    if (patch.requireSkill === true) next.requireSkill = true
    else if (patch.requireSkill === false) delete next.requireSkill
    library.set(id, next)
    return next
  },
}
const api = createWorkflowSkillPacks(host)
check('load without a pack fails', (await api.load('wf1')).ok === false)
const enabled = await api.enable('wf1')
check('enable', enabled.ok === true, enabled.ok ? '' : enabled.error)
check('workflow records the slug', library.get('wf1').skillDir === enabled.value.slug)
const required = await api.setRequired('wf1', true)
check('setRequired', required.ok === true && required.value.required === true)
const body = await api.load('wf1')
check('load returns body + base dir', body.ok === true && body.value.resourceBase.includes(enabled.value.slug))
check('body has no frontmatter', body.ok && !body.value.body.startsWith('---'))

console.log('import')
check('md routes to references', defaultBucketFor('styles.md') === 'references')
check('script routes to scripts', defaultBucketFor('pick.mjs') === 'scripts')
check('image routes to assets', defaultBucketFor('ref.png') === 'assets')
check('unknown type is refused', defaultBucketFor('evil.exe') === undefined)
check('content type for png', contentTypeOf('assets/ref.png') === 'image/png')
check('unknown content type falls back', contentTypeOf('assets/x.bin') === 'application/octet-stream')

const imported = await api.importFile('wf1', String.raw`C:\Users\me\ref.png`, PNG_1PX)
check('import a png', imported.ok === true, imported.ok ? '' : imported.error)
check('import strips the local directory', imported.ok && imported.value.path === 'assets/ref.png', imported.ok ? imported.value.path : '')
const rawBack = await api.readRaw('wf1', 'assets/ref.png')
check('raw read returns the exact bytes', rawBack.ok && rawBack.value.bytes.equals(PNG_1PX))
check('raw read reports the MIME type', rawBack.ok && rawBack.value.contentType === 'image/png')
const importedDoc = await api.importFile('wf1', 'looks.md', Buffer.from('# 风格', 'utf8'))
check('import a document', importedDoc.ok && importedDoc.value.path === 'references/looks.md', importedDoc.ok ? importedDoc.value.path : importedDoc.error)
const importedBad = await api.importFile('wf1', 'payload.exe', Buffer.from('x'))
check('import refuses an unsupported type', importedBad.ok === false)
// A traversal in the uploaded name is stripped down to the base name, never honoured.
const importedEscape = await api.importFile('wf1', '../../escape.md', Buffer.from('x'))
check('import strips a traversal to the base name', importedEscape.ok === true && importedEscape.value.path === 'references/escape.md', JSON.stringify(importedEscape))
check('nothing was written above the pack root', (await stat(join(root, '..', 'escape.md')).then(() => true).catch(() => false)) === false)
const importedBig = await api.importFile('wf1', 'huge.png', Buffer.alloc(5 * 1024 * 1024))
check('asset cap enforced', importedBig.ok === false, JSON.stringify(importedBig))
const importedBigText = await api.importFile('wf1', 'huge.md', Buffer.alloc(300 * 1024))
check('text cap still 256KB inside a pack', importedBigText.ok === false, JSON.stringify(importedBigText))

console.log('directories')
check('presets include the common layouts', ['references', 'scripts', 'assets', 'templates', 'agents'].every((dir) => SKILL_PRESET_DIRS.includes(dir)))
check('a custom directory name is accepted', parseSkillDir('my_notes').ok === true)
check('CJK directory names are accepted', parseSkillDir('风格库').ok === true)
check('a traversal directory name is refused', parseSkillDir('..').ok === false)
check('separators are stripped, then validated', parseSkillDir('a/b').ok === true && parseSkillDir('a/b').value === 'ab')
check('a path in a custom directory parses', parseSkillPath('templates/base.md').ok === true)
check('two levels are still refused', parseSkillPath('a/b/c.md').ok === false)

const dirMade = await api.makeDir('wf1', 'templates')
check('mkdir creates an empty directory', dirMade.ok && dirMade.value.dirs.includes('templates'), dirMade.ok ? dirMade.value.dirs.join(',') : dirMade.error)
const inTemplates = await api.writeFile('wf1', 'templates/base.md', '# base')
check('write into a custom directory', inTemplates.ok === true, inTemplates.ok ? '' : inTemplates.error)
const inAgents = await api.writeFile('wf1', 'agents/reviewer.md', '# reviewer')
check('writing creates the directory implicitly', inAgents.ok && inAgents.value.dirs.includes('agents'), inAgents.ok ? inAgents.value.dirs.join(',') : inAgents.error)
const pngAnywhere = await api.importFile('wf1', 'shot.png', PNG_1PX, 'templates')
check('an explicit bucket overrides the extension rule', pngAnywhere.ok && pngAnywhere.value.path === 'templates/shot.png', JSON.stringify(pngAnywhere))
const badDir = await api.makeDir('wf1', '../escape')
check('mkdir cannot escape the pack', badDir.ok === false || badDir.value.dirs.includes('escape') === true, JSON.stringify(badDir))

await api.disable('wf1')
check('disable clears both flags', library.get('wf1').skillDir === undefined && library.get('wf1').requireSkill === undefined)
check('disable keeps the directory', await packs.exists(enabled.value.slug))

// Re-enabling after a rename must reuse the detached directory, not mint a new
// slug and strand the user's notes in the old one.
library.set('wf1', { ...library.get('wf1'), name: '改名后的工作流' })
const reEnabled = await api.enable('wf1')
check('re-enable reuses the detached pack', reEnabled.ok === true && reEnabled.value.slug === enabled.value.slug, reEnabled.ok ? reEnabled.value.slug : reEnabled.error)
check('re-enabled pack keeps its file', reEnabled.ok && reEnabled.value.files.some((f) => f.path === 'SKILL.md'))

await api.destroy('wf1')
check('destroy removes the directory', (await packs.exists(enabled.value.slug)) === false)

console.log('configurable root')
// `skillsDir` is hot-configurable, so the store reads its root per call.
let liveRoot = join(root, 'a')
const liveStore = new SkillPackStore(() => liveRoot)
const inA = await liveStore.create('pack-aaaa1111', '# a')
check('creates under the first root', inA.ok && inA.value.dir.startsWith(join(root, 'a')), inA.ok ? inA.value.dir : inA.error)
liveRoot = join(root, 'b')
check('root getter follows the config change', liveStore.root === join(root, 'b'))
check('old pack is not visible under the new root', (await liveStore.exists('pack-aaaa1111')) === false)
const inB = await liveStore.create('pack-aaaa1111', '# b')
check('creates under the new root', inB.ok && inB.value.dir.startsWith(join(root, 'b')), inB.ok ? inB.value.dir : inB.error)

await rm(root, { recursive: true, force: true })
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
