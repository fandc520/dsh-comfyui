/**
 * Shared open/close/tab state for the ComfyUI panel. The overlay occupant
 * and the session-header trigger are separate registrations in one bundle,
 * so they coordinate through this module-level store plus useSyncExternalStore.
 */
import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()
let open = false
let tab: PanelTab = 'workflows'
let assetFilter = ''

function emit(): void {
  for (const listener of listeners) listener()
}

export type PanelTab = 'workflows' | 'assets' | 'queue'

export const panelStore = {
  isOpen: () => open,
  toggle: () => {
    open = !open
    emit()
  },
  open: () => {
    if (!open) {
      open = true
      emit()
    }
  },
  close: () => {
    if (open) {
      open = false
      emit()
    }
  },
  getTab: () => tab,
  setTab: (next: PanelTab) => {
    if (tab !== next) {
      tab = next
      emit()
    }
  },
  getAssetFilter: () => assetFilter,
  setAssetFilter: (name: string) => {
    if (assetFilter !== name) {
      assetFilter = name
      emit()
    }
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}

/** React hook reading the panel open state. */
export function usePanelOpen(): boolean {
  return useSyncExternalStore(panelStore.subscribe, panelStore.isOpen, panelStore.isOpen)
}

/** React hook reading the active panel tab. */
export function usePanelTab(): PanelTab {
  return useSyncExternalStore(panelStore.subscribe, panelStore.getTab, panelStore.getTab)
}
