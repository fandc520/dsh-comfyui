/**
 * Inline players for generated video/audio in chat replies.
 *
 * The model shows results by pasting Markdown into its reply (CLAUDE.md
 * contract 18). Images embed natively, but dsh's chat Markdown has no video or
 * audio syntax and renders raw HTML as literal text, so a video/audio result
 * can only be a link there. This module watches the page and, after every
 * link to this plugin's own `/comfyui/media` route whose file is a video or
 * audio file, inserts a native <video>/<audio> player.
 *
 * It only ever ADDS sibling nodes next to dsh-rendered links — it never moves
 * or removes dsh's own nodes — so React's reconciliation of the message keeps
 * working. Streaming re-renders and dsh updates simply trigger a re-scan: a
 * player is added only when the link is not already followed by its player,
 * and players whose link has gone are removed. The plugin's own UI (card file
 * links, panel) is skipped. Everything is undone when the plugin unloads.
 */

const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac'])
const PLAYER_CLASS = 'dsc-inline-player'

/** The player kind for a /comfyui/media link, or undefined for anything else. */
function mediaKind(href: string): 'video' | 'audio' | undefined {
  let url: URL
  try {
    url = new URL(href, window.location.href)
  } catch {
    return undefined
  }
  if (!url.pathname.endsWith('/comfyui/media')) return undefined
  const file = url.searchParams.get('file') ?? ''
  const dot = file.lastIndexOf('.')
  if (dot < 0) return undefined
  const ext = file.slice(dot + 1).toLowerCase()
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio'
  return undefined
}

function isPlayerFor(node: Element | null, href: string): boolean {
  return node !== null && node.classList.contains(PLAYER_CLASS) && node.getAttribute('data-src') === href
}

function makePlayer(kind: 'video' | 'audio', href: string): HTMLElement {
  const wrap = document.createElement('span')
  wrap.className = `${PLAYER_CLASS} ${PLAYER_CLASS}--${kind}`
  wrap.setAttribute('data-src', href)
  const player = document.createElement(kind)
  player.src = href
  player.controls = true
  player.preload = 'metadata'
  wrap.appendChild(player)
  return wrap
}

function scan(): void {
  // Players whose link was re-rendered away (or changed) go first.
  for (const player of Array.from(document.querySelectorAll<HTMLElement>(`.${PLAYER_CLASS}`))) {
    const prev = player.previousElementSibling
    const src = player.getAttribute('data-src')
    if (!(prev instanceof HTMLAnchorElement) || src === null || prev.href !== src) player.remove()
  }
  for (const link of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/comfyui/media"]'))) {
    // Our own card and panel render their own media UI.
    if (link.closest('[class^="dsc-"], [class*=" dsc-"]') !== null) continue
    const kind = mediaKind(link.href)
    if (kind === undefined) continue
    if (isPlayerFor(link.nextElementSibling, link.href)) continue
    link.after(makePlayer(kind, link.href))
  }
}

/** Start watching the page; returns the disposer that stops and cleans up. */
export function installInlineMedia(): () => void {
  let frame: number | undefined
  const schedule = (): void => {
    if (frame !== undefined) return
    frame = window.requestAnimationFrame(() => {
      frame = undefined
      scan()
    })
  }
  const observer = new MutationObserver((mutations) => {
    // Our own insertions/removals also fire; skip batches made only of them.
    const foreign = mutations.some((mutation) =>
      [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)].some((node) =>
        !(node instanceof HTMLElement && node.classList.contains(PLAYER_CLASS))))
    if (foreign) schedule()
  })
  observer.observe(document.body, { childList: true, subtree: true })
  schedule()
  return () => {
    observer.disconnect()
    if (frame !== undefined) window.cancelAnimationFrame(frame)
    for (const player of Array.from(document.querySelectorAll(`.${PLAYER_CLASS}`))) player.remove()
  }
}
