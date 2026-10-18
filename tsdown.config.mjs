// Client bundle for dsh-comfyui: emits the __ModuleLoader__.load factory the
// dsh web plugin table serves at /plugins/<package-name>/client.js. Externals
// are exactly the loader module-table platform entries; everything else inlines.
import { createRequire } from 'node:module'
import { defineConfig } from 'tsdown'

// The banner id is the factory registration the renderer's module graph looks
// up BY PACKAGE NAME (graph-row id). A stale literal here makes the row fall
// back to its one-resource URL, re-execute the bundle and abort web boot with
// `client-modules: duplicate factory registration` (contract 16).
const ID = createRequire(import.meta.url)('./package.json').name

const PLATFORM_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

export default defineConfig({
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'client',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: PLATFORM_EXTERNALS,
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
