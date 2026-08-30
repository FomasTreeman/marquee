/**
 * The hero backdrop.
 *
 * One full-bleed image that changes on every selection, which makes it the
 * second most expensive thing on screen after the grid. Three rules, from
 * docs/PLAN.md §4:
 *
 *   1. Cross-fade with `opacity` only. It is compositor-only, so the fade
 *      costs no layout and no repaint of the image itself.
 *   2. Decode off the main thread before showing, so a fade never lands on a
 *      half-decoded bitmap.
 *   3. Debounce. Holding a direction on the stick walks through a dozen games
 *      a second, and fetching a 240 KB image for each one saturates the
 *      network for art nobody will see.
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
  // Rejected decodes are expected -- a URL can be superseded mid-flight, and
  // some appids have no hero at all. Track what we asked for so a slow
  // response cannot overwrite a newer selection.
  let generation = 0

  function swap(url: string): void {
    const gen = ++generation
    const img = back
    img.src = url
    // decode() rejects on a 404 as well as on a superseded load; both mean
    // "leave the current backdrop alone", which is the right fallback.
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
        // Superseded is routine; anything else means a backdrop we resolved
        // and verified will not decode, which is worth a line.
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
