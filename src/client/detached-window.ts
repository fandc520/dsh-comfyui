/**
 * Detached panel window: the panel can leave the DSH viewport and live in its
 * own operating-system window, which the user can drag anywhere on the screen —
 * including onto another display — instead of being clipped to the app window.
 *
 * Why a second React root instead of a portal or a moved DOM subtree: React 18
 * binds a root's delegated listeners to the document that owns the root
 * container at mount time. A subtree rendered into another document draws but
 * never receives synthetic events, so every button inside the panel goes dead.
 * Mounting a fresh root in the target document puts the listeners on that
 * document, and the panel behaves exactly as it does inside the app.
 *
 * Two channels, tried in order:
 * 1. `window.open` under a fixed frame name — a real OS window. A host that
 *    whitelists this name in its windowOpenHandler (desktop-side patch) gets a
 *    real window; elsewhere a browser only gets here when popups are allowed.
 *    The installed DSH desktop app 0.2.1-rc.3 (Electron 44) denies every
 *    `window.open` and ships no such whitelist, so in that host both channels
 *    fail and `panel.tsx` falls back to an in-app floating panel.
 * 2. Document Picture-in-Picture — an always-on-top mini window. Chromium builds
 *    without a native PiP window implementation (Electron 44) resolve
 *    `requestWindow` and then tear the window down within ~200ms, so the result
 *    is only trusted after a liveness check. Some builds never settle the
 *    promise at all; those are the desktop shell, detected and skipped up front
 *    so a normal browser keeps the original unbounded await.
 */
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { DETACHED_DOCUMENT_CSS } from './styles.ts'

/** Frame name a desktop host patch would have to whitelist. */
export const DETACHED_WINDOW_NAME = 'dsh-comfyui-panel'

/** Id of the mount point created inside the detached document. */
const ROOT_ID = 'dsh-comfyui-detached-root'

/** How long a Document Picture-in-Picture window must survive to count as real. */
const PIP_SETTLE_MS = 280

const MIN_WIDTH = 340
const MAX_WIDTH = 560
const MIN_HEIGHT = 420
const MAX_HEIGHT = 980

/** Which channel produced the window. */
export type DetachedKind = 'popup' | 'pip'

/** A live detached window plus the mount point created inside it. */
export interface DetachedSession {
  win: Window
  container: HTMLElement
  kind: DetachedKind
}

let session: DetachedSession | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function setSession(next: DetachedSession | null): void {
  session = next
  emit()
}

/** The detached window, or null while the panel lives in the app viewport. */
export function getDetachedSession(): DetachedSession | null {
  return session
}

/** Subscribe to attach/detach transitions (useSyncExternalStore compatible). */
export function subscribeDetached(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Size for the detached window: a comfortable panel, never larger than the
 * app window it came from. */
function detachedWindowSize(): { width: number; height: number } {
  const width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth * 0.42)))
  const height = Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, window.innerHeight * 0.86)))
  return { width, height }
}

/** Copy the app's stylesheets so the panel keeps its theme inside the detached
 * document (slot styles, plugin styles, and the host's CSS variables). */
function copyStyleSheets(source: Document, target: Document): void {
  for (const node of Array.from(source.head.querySelectorAll('style, link[rel="stylesheet"]'))) {
    target.head.append(node.cloneNode(true))
  }
  try {
    const adopted = source.adoptedStyleSheets
    if (adopted.length > 0) target.adoptedStyleSheets = [...adopted]
  } catch {
    // cross-document adoption rejected — the cloned <style>/<link> nodes remain
  }
}

/** Copy theme markers (`dark`, `desktop`, background classes…) so host tokens
 * resolve in the detached document exactly as they do in the app. */
function copyAttributes(source: Element | null, target: Element | null): void {
  if (source === null || target === null) return
  for (const attr of Array.from(source.attributes)) {
    try {
      target.setAttribute(attr.name, attr.value)
    } catch {
      // read-only attribute — not needed for theming
    }
  }
}

/** Turn a blank detached document into one the panel can mount into: same
 * theme, same base URL for media, panel layout reset to fill the window. */
function prepareDocument(win: Window, title: string): HTMLElement {
  const target = win.document
  copyAttributes(document.documentElement, target.documentElement)
  copyAttributes(document.body, target.body)
  copyStyleSheets(document, target)
  const head = target.head ?? target.documentElement
  // Relative media URLs (/comfyui/media/…) must resolve against the app origin;
  // the detached document inherits that origin but not its base path.
  const base = target.createElement('base')
  base.href = document.baseURI
  head.prepend(base)
  const style = target.createElement('style')
  style.id = 'dsh-comfyui-detached-styles'
  style.textContent = DETACHED_DOCUMENT_CSS
  head.append(style)
  target.title = title
  const container = target.createElement('div')
  container.id = ROOT_ID
  ;(target.body ?? target.documentElement).append(container)
  return container
}

/** Clear the session when the user closes the window themselves. */
function watchWindow(win: Window): void {
  win.addEventListener('pagehide', () => {
    if (session !== null && session.win === win) setSession(null)
  })
}

