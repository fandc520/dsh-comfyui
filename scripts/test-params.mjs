/** Standalone verification of the parameter auto-detection / injection. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  analyzeWorkflowParameters,
  applyWorkflowParameters,
  buildParametersDescription,
} from '../lib/params.js'

const stored = JSON.parse(readFileSync(join(process.env.USERPROFILE, '.dsh', 'data', 'dsh-comfyui', 'workflows.json'), 'utf8'))
const workflow = stored[0].workflow

const params = analyzeWorkflowParameters(workflow)
console.log('=== detected parameters ===')
for (const p of params) {
  console.log(`${p.name} (${p.type}, random=${p.random === true}) -> #${p.nodeId}.${p.inputKey} default=${JSON.stringify(p.default).slice(0, 60)}`)
}

const names = params.map((p) => p.name)
const expected = ['seed', 'steps', 'width', 'height', 'prompt']
const missing = expected.filter((n) => !names.includes(n))
const extra = names.filter((n) => !expected.includes(n))
console.log(`expected=${expected.join(',')} | got=${names.join(',')}`)
if (missing.length > 0 || extra.length > 0) {
  console.error(`FAIL: missing=${missing.join(',')} extra=${extra.join(',')}`)
  process.exit(1)
}
console.log('PASS analyze: conservative set = seed/steps/width/height/prompt')

// apply: caller overrides prompt + seed; seed is not randomized when provided
const injected = applyWorkflowParameters(workflow, params, { prompt: 'a red cat', seed: 12345 })
const textNode = injected['38']
if (textNode.inputs.value !== 'a red cat') {
  console.error(`FAIL prompt injection: ${JSON.stringify(textNode.inputs.value).slice(0, 40)}`)
  process.exit(1)
}
if (injected['4'].inputs.seed !== 12345) {
  console.error(`FAIL seed override: ${injected['4'].inputs.seed}`)
  process.exit(1)
}
if (injected['5'].inputs.width !== 768) {
  console.error(`FAIL default width: ${injected['5'].inputs.width}`)
  process.exit(1)
}
console.log('PASS apply: prompt/seed overridden, defaults kept')

// seed randomized when omitted
const seedParams = params.filter((p) => p.name === 'seed')
const randomized = applyWorkflowParameters(workflow, seedParams, {})
if (randomized['4'].inputs.seed === workflow['4'].inputs.seed) {
  console.error('FAIL seed randomization: value unchanged')
  process.exit(1)
}
console.log(`PASS randomize: seed ${workflow['4'].inputs.seed} -> ${randomized['4'].inputs.seed}`)

// original workflow untouched
if (workflow['38'].inputs.value !== stored[0].workflow['38'].inputs.value) {
  console.error('FAIL: input workflow mutated')
  process.exit(1)
}
console.log('PASS: source workflow not mutated')

const desc = buildParametersDescription(params)
console.log(`=== description ===\n${desc}`)
if (!desc.startsWith('参数:') || !desc.includes('prompt')) {
  console.error('FAIL description')
  process.exit(1)
}
console.log('PASS description')
console.log('ALL PARAMS TESTS PASSED')
