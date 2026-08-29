/**
 * dsh-comfyui host configuration. The same schema drives the Loader entry
 * config (cordis.yml patch) and the `comfyui:` settings section the browser
 * settings page writes, so one shape covers both doors into the same values.
 */
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  /** ComfyUI HTTP server base URL. */
  baseUrl: z.string().default('http://127.0.0.1:8188'),
  /** Environment-variable name of the optional API key (credentials ref). */
  apiKeyEnv: z.string().default('COMFYUI_API_KEY'),
  /** Per-request connect/read timeout for the ComfyUI HTTP client. */
  connectTimeoutMs: z.number().min(1_000).max(60_000).default(10_000),
  /** How long a synchronous generation (or background job) waits for workflow completion. */
  timeoutMs: z.number().min(5_000).max(3_600_000).default(900_000),
  /** History polling interval while waiting for completion. */
  pollIntervalMs: z.number().min(200).max(10_000).default(1_000),
  /** Max media items returned per completed workflow. */
  maxMediaItems: z.number().min(1).max(50).default(12),
  /** Max bytes the media proxy streams for one file. */
  maxMediaBytes: z.number().min(64 * 1024).max(512 * 1024 * 1024).default(64 * 1024 * 1024),
  /** Directory for plugin data (workflow library, asset index); empty means DSH_HOME/data/dsh-comfyui. */
  dataDir: z.string().default(''),
  /** Max asset records kept in the asset index. */
  maxAssets: z.number().min(1).max(10_000).default(200),
  /** External base URL for generated media (e.g. http://192.168.1.5:3080). Empty = auto-detect the browser's request host, then http://127.0.0.1:<webServerPort>. */
  mediaHost: z.string().default(''),
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
  comfyuiDirs: z.array(z.string()).default([]),
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
  /** External base URL for generated media; empty auto-detects the request host. */
  mediaHost: string
  /** ComfyUI's output directory on this machine; empty infers it from reported file paths. */
  outputDir: string
  /** ComfyUI install root(s) on this machine; the agent uses them to locate files directly. */
  comfyuiDirs: string[]
}
