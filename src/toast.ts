/**
 * Transient messages.
 *
 * A launcher fails in ways the user needs to know about and cannot read a log
 * for: a game whose executable has moved, a store that is not running. These
 * say so on screen, briefly, without stealing focus -- there is no pointer and
 * no keyboard on a television, so nothing here may require dismissing.
 */
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

export function toast(message: string, kind: 'info' | 'error' = 'info', ms = 4000): void {
  const el = document.createElement('div')
  el.className = `toast toast-${kind}`
  el.textContent = message
  ensureHost().appendChild(el)
  if (kind === 'error') logWarn('toast', message)

  // Fade, then remove. Removing on transitionend alone would leak an element
  // per toast if the window is hidden and the transition never fires.
  window.setTimeout(() => {
    el.classList.add('is-leaving')
    window.setTimeout(() => el.remove(), 400)
  }, ms)
}
