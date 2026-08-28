import { defineConfig } from 'vite'

// Tauri drives this dev server; the port is fixed so tauri.conf.json can
// point at it, and we fail loudly rather than silently hopping to 1421.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    // Matches the oldest of the three webviews we support.
    target: 'es2021',
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
})
