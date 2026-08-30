/**
 * Frontend logging, forwarded to the Rust log file.
 *
 * A webview's console goes nowhere unless someone has devtools open at the
 * exact moment something throws. That is not a debugging story — it is the
 * reason a blank window and a broken window look identical from the outside.
 *
 * So everything here is mirrored into `marquee.log` alongside the Rust lines,
 * in order, with a source tag. `pnpm logs` tails it.
 */
import { invoke } from '@tauri-apps/api/core'
import { inApp } from './host'

export type Level = 'debug' | 'info' | 'warn' | 'error'

/** Anything at all, rendered as a string that is actually useful. */
function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Never throws and never awaits.
 *
 * Logging that can fail is worse than no logging: it turns a diagnosable bug
 * into two bugs, and the second one hides the first.
 */
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

/**
 * Catch everything the interface can throw, including the things that are
 * normally silent.
 *
 * `unhandledrejection` is the important one: `void main()` on an async
 * function swallows every rejection, and the symptom is a window that renders
 * nothing with no error anywhere. That is precisely the failure this exists to
 * make impossible.
 */
export function installErrorHandlers(): void {
  window.addEventListener('error', (e) => {
    logError('ui', e.message, e.error ?? `${e.filename}:${e.lineno}:${e.colno}`)
  })

  window.addEventListener('unhandledrejection', (e) => {
    logError('ui', 'unhandled promise rejection', e.reason)
  })

  // Mirror anything the app or a library writes to console.error/warn, so a
  // third-party warning is not invisible just because it did not come through
  // our own helpers.
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

/**
 * A fatal error the user can actually see.
 *
 * The alternative is a black window, which is indistinguishable from the
 * design working correctly on a library with no games in it.
 */
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
