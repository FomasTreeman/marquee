/**
 * The hero backdrop (docs/PLAN.md §4). It cross-fades with `opacity` only, to
 * stay on the compositor; decodes before showing, so a fade never lands on a
 * half-decoded image; and debounces, since a held stick passes a dozen games a
 * second.
 */

import { logWarn } from './log'

const SETTLE_MS = 180

export interface Backdrop {
  show(url: string | undefined): void
}

export function createBackdrop(a: HTMLImageElement, b: HTMLImageElement): Backdrop {
  let front = a
  let back = b
  let pending: number | undefined
  let current: string | undefined
  // Stops a slow response overwriting a newer selection.
  let generation = 0

  function swap(url: string): void {
    const gen = ++generation
    const img = back
    img.src = url
    img
      .decode()
      .then(() => {
        if (gen !== generation) return
        front.classList.remove('is-visible')
        img.classList.add('is-visible')
        const t = front
        front = img
        back = t
      })
      .catch(() => {
        // Being superseded is routine; a real decode failure is logged.
        if (gen === generation) logWarn('art', `backdrop would not decode: ${url}`)
      })
  }

  return {
    show(url) {
      if (url === current) return
      current = url
      window.clearTimeout(pending)
      if (!url) {
        generation++
        front.classList.remove('is-visible')
        return
      }
      pending = window.setTimeout(() => swap(url), SETTLE_MS)
    },
  }
}
