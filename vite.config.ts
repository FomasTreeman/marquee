import { defineConfig } from 'vite'

// The port is fixed for tauri.conf.json; strictPort fails rather than hop.
export default defineConfig({
  test: {
    // Excludes the board rules script, which calls process.exit and runs
    // separately in `pnpm test`.
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
