/** Frontend logging, mirrored into `marquee.log` beside the Rust lines, since a
 *  webview's console is lost without devtools open. `pnpm logs` tails it. */
import { invoke } from '@tauri-apps/api/core'
import { inApp } from './host'

export type Level = 'debug' | 'info' | 'warn' | 'error'

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Never throws and never awaits, so a logging failure cannot hide the bug. */
export function log(level: Level, source: string, message: string, detail?: unknown): void {
  const line = `[${source}] ${message}`
  if (level === 'error') console.error(line, detail ?? '')
  else if (level === 'warn') console.warn(line, detail ?? '')
  else console.log(line, detail ?? '')

  if (!inApp) return
  void invoke('log_from_ui', {
    level,
    source,
    message,
    detail: detail === undefined ? null : describe(detail),
  }).catch(() => {
    /* The log sink being unreachable must not cascade. */
  })
}

export const logInfo = (src: string, msg: string, d?: unknown) => log('info', src, msg, d)
export const logWarn = (src: string, msg: string, d?: unknown) => log('warn', src, msg, d)
export const logError = (src: string, msg: string, d?: unknown) => log('error', src, msg, d)

/** Log every uncaught error, above all unhandled rejections, which otherwise
 *  leave a blank window with no error anywhere. */
export function installErrorHandlers(): void {
  window.addEventListener('error', (e) => {
    logError('ui', e.message, e.error ?? `${e.filename}:${e.lineno}:${e.colno}`)
  })

  window.addEventListener('unhandledrejection', (e) => {
    logError('ui', 'unhandled promise rejection', e.reason)
  })

  // Mirror console.error/warn too, so third-party warnings reach the log.
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      if (!inApp) return
      const [first, ...rest] = args
      // Skip our own lines; log() already forwarded them.
      if (typeof first === 'string' && /^\[[a-z-]+\]/.test(first)) return
      void invoke('log_from_ui', {
        level,
        source: 'console',
        message: describe(first),
        detail: rest.length ? rest.map(describe).join(' ') : null,
      }).catch(() => {
        /* Same rule as log(): a failed forward must not cascade. */
      })
    }
  }
}

/** Show a fatal error on screen rather than leave a black window. */
export function renderFatal(error: unknown, logFile?: string): void {
  const panel = document.createElement('div')
  panel.className = 'fatal'
  const detail = describe(error)
  panel.innerHTML = `
    <h1>Marquee could not start</h1>
    <pre></pre>
    <p class="hint"></p>
  `
  panel.querySelector('pre')!.textContent = detail
  panel.querySelector('.hint')!.textContent = logFile
    ? `Full log: ${logFile}`
    : 'Run from a terminal to see the log.'
  document.body.appendChild(panel)
  logError('fatal', 'startup failed', error)
}

export async function logPath(): Promise<string | undefined> {
  if (!inApp) return undefined
  try {
    return await invoke<string>('log_path')
  } catch {
    return undefined
  }
}
