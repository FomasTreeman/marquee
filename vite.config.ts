import { defineConfig } from 'vite'

// Tauri drives this dev server; the port is fixed so tauri.conf.json can
// point at it, and we fail loudly rather than silently hopping to 1421.
export default defineConfig({
  test: {
    // The board rules are a plain node script -- no DOM, no vitest, and it
    // calls process.exit, which vitest reasonably objects to. It runs on its
    // own in `pnpm test`, immediately before this.
    include: ['src/**/*.test.ts'],
  },
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
