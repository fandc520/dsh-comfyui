/**
 * dsh-comfyui client half: registers the comfyui_run tool card and the
 * ComfyUI settings page. Registered through slots.inject so contributions
 * wait on the real slot declarations and unwind with this plugin's fiber.
 */
import { createElement as h } from 'react'
import { makeT, getLang } from './i18n.ts'
import { ComfyUICard, type ComfyUICardProps } from './card.tsx'
import { ComfyUISettings, type ComfyUISettingsProps } from './settings.tsx'
import { ComfyUIPanel, type ComfyUIPanelProps } from './panel.tsx'
import { ComfyUITrigger, type ComfyUITriggerProps } from './trigger.tsx'
import { injectStyles } from './styles.ts'

export const name = 'dsh-comfyui'
export const inject = ['slots']

interface SlotsService {
  inject(slot: string, register: () => unknown): void
  register(meta: Record<string, unknown>, component: unknown): unknown
}

interface ComfyUIClientContext {
  effect(callback: () => unknown, label?: string): void
  slots: SlotsService
}

export function apply(ctx: ComfyUIClientContext): void {
  // Plugin-local i18n: language comes from localStorage (settings page), not
  // the host locale, so zh/en switching works without a host change.
  const t = makeT(getLang())
  ctx.effect(() => injectStyles(), 'dsh-comfyui: styles')

  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'comfyui_run' },
    (props: unknown) => h(ComfyUICard, { t, ...((props ?? {}) as Record<string, unknown>) } as unknown as ComfyUICardProps),
  ))

  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'comfyui_workflow' },
    (props: unknown) => h(ComfyUICard, { t, ...((props ?? {}) as Record<string, unknown>) } as unknown as ComfyUICardProps),
  ))

  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'comfyui', order: 30, label: () => t('settingsTitle') },
    (props: unknown) => h(ComfyUISettings, { t, ...((props ?? {}) as Record<string, unknown>) } as unknown as ComfyUISettingsProps),
  ))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'comfyui.panel', order: 20, label: () => t('panelTitle') },
    (props: unknown) => h(ComfyUIPanel, { t, ...((props ?? {}) as Record<string, unknown>) } as unknown as ComfyUIPanelProps),
  ))

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
    { name: 'conversation.session.header.actions', id: 'comfyui', order: 100, label: () => t('panelTitle') },
    (props: unknown) => h(ComfyUITrigger, { t, ...((props ?? {}) as Record<string, unknown>) } as unknown as ComfyUITriggerProps),
  ))
}