function openPopup(title: string): DetachedSession | null {
  const { width, height } = detachedWindowSize()
  const left = Math.round(Math.max(0, window.screenX + 48))
  const top = Math.round(Math.max(0, window.screenY + 48))
  let win: Window | null = null
  try {
    win = window.open('', DETACHED_WINDOW_NAME, `popup=yes,width=${width},height=${height},left=${left},top=${top}`)
  } catch {
    return null
  }
  if (win === null || win.closed) return null
  try {
    watchWindow(win)
    const container = prepareDocument(win, title)
    return { win, container, kind: 'popup' }
  } catch {
    // Cross-origin: the opener cannot touch the document, so it cannot host the
    // panel. Drop the window instead of leaving a blank tab behind.
    try {
      win?.close()
    } catch {
      // already gone
    }
    return null
  }
}

interface PictureInPictureApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>
}

function pictureInPictureApi(): PictureInPictureApi | null {
  const api = (window as unknown as { documentPictureInPicture?: PictureInPictureApi }).documentPictureInPicture
  return api !== undefined && typeof api.requestWindow === 'function' ? api : null
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

async function openPictureInPicture(title: string): Promise<DetachedSession | null> {
  const api = pictureInPictureApi()
  if (api === null) return null
  const { width, height } = detachedWindowSize()
  // Unbounded on purpose: this is the original browser behaviour, and a slow
  // hand-over must not be turned into a failure (that would close a window the
  // user was about to get). The desktop shell never reaches this function —
  // `attachDetached` detects it first — so the only host that can hang here is
  // one with no usable PiP implementation at all.
  const win = await api.requestWindow({ width, height }).catch(() => null)
  if (win === null) return null
  if (win.closed) return null
  let container: HTMLElement
  try {
    watchWindow(win)
    container = prepareDocument(win, title)
  } catch {
    // Cross-origin or a document we cannot mount into: drop the window.
    try {
      win.close()
    } catch {
      // already gone
    }
    return null
  }
  // Electron 44 accepts the request and destroys the window moments later: a
  // document with no layout or a closed window means this build has no real PiP
  // window, and the caller should fall back to "stay in the app viewport".
  await delay(PIP_SETTLE_MS)
  try {
    if (win.closed || win.document.documentElement.clientWidth <= 0) {
      try {
        win.close()
      } catch {
        // already gone
      }
      return null
    }
  } catch {
    return null
  }
  return { win, container, kind: 'pip' }
}

/** True inside the DSH desktop shell. Its windowOpenHandler denies every
 * `window.open`, and that Electron build tears a Document PiP window down
 * within ~200ms (while sometimes never settling the request). Skipping the PiP
 * channel here both avoids a wait that cannot produce a window and keeps the
 * ordinary browser path exactly as it was. */
function isDesktopShell(): boolean {
  const desktop = (window as unknown as { dshDesktop?: unknown }).dshDesktop
  return desktop !== undefined
    || window.location.protocol === 'dsh-app:'
    || navigator.userAgent.includes('Electron')
}

/** Move the panel into its own window. Resolves null when the environment
 * refuses both channels (popups blocked and no usable PiP window). */
export async function attachDetached(title: string): Promise<DetachedSession | null> {
  if (session !== null) return session
  const popup = openPopup(title)
  if (popup !== null) {
    setSession(popup)
    return popup
  }
  if (isDesktopShell()) return null
  let pip: DetachedSession | null = null
  try {
    pip = await openPictureInPicture(title)
  } catch {
    // A host that throws instead of reporting unavailability must not take the
    // completion notice down with it.
    pip = null
  }
  if (pip !== null) {
    setSession(pip)
    return pip
  }
  return null
}

/** Put the panel back into the app viewport and close the extra window. */
export function dockDetached(): void {
  const current = session
  if (current === null) return
  setSession(null)
  try {
    if (!current.win.closed) current.win.close()
  } catch {
    // window is already gone
  }
}

/** Mount the panel view inside the detached document; returns its unmount. */
export function renderIntoSession(target: DetachedSession, element: ReactElement): () => void {
  const root = createRoot(target.container)
  root.render(element)
  return () => {
    // Skip unmounting once the window is gone: its nodes no longer exist and
    // React's cleanup would throw on the dead document.
    if (!target.win.closed) root.unmount()
  }
}

/** Attach a document-level listener in the app document *and* in the detached
 * window, so panel shortcuts (lightbox keys, hover-paste) keep working after a
 * detach. Returns the matching detach function. */
export function onPanelDocuments<K extends keyof DocumentEventMap>(
  type: K,
  handler: (event: DocumentEventMap[K]) => void,
  options?: AddEventListenerOptions,
): () => void {
  const docs: Document[] = [document]
  if (session !== null) {
    try {
      docs.push(session.win.document)
    } catch {
      // window closed between attach and effect
    }
  }
  const listener = handler as unknown as EventListener
  for (const doc of docs) doc.addEventListener(type, listener, options)
  return () => {
    for (const doc of docs) doc.removeEventListener(type, listener, options)
  }
}
