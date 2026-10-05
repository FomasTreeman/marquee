/** The bridge to the Rust core: the one place that calls `invoke`. */
import { invoke } from '@tauri-apps/api/core'
import { log } from './log'

export interface HostInfo {
  os: string
  /** The engine drawing the interface; rendering bugs usually depend on it. */
  webview: string
  arch: string
  version: string
  debug: boolean
}

/** True inside the Tauri shell rather than a browser tab. The `typeof` guard
 *  stops this throwing at import under the test runner. */
export const inApp = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** Call a Rust command, logging any failure with its arguments before
 *  rethrowing, so no rejection goes unrecorded. */
export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const t0 = performance.now()
  try {
    const result = await invoke<T>(command, args)
    const ms = performance.now() - t0
    // Only slow calls, or the log is buried.
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
  return call<HostInfo>('host_info')
}

/** Round-trip IPC latency in milliseconds; `ping` does no work. */
export async function pingMs(samples = 20): Promise<number | null> {
  if (!inApp) return null
  // A warm-up call, as the first pays for channel setup.
  await call('ping')
  const t0 = performance.now()
  for (let i = 0; i < samples; i++) await call('ping')
  return (performance.now() - t0) / samples
}
