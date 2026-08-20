/** Full-frame scan of every session log for message events missing an `id` (read-only). */
import { zstdDecompressSync } from 'node:zlib'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ZSTD_MAGIC = 0xFD2FB528

function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`bad magic at ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

const root = 'C:/Users/fandc/.dsh/sessions'
const files = []
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith('.jsonl.zstd') && !entry.name.includes('.bak')) files.push(full)
  }
}
walk(root)

for (const file of files) {
  const bytes = readFileSync(file)
  const { frames, tornStart } = scanFrames(bytes)
  let text = ''
  for (const frame of frames) {
    text += zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString('utf8')
  }
  const lines = text.split('\n')
  let bad = 0
  let sample = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const type = typeof event.type === 'string' ? event.type : ''
    const data = typeof event.data === 'object' && event.data !== null ? event.data : {}
    // user/tool-result events carry the message as `data`; assistant events nest it in `data.message`.
    const message = typeof data.message === 'object' && data.message !== null ? data.message : data
    if (type.includes('message') && (message.id === undefined || message.id === null || message.id === '')) {
      bad++
      if (sample === null) sample = { line: i + 1, type, source: message.source, text: JSON.stringify(message).slice(0, 160) }
    }
  }
  console.log(`FILE ${file}`)
  console.log(`  compressed=${bytes.length} frames=${frames.length} torn=${tornStart ?? '-'} textBytes=${text.length} lines=${lines.length} missingId=${bad}`)
  if (sample !== null) console.log(`  BAD line ${sample.line}: type=${sample.type} source=${JSON.stringify(sample.source)} data=${sample.text}`)
}
