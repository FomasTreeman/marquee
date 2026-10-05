/** Transient messages. They never take focus or need dismissing, as a pad
 *  user has no pointer. */
import { logWarn } from './log'

let host: HTMLElement | undefined

function ensureHost(): HTMLElement {
  if (!host) {
    host = document.createElement('div')
    host.className = 'toasts'
    document.body.appendChild(host)
  }
  return host
}

export interface Toast {
  /** Replace the text and restart the clock. No-op once it has gone. */
  update(message: string): void
}

export function toast(message: string, kind: 'info' | 'error' = 'info', ms = 4000): Toast {
  const el = document.createElement('div')
  el.className = `toast toast-${kind}`
  el.textContent = message
  ensureHost().appendChild(el)
  if (kind === 'error') logWarn('toast', message)

  // Timers, not transitionend, which never fires in a hidden window.
  let leaving: number | undefined
  let gone = false
  const arm = (): void => {
    if (leaving !== undefined) window.clearTimeout(leaving)
    leaving = window.setTimeout(() => {
      gone = true
      el.classList.add('is-leaving')
      window.setTimeout(() => el.remove(), 400)
    }, ms)
  }
  arm()

  return {
    // For progress, which stacked dozens deep as a new toast per chunk.
    update(next) {
      if (gone) return
      el.textContent = next
      arm()
    },
  }
}
