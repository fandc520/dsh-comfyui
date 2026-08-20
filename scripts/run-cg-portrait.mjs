/** Run the Krea workflow with a custom prompt parameter and wait for completion. */
const base = 'http://127.0.0.1:3080'
const origin = { Origin: base, Referer: `${base}/` }

const prompt = [
  'A cinematic CG portrait of a beautiful young female game character, an ethereal moon-elf ranger,',
  'flowing silver-white hair, luminous violet eyes, pale luminous skin with subtle glowing runic markings,',
  'elegant elven armor with teal energy accents and flowing silk fabric, ornate jewelry,',
  'dramatic rim lighting against a mystical forest shrine background,',
  'highly detailed digital painting, AAA game character art style, sharp details, 4k quality',
].join(' ')

const runRes = await fetch(`${base}/comfyui/workflows/run`, {
  method: 'POST',
  headers: { ...origin, 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: '7bf7db6f-349f-46f0-8c04-c8c567798150', parameters: { prompt } }),
})
const runBody = await runRes.json()
console.log(`run status=${runRes.status} body=${JSON.stringify(runBody)}`)
if (runRes.status !== 200 || runBody.ok !== true) process.exit(1)
const promptId = runBody.promptId

const deadline = Date.now() + 180000
let last = ''
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 3000))
  const jobs = await (await fetch(`${base}/comfyui/jobs?status=completed,failed,cancelled&limit=100`, { headers: origin })).json()
  const job = (jobs.jobs ?? []).find((j) => j.id === promptId)
  if (job === undefined) {
    const active = await (await fetch(`${base}/comfyui/jobs?status=pending,in_progress&limit=100`, { headers: origin })).json()
    const running = (active.jobs ?? []).find((j) => j.id === promptId)
    const state = running === undefined ? 'queued?' : `${running.status} ${running.progress?.value ?? '?'}/${running.progress?.max ?? '?'}`
    if (state !== last) { last = state; console.log(`... ${state}`) }
    continue
  }
  console.log(`terminal: status=${job.status} error=${job.executionError ?? ''}`)
  console.log(`outputs=${job.outputs_count ?? 0} preview=${JSON.stringify(job.preview_output ?? null)}`)
  console.log(`durationMs=${(job.executionEndTime ?? 0) - (job.executionStartTime ?? 0)}`)
  console.log(`workflowName=${job.workflowName} ours=${job.ours}`)
  process.exit(job.status === 'completed' ? 0 : 1)
}
console.log('TIMEOUT waiting for job')
process.exit(1)
