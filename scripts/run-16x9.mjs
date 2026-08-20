/** Run Krea with a 16:9 wide shot (width/height overridden, not persisted). */
const base = 'http://127.0.0.1:3080'
const origin = { Origin: base, Referer: `${base}/` }

const prompt = [
  'A cinematic 16:9 CG wide shot of a beautiful female ice sorceress standing on a snowy mountain peak,',
  'long platinum-white hair flowing in the wind, crystal-blue eyes, flowing frost-blue robes with shimmering ice crystals,',
  'staff of frozen light in hand, vast mountain range and aurora-lit sky stretching behind her,',
  'dramatic god rays through clouds, epic fantasy game key art, highly detailed, volumetric lighting, 4k',
].join(' ')

const runRes = await fetch(`${base}/comfyui/workflows/run`, {
  method: 'POST',
  headers: { ...origin, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    id: '7bf7db6f-349f-46f0-8c04-c8c567798150',
    parameters: { prompt, width: 1280, height: 720 },
  }),
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
  console.log(`outputs=${job.outputsCount} preview=${JSON.stringify(job.previewOutput ?? null)}`)
  console.log(`durationMs=${(job.executionEndTime ?? 0) - (job.executionStartTime ?? 0)}`)
  const preview = job.previewOutput
  if (preview !== null && preview !== undefined) {
    const url = `${base}/comfyui/media?file=${encodeURIComponent(preview.filename)}&subfolder=${encodeURIComponent(preview.subfolder ?? '')}&type=${encodeURIComponent(preview.type ?? 'output')}`
    console.log(`URL=${url}`)
    const img = await (await fetch(url, { headers: origin })).arrayBuffer()
    require('fs').writeFileSync('D:/dsh-comfyui/cg-portrait-16x9.png', Buffer.from(img))
    console.log(`saved bytes=${Buffer.from(img).length}`)
  }
  process.exit(job.status === 'completed' ? 0 : 1)
}
console.log('TIMEOUT waiting for job')
process.exit(1)
