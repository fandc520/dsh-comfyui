/**
 * Connection probe + reminder toast. Opening the panel used to give zero
 * feedback when ComfyUI was down: the workflows/queue tabs just stayed empty
 * with no explanation. The header trigger now fires a real backend probe
 * (POST /comfyui/test → the host connects to the configured ComfyUI server —
 * local port or remote URL alike); when it fails, a fixed toast at the top of
 * the page tells the user to start ComfyUI or fix the server address.
 *
 * A failed probe must NOT close the panel: the workflow library, skill packs
 * and preset import/export live in the plugin's own store and work offline, so
 * taking the panel away on failure made a perfectly usable click look dead
 * (the reported bug). Only the ComfyUI-backed tabs (assets/queue) stay empty,
 * and the toast is the reminder for that. The probe never blocks the panel:
 * it opens immediately, the toast settles whenever the probe answers.
 */
import { createElement as h, useSyncExternalStore } from 'react'
import { postJson } from './api.ts'

export interface ConnectionToastProps {
  t: (key: string, ...rest: unknown[]) => string
}

/** hidden → probing (delayed fade-in) → fail (sticky) / ok (auto-hide). */
type ConnStatus = 'hidden' | 'probing' | 'fail' | 'ok'

interface ConnState {
  status: ConnStatus
  /** Raw failure reason from the /comfyui/test route. */
  message?: string
  version?: string
  latencyMs?: number
}

const listeners = new Set<() => void>()
let state: ConnState = { status: 'hidden' }
/** Dedupe concurrent probes (rapid trigger clicks). */
let inFlight: Promise<void> | null = null
/** Skip re-probing while a "connected" verdict is still fresh. */
let lastOkAt = 0
/** The ok toast only shows on fail→ok transitions, never on healthy opens. */
let hadFailure = false
let okHideTimer: ReturnType<typeof setTimeout> | null = null

function emit(): void {
  for (const listener of listeners) listener()
}

function setState(next: ConnState): void {
  state = next
  emit()
}

function clearOkTimer(): void {
  if (okHideTimer !== null) {
    clearTimeout(okHideTimer)
    okHideTimer = null
  }
}

/** Close button on the toast; also ends the transient ok feedback early. */
export function dismissConnectionToast(): void {
  clearOkTimer()
  if (state.status !== 'hidden') setState({ status: 'hidden' })
}

/**
 * Probe the ComfyUI server through the host and surface the result as toast
 * state. A success within the last 30s skips the round-trip entirely, so
 * healthy repeated panel opens do not hammer the server; failures always
 * re-probe on the next open (the user may have just started ComfyUI).
 */
export function probeConnection(): Promise<void> {
  if (inFlight !== null) return inFlight
  if (Date.now() - lastOkAt < 30_000) return Promise.resolve()
  // A visible fail toast stays up (and keeps its reason) while re-checking;
  // only upgrade hidden → probing so the check itself never flashes red.
  if (state.status !== 'fail') {
    clearOkTimer()
    setState({ status: 'probing' })
  }
  inFlight = (async () => {
    try {
      const payload = (await postJson('/comfyui/test', {})) as {
        ok?: boolean
        version?: string
        latencyMs?: number
        error?: string
      }
      if (payload.ok === true) {
        lastOkAt = Date.now()
        const recovered = hadFailure
        hadFailure = false
        if (recovered) {
          // Come-back feedback: a previous failure just resolved.
          setState({ status: 'ok', version: payload.version, latencyMs: payload.latencyMs })
          clearOkTimer()
          okHideTimer = setTimeout(dismissConnectionToast, 4000)
        } else {
          setState({ status: 'hidden' })
        }
      } else {
        hadFailure = true
        setState({ status: 'fail', message: payload.error ?? 'unknown error' })
        // Keep the panel open: the local workflow library still works offline,
        // and closing here made the click look like it did nothing. The sticky
        // toast is the reminder instead.
      }
    } catch (error) {
      hadFailure = true
      setState({ status: 'fail', message: error instanceof Error ? error.message : String(error) })
      // Same as above: a dead backend must not take the panel away.
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

function getConnState(): ConnState {
  return state
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Fixed top-center status toast; mounted next to the header trigger so it
 * renders (and can be dismissed) even when the panel is closed again. The
 * probing variant fades in after a short CSS delay, so a fast successful
 * probe never paints anything. */
export function ConnectionToast({ t }: ConnectionToastProps): ReturnType<typeof h> | null {
  const conn = useSyncExternalStore(subscribe, getConnState, getConnState)
  if (conn.status === 'hidden') return null
  return h('div', { className: `dsc-conn-toast dsc-conn-toast--${conn.status}`, role: 'status' },
    h('span', { className: 'dsc-conn-toast-dot', 'aria-hidden': true }),
    h('div', { className: 'dsc-conn-toast-body' },
      conn.status === 'fail'
        ? h('div', { className: 'dsc-conn-toast-body-inner' },
            h('div', { className: 'dsc-conn-toast-title' }, t('connFailTitle')),
            h('div', { className: 'dsc-conn-toast-text' }, t('connFailBody', { message: conn.message ?? '' })),
          )
        : h('div', { className: 'dsc-conn-toast-title' },
            conn.status === 'probing'
              ? t('connChecking')
              : t('connOk', { version: conn.version ?? 'unknown', ms: conn.latencyMs ?? 0 }),
          ),
    ),
    h('button', {
      className: 'dsc-conn-toast-close',
      'aria-label': t('close'),
      onClick: dismissConnectionToast,
    }, '✕'),
  )
}
