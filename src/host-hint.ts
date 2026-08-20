/**
 * Host hint: remember the origin browsers use to reach this web server, so
 * generated media URLs (tool results) point at an address the requesting
 * browser can actually load. The hint is derived from the Host header and the
 * Referer of every /comfyui/* request the browser makes: a panel load records
 * the Host header before any generation happens, and a media <img> fetch
 * carries the page's own URL in Referer — which recovers the external origin
 * even when an earlier generated URL already fell back to loopback.
 *
 * Loopback origins (127.0.0.1/localhost) never displace an already-seen
 * external origin: server-side tool calls and local debug requests must not
 * overwrite the address remote browsers use.
 */
import type { IncomingMessage } from 'node:http'
import { networkInterfaces } from 'node:os'

/**
 * The server's own first reachable LAN origin (e.g. http://192.168.1.5:3080),
 * used as the media-URL fallback before loopback. Picks the first non-internal
 * IPv4 that is not loopback or link-local. Returns undefined when no such
 * address exists (no network interface), in which case callers keep loopback.
 */
export function detectLanOrigin(port: number): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    if (list === undefined) continue
    for (const net of list) {
      if (net.family !== 'IPv4' || net.internal) continue
      const ip = net.address
      if (ip === '127.0.0.1' || ip.startsWith('169.254.')) continue
      return `http://${ip}:${port}`
    }
  }
  return undefined
}

export interface HostHint {
  /** Record the origin of one request (Host header + Referer + forwarded proto). */
  record(request: IncomingMessage): void
  /** The best-known origin: the last external one, else the last loopback one, else undefined. */
  origin(): string | undefined
}

/** Whether a Host header value names the local machine. */
function isLoopback(host: string): boolean {
  const bare = host.replace(/^\[/, '').replace(/\].*$/, '').replace(/:\d+$/, '').toLowerCase()
  return bare === '127.0.0.1' || bare === 'localhost' || bare === '::1'
}

/** Extract the http(s) origin of a Referer header value, or undefined. */
function parseRefererOrigin(referer: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(referer) ? referer[0] : referer
  if (typeof raw !== 'string' || raw === '') return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return `${url.protocol}//${url.host}`.replace(/\/+$/, '')
  } catch {
    return undefined
  }
}

/** Whether an origin string names the local machine. */
function isLoopbackOrigin(origin: string): boolean {
  const match = origin.match(/^https?:\/\/([^/:]+)/)
  return match === null || isLoopback(match[1] ?? '')
}

/** Create a host hint accumulator. */
export function createHostHint(): HostHint {
  let loopback: string | undefined
  let external: string | undefined
  return {
    record(request) {
      const host = request.headers.host
      const forwarded = request.headers['x-forwarded-proto']
      const proto = typeof forwarded === 'string' ? (forwarded.split(',')[0]?.trim() || 'http') : 'http'
      const hostOrigin = typeof host === 'string' && host !== ''
        ? `${proto}://${host}`.replace(/\/+$/, '')
        : undefined
      const refererOrigin = parseRefererOrigin(request.headers.referer)
      const externalSignal = (hostOrigin !== undefined && !isLoopbackOrigin(hostOrigin))
        ? hostOrigin
        : (refererOrigin !== undefined && !isLoopbackOrigin(refererOrigin) ? refererOrigin : undefined)
      if (externalSignal !== undefined) external = externalSignal
      if (hostOrigin !== undefined && isLoopbackOrigin(hostOrigin)) loopback = hostOrigin
    },
    origin() {
      return external ?? loopback
    },
  }
}
