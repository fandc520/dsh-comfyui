/**
 * dsh-comfyui host configuration. The same schema drives the Loader entry
 * config (cordis.yml patch) and the settings page, so one shape covers both
 * doors into the same values.
 *
 * Fields the plugin reads at use time are `.volatile()`: since dsh 0.1.7 the
 * settings service only edits volatile fields (anything else fails with
 * "Plugin entry has no volatile fields", Issue #11), and the Loader commits a
 * volatile-only change into the running references without restarting the
 * plugin. `dataDir` / `maxAssets` / `outputDir` stay ordinary: the store is
 * built from them at startup, so a change there restarts the plugin.
 */
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  /** ComfyUI HTTP server base URL. */
  baseUrl: z.string().default('http://127.0.0.1:8188').volatile(),
  /** Environment-variable name of the optional API key (credentials ref). */
  apiKeyEnv: z.string().default('COMFYUI_API_KEY').volatile(),
  /** Per-request connect/read timeout for the ComfyUI HTTP client. */
  connectTimeoutMs: z.number().min(1_000).max(60_000).default(10_000).volatile(),
  /** How long a synchronous generation (or background job) waits for workflow completion. */
  timeoutMs: z.number().min(5_000).max(3_600_000).default(900_000).volatile(),
  /** History polling interval while waiting for completion. */
  pollIntervalMs: z.number().min(200).max(10_000).default(1_000).volatile(),
  /** Max media items returned per completed workflow. */
  maxMediaItems: z.number().min(1).max(50).default(12).volatile(),
  /** Max bytes the media proxy streams for one file. */
  maxMediaBytes: z.number().min(64 * 1024).max(512 * 1024 * 1024).default(64 * 1024 * 1024).volatile(),
  /** Directory for plugin data (workflow library, asset index); empty means DSH_HOME/data/dsh-comfyui. */
  dataDir: z.string().default(''),
  /** Max asset records kept in the asset index. */
  maxAssets: z.number().min(1).max(10_000).default(200),
  /** Directory holding the per-workflow skill packs. Empty = `<dataDir>/skills`.
   * Separate from `dataDir` on purpose: packs are documents a user may want on
   * another drive, in a synced folder, or under version control, while the
   * JSON state files belong with the rest of the plugin data. Must be absolute;
   * a relative value is ignored. */
  skillsDir: z.string().default('').volatile(),
  /** External base URL for generated media (e.g. http://192.168.1.5:3080). Empty = auto-detect the browser's request host, then http://127.0.0.1:<webServerPort>. */
  mediaHost: z.string().default('').volatile(),
  /** ComfyUI's output directory on this machine, used to delete asset files
   * from the panel. Empty = infer it from the file paths ComfyUI reports;
   * deletion falls back to removing the index record when neither works
   * (e.g. a ComfyUI running on another host). */
  outputDir: z.string().default(''),
  /** ComfyUI install root(s) on this machine (absolute paths). Multiple
   * entries are allowed because ComfyUI folders can be mapped/mounted (extra
   * models dirs, several installs, portable copies). The agent reads them to
   * locate ComfyUI files directly (workflows, models, the TTS-Audio-Suite
   * voice library) without guessing or asking the user. */
  comfyuiDirs: z.array(z.string()).default([]).volatile(),
})

export type Config = {
  /** ComfyUI HTTP server base URL. */
  baseUrl: string
  /** Environment-variable name of the optional API key (credentials ref). */
  apiKeyEnv: string
  /** Per-request connect/read timeout for the ComfyUI HTTP client. */
  connectTimeoutMs: number
  /** How long a synchronous generation waits for workflow completion. */
  timeoutMs: number
  /** History polling interval while waiting for completion. */
  pollIntervalMs: number
  /** Max media items returned per completed workflow. */
  maxMediaItems: number
  /** Max bytes the media proxy streams for one file. */
  maxMediaBytes: number
  /** Directory for plugin data (workflow library, asset index); empty means DSH_HOME/data/dsh-comfyui. */
  dataDir: string
  /** Max asset records kept in the asset index. */
  maxAssets: number
  /** Directory holding the per-workflow skill packs; empty = `<dataDir>/skills`. */
  skillsDir: string
  /** External base URL for generated media; empty auto-detects the request host. */
  mediaHost: string
  /** ComfyUI's output directory on this machine; empty infers it from reported file paths. */
  outputDir: string
  /** ComfyUI install root(s) on this machine; the agent uses them to locate files directly. */
  comfyuiDirs: string[]
}

/** The volatile-reference protocol shared across cosmokit copies (Symbol.for). */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** Read a config value that may be a volatile reference (dsh 0.1.7+) or a plain value (older hosts). */
function current(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && VOLATILE_WRITE in value) {
    return (value as unknown as { get(): unknown }).get()
  }
  return value
}

/**
 * Resolve the Loader's parsed entry config into the plain object the plugin
 * reads. Call again after `loader/volatile-update`: the references are the
 * same objects, now holding the new values.
 * @param raw - parsed entry config; fields may be volatile references.
 * @param defaultDataDir - data directory used when `dataDir` is empty.
 * @returns a fully populated plain config.
 */
export function resolveConfig(raw: Partial<Record<keyof Config, unknown>>, defaultDataDir: string): Config {
  const str = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback)
  const num = (value: unknown, fallback: number): number => (typeof value === 'number' ? value : fallback)
  const dataDir = str(current(raw.dataDir), '')
  const dirs = current(raw.comfyuiDirs)
  return {
    baseUrl: str(current(raw.baseUrl), 'http://127.0.0.1:8188'),
    apiKeyEnv: str(current(raw.apiKeyEnv), 'COMFYUI_API_KEY'),
    connectTimeoutMs: num(current(raw.connectTimeoutMs), 10_000),
    timeoutMs: num(current(raw.timeoutMs), 900_000),
    pollIntervalMs: num(current(raw.pollIntervalMs), 1_000),
    maxMediaItems: num(current(raw.maxMediaItems), 12),
    maxMediaBytes: num(current(raw.maxMediaBytes), 64 * 1024 * 1024),
    dataDir: dataDir !== '' ? dataDir : defaultDataDir,
    maxAssets: num(current(raw.maxAssets), 200),
    skillsDir: str(current(raw.skillsDir), ''),
    mediaHost: str(current(raw.mediaHost), ''),
    outputDir: str(current(raw.outputDir), ''),
    comfyuiDirs: Array.isArray(dirs)
      ? dirs.filter((dir): dir is string => typeof dir === 'string' && dir.trim() !== '')
      : [],
  }
}
