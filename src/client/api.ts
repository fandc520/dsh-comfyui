/** Same-origin JSON helpers shared by the settings page and the panel. */
export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return (await response.json()) as T
}

/**
 * GET a list endpoint and return the array under `key`. Routes report failure
 * as HTTP 200 `{ ok: false, error }`, so a plain getJson hands the caller
 * `undefined` for the list — which crashed the whole panel on `.length` inside
 * the slot error boundary, i.e. "click does nothing" (Issue #5). Throwing the
 * route's error instead lets the caller show it next to the section.
 */
export async function getList<T>(url: string, key: string): Promise<T[]> {
  const data = await getJson<Record<string, unknown>>(url)
  const list = data[key]
  if (Array.isArray(list)) return list as T[]
  throw new Error(typeof data.error === 'string' ? data.error : `unexpected response from ${url}`)
}

export async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(payload.error ?? `HTTP ${response.status}`)
  }
  return response.json() as Promise<unknown>
}

/** POST raw bytes (an imported file) and read the JSON reply. */
export async function postRaw(url: string, bytes: ArrayBuffer): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(payload.error ?? `HTTP ${response.status}`)
  }
  return response.json() as Promise<unknown>
}
