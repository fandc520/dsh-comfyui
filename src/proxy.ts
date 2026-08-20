/**
 * Media proxy: serves generated ComfyUI files to the browser through the
 * same-origin route /comfyui/media?prompt=&node=&index=, so the client never
 * talks to the ComfyUI server directly (no CORS, no mixed content, no key in
 * the browser) and remote installs work unchanged.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { errorMessage, sendJson } from './http.js'
import type { ComfyUIRuntime } from './tools.js'

/**
 * Mount the media proxy route on the host web server.
 * @returns the disposer, or undefined when no web server is present.
 */
export function mountComfyUIProxy(ctx: Context, runtime: ComfyUIRuntime): (() => void) | undefined {
  const webServer = ctx.get('webServer') as {
    register(route: { kind: string; path: string; handler(request: IncomingMessage, response: ServerResponse): void | Promise<void> }): () => void
  } | undefined
  if (webServer === undefined) return undefined

  return webServer.register({
    kind: 'exact',
    path: '/comfyui/media',
    handler: async (request, response) => {
      runtime.hostHint.record(request)
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendJson(response, 405, { error: 'method not allowed' })
        return
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      const prompt = url.searchParams.get('prompt')
      const node = url.searchParams.get('node')
      const indexText = url.searchParams.get('index')
      const file = url.searchParams.get('file')
      if (file !== null) {
        // Direct file lookup (e.g. job preview_output thumbnails).
        const ref = { filename: file, subfolder: url.searchParams.get('subfolder') ?? '', type: url.searchParams.get('type') ?? 'output' }
        try {
          const client = runtime.createClient(await runtime.getApiKey())
          const { bytes, contentType } = await client.fetchView(ref)
          response.writeHead(200, {
            'content-type': contentType,
            'content-length': bytes.byteLength,
            'cache-control': 'private, max-age=3600',
          })
          if (request.method === 'HEAD') {
            response.end()
            return
          }
          response.end(Buffer.from(bytes))
          return
        } catch (error) {
          sendJson(response, 502, { error: errorMessage(error) })
          return
        }
      }
      if (prompt === null || node === null || indexText === null) {
        sendJson(response, 400, { error: 'prompt, node, and index query parameters are required (or file + subfolder + type)' })
        return
      }
      const index = Number(indexText)
      if (!Number.isInteger(index) || index < 0) {
        sendJson(response, 400, { error: 'index must be a non-negative integer' })
        return
      }
      try {
        const client = runtime.createClient(await runtime.getApiKey())
        const entry = await client.getHistory(prompt)
        const outputs = entry?.outputs ?? {}
        const nodeOutput = outputs[node]
        const collections: Array<Array<{ filename: string; subfolder: string; type: string }> | undefined> = [
          nodeOutput?.images,
          nodeOutput?.videos,
          nodeOutput?.gifs,
        ]
        const ref = collections
          .flatMap((items) => items ?? [])
          [index]
        if (ref === undefined) {
          sendJson(response, 404, { error: `no media item ${node}[${index}] for prompt ${prompt} (history may be evicted)` })
          return
        }
        const { bytes, contentType } = await client.fetchView(ref)
        response.writeHead(200, {
          'content-type': contentType,
          'content-length': bytes.byteLength,
          'cache-control': 'private, max-age=3600',
        })
        if (request.method === 'HEAD') {
          response.end()
          return
        }
        response.end(Buffer.from(bytes))
      } catch (error) {
        sendJson(response, 502, { error: errorMessage(error) })
      }
    },
  })
}
