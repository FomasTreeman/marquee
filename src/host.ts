/**
 * The bridge to the Rust core.
 *
 * Every call into the backend goes through here so there is exactly one place
 * that knows about `invoke`, one place to instrument, and one place to change
 * if the transport ever does. Nothing else in the frontend imports Tauri.
 */
import { invoke } from '@tauri-apps/api/core'
import { log } from './log'

export interface HostInfo {
  os: string
  /** The engine actually drawing the interface — the axis every rendering
   *  bug in this project will turn out to lie along. */
  webview: string
  arch: string
  version: string
  debug: boolean
}

/** True when running inside the Tauri shell rather than a plain browser tab.
 *
 *  `pnpm dev` alone is a useful fast loop for pure CSS work, so the frontend
 *  is built to degrade rather than throw. The `typeof` guard is not
 *  defensiveness for its own sake: without it this module throws at import
 *  time under a test runner, which makes every pure function downstream of it
 *  untestable. */
export const inApp = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/**
 * Every call into Rust goes through here.
 *
 * A bare `invoke` that rejects produces a promise nobody handles and a window
 * that renders nothing. This logs the failure with the command name and
 * arguments, then rethrows so the caller can still decide what to do -- but
 * the evidence exists either way.
 */
export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const t0 = performance.now()
  try {
    const result = await invoke<T>(command, args)
    const ms = performance.now() - t0
    // Only the slow ones. A debug line per call would bury the log.
    if (ms > 50) log('debug', 'ipc', `${command} took ${ms.toFixed(0)} ms`)
    return result
  } catch (e) {
    log('error', 'ipc', `${command} failed`, { args, error: e })
    throw e
  }
}

export async function hostInfo(): Promise<HostInfo> {
  if (!inApp) {
    return {
      os: 'browser',
      webview: navigator.userAgent.includes('Chrome') ? 'Chromium (tab)' : 'WebKit (tab)',
      arch: '—',
      version: 'dev',
      debug: true,
    }
  }
  return invoke<HostInfo>('host_info')
}

/** Round-trip latency of the IPC bridge, in milliseconds.
 *  Measures the bridge, not any work — `ping` is deliberately trivial. */
export async function pingMs(samples = 20): Promise<number | null> {
  if (!inApp) return null
  // One warm-up: the first call pays for channel setup and would otherwise
  // dominate a twenty-sample mean.
  await invoke('ping')
  const t0 = performance.now()
  for (let i = 0; i < samples; i++) await invoke('ping')
  return (performance.now() - t0) / samples
}
