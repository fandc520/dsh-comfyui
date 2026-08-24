/**
 * The ComfyUI settings page (settings.section, id 'comfyui'). Reads the
 * redacted host config over /comfyui/config, persists edits through the same
 * route, and probes the server over /comfyui/test.
 */
import { createElement as h, useEffect, useState } from 'react'
import { getJson, postJson } from './api.ts'
import { getLang, setLang, type Lang } from './i18n.ts'

export interface ComfyUISettingsProps {
  t: (key: string, ...rest: unknown[]) => string
  close: () => void
}

interface ConfigView {
  baseUrl: string
  apiKeyEnv: string
  hasApiKey: boolean
  timeoutMs: number
  pollIntervalMs: number
  maxMediaItems: number
  mediaHost: string
  writable: boolean
}

interface TestResult {
  ok: boolean
  text: string
}

/** The ComfyUI settings page component. */
export function ComfyUISettings({ t }: ComfyUISettingsProps): ReturnType<typeof h> {
  const [config, setConfig] = useState<ConfigView | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKeyEnv, setApiKeyEnv] = useState('')
  const [mediaHost, setMediaHost] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'failed'>('idle')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [lang, setLangState] = useState<Lang>(getLang())

  useEffect(() => {
    let cancelled = false
    getJson<ConfigView>('/comfyui/config').then((view) => {
      if (cancelled) return
      setConfig(view)
      setBaseUrl(view.baseUrl)
      setApiKeyEnv(view.apiKeyEnv)
      setMediaHost(view.mediaHost ?? '')
    }).catch((error: unknown) => {
      if (cancelled) return
      setLoadError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      cancelled = true
    }
  }, [])

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaveState('idle')
    try {
      const payload = (await postJson('/comfyui/config', { patch: { baseUrl, apiKeyEnv, mediaHost } })) as { config?: ConfigView }
      if (payload.config !== undefined) {
        setConfig(payload.config)
        setBaseUrl(payload.config.baseUrl)
        setApiKeyEnv(payload.config.apiKeyEnv)
        setMediaHost(payload.config.mediaHost ?? '')
      }
      setSaveState('saved')
    } catch (error) {
      setSaveState('failed')
      setTestResult({ ok: false, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setSaving(false)
    }
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const payload = (await postJson('/comfyui/test', {})) as { ok: boolean; version?: string; latencyMs?: number; error?: string }
      if (payload.ok === true) {
        setTestResult({ ok: true, text: t('testOk', { version: payload.version ?? 'unknown', ms: payload.latencyMs ?? 0 }) })
      } else {
        setTestResult({ ok: false, text: t('testFail', { message: payload.error ?? 'unknown error' }) })
      }
    } catch (error) {
      setTestResult({ ok: false, text: t('testFail', { message: error instanceof Error ? error.message : String(error) }) })
    } finally {
      setTesting(false)
    }
  }

  if (loadError !== null) {
    return h('div', { className: 'dsc-card' },
      h('div', { className: 'dsc-meta' }, `${t('saveFailed')}: ${loadError}`),
    )
  }
  if (config === null) {
    return h('div', { className: 'dsc-card' }, h('div', { className: 'dsc-meta' }, '…'))
  }

  return h('div', { className: 'dsc-form' },
    h('div', { className: 'dsc-meta' }, t('settingsDesc')),
    h('div', { className: 'dsc-field' },
      h('label', null, t('language')),
      h('select', {
        className: 'dsc-input',
        value: lang,
        onChange: (event: { target: { value: string } }) => {
          const next: Lang = event.target.value === 'en' ? 'en' : 'zh'
          setLangState(next)
          setLang(next)
          window.location.reload()
        },
      },
        h('option', { value: 'zh' }, '中文'),
        h('option', { value: 'en' }, 'English'),
      ),
      h('div', { className: 'dsc-hint' }, t('languageHint')),
    ),
    h('div', { className: 'dsc-field' },
      h('label', null, t('baseUrl')),
      h('input', {
        value: baseUrl,
        placeholder: 'http://127.0.0.1:8188',
        onChange: (event: { target: { value: string } }) => { setBaseUrl(event.target.value); setSaveState('idle') },
      }),
      h('div', { className: 'dsc-hint' }, t('baseUrlHint')),
    ),
    h('div', { className: 'dsc-field' },
      h('label', null, t('apiKeyEnv')),
      h('input', {
        value: apiKeyEnv,
        placeholder: 'COMFYUI_API_KEY',
        onChange: (event: { target: { value: string } }) => { setApiKeyEnv(event.target.value); setSaveState('idle') },
      }),
      h('div', { className: 'dsc-hint' }, `${t('apiKeyEnvHint')} — ${config.hasApiKey ? t('hasApiKey') : t('noApiKey')}`),
    ),
    h('div', { className: 'dsc-field' },
      h('label', null, t('mediaHost')),
      h('input', {
        value: mediaHost,
        placeholder: 'http://192.168.1.5:3080',
        onChange: (event: { target: { value: string } }) => { setMediaHost(event.target.value); setSaveState('idle') },
      }),
      h('div', { className: 'dsc-hint' }, t('mediaHostHint')),
    ),
    h('div', { className: 'dsc-row' },
      h('button', { className: 'dsc-btn', disabled: saving || !config.writable, onClick: () => void save() }, t('save')),
      h('button', { className: 'dsc-btn', disabled: testing, onClick: () => void test() }, testing ? t('testing') : t('test')),
      saveState === 'saved' ? h('span', { className: 'dsc-note' }, t('saved')) : null,
      saveState === 'failed' ? h('span', { className: 'dsc-note' }, t('saveFailed')) : null,
    ),
    testResult !== null
      ? h('div', { className: testResult.ok ? 'dsc-note' : 'dsc-note', style: testResult.ok ? { color: '#22c55e' } : { color: '#ef4444' } }, testResult.text)
      : null,
    config.writable ? null : h('div', { className: 'dsc-hint' }, t('configNotWritable')),
  )
}
