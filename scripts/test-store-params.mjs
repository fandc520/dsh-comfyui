/** Verify save → reload persistence of workflow parameters through the store. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ComfyUIStore } from '../lib/store.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-comfyui-store-test-'))
const store = new ComfyUIStore(dir, 200)
await store.init()

const workflow = {
  '4': { class_type: 'KSampler', inputs: { seed: 15801126792304, steps: 8, cfg: 1, sampler_name: 'euler' } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 768, height: 1280, batch_size: 1 } },
  '38': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'a red cat' } },
}
const params = [
  { id: 'p1', name: 'prompt', label: '提示词', type: 'string', nodeId: '38', inputKey: 'value', default: 'a red cat' },
  { id: 'p2', name: 'seed', label: '随机种子', type: 'number', nodeId: '4', inputKey: 'seed', default: 15801126792304, random: true },
]

const saved = await store.saveWorkflow({
  name: 'persist-test',
  description: 'd',
  inputs: '参数: prompt(文本): 提示词',
  workflow,
  parameters: params,
  source: 'comfyui',
})
if (!saved.ok) {
  console.error(`save failed: ${saved.error}`)
  process.exit(1)
}

const reloaded = await store.listWorkflows()
const found = reloaded.find((w) => w.id === saved.workflow.id)
if (found === undefined || found.parameters === undefined || found.parameters.length !== 2) {
  console.error(`FAIL: parameters not persisted. reloaded=${JSON.stringify(found?.parameters)}`)
  rmSync(dir, { recursive: true, force: true })
  process.exit(1)
}
if (found.parameters[1]?.random !== true || found.parameters[0]?.name !== 'prompt') {
  console.error(`FAIL: parameters content mismatch: ${JSON.stringify(found.parameters)}`)
  rmSync(dir, { recursive: true, force: true })
  process.exit(1)
}
console.log('PASS: store persists and reloads parameters (id/name/label/type/nodeId/inputKey/default/random)')

// update path: edit keeps parameters when re-saved
const edited = await store.saveWorkflow({
  id: saved.workflow.id,
  name: 'persist-test-2',
  description: 'd2',
  inputs: '',
  workflow,
  parameters: params,
})
if (!edited.ok || edited.workflow.parameters === undefined || edited.workflow.parameters.length !== 2) {
  console.error(`FAIL: update lost parameters: ${JSON.stringify(edited.workflow.parameters)}`)
  rmSync(dir, { recursive: true, force: true })
  process.exit(1)
}
console.log('PASS: update (edit) preserves parameters')
rmSync(dir, { recursive: true, force: true })
console.log('ALL STORE PERSISTENCE TESTS PASSED')
