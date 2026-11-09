import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { input: { index: resolve('migration/electron/main.ts') } } } },
  preload: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { input: { index: resolve('migration/electron/preload.ts') } } } },
  renderer: { root: 'migration/electron/ui', build: { rollupOptions: { input: { index: resolve('migration/electron/ui/index.html') } } } }
})
