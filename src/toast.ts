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

/** A toast that is still on screen, for updating its text in place. */
export interface Toast {
  /** Replace the text and restart the clock. Nothing happens once it has gone. */
  update(message: string): void
}

export function toast(message: string, kind: 'info' | 'error' = 'info', ms = 4000): Toast {
  const el = document.createElement('div')
  el.className = `toast toast-${kind}`
  el.textContent = message
  ensureHost().appendChild(el)
  if (kind === 'error') logWarn('toast', message)

  // Fade, then remove. Removing on transitionend alone would leak an element
  // per toast if the window is hidden and the transition never fires.
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
    // Downloading an update reported progress with a fresh toast per chunk,
    // which stacked "Downloading… 41%" thirty deep down the side of the
    // screen. One toast, edited, reads as a counter.
    update(next) {
      if (gone) return
      el.textContent = next
      arm()
    },
  }
}
