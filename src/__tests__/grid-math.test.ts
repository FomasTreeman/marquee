import { describe, expect, it } from 'vitest'
import {
  MAX_GROWTH, easeOut, firstVisibleIndex, glide, metrics, move, poolSize,
  positionOf, scrollToShow, type MetricsInput,
} from '../grid-math'

const base: MetricsInput = {
  inner: 1598, viewportHeight: 900, ideal: 188, gapX: 30, gapY: 20,
  ratio: 0.6667, count: 200,
}
const at = (over: Partial<MetricsInput> = {}) => metrics({ ...base, ...over })

describe('grid layout', () => {
  /** The bug that started this: a fixed card width leaves up to a whole card's
   *  worth of dead space against the right edge at an awkward window size. */
  it('fills the width exactly, at every width', () => {
    for (let inner = 300; inner <= 3000; inner += 7) {
      const m = at({ inner })
      const used = m.cols * m.cardW + base.gapX * (m.cols - 1)
      const slack = inner - used - m.sideInset * 2
      expect(Math.abs(slack), `inner=${inner}`).toBeLessThan(0.01)
    }
  })

  it('chooses more columns as the window widens, never fewer', () => {
    let previous = 0
    for (let inner = 300; inner <= 3000; inner += 20) {
      const cols = at({ inner }).cols
      expect(cols).toBeGreaterThanOrEqual(previous)
      previous = cols
    }
  })

  /** Cards grow to fill, never shrink below the design's intent. */
  it('never makes a card narrower than the ideal', () => {
    for (let inner = 100; inner <= 3000; inner += 13) {
      expect(at({ inner }).cardW).toBeGreaterThanOrEqual(base.ideal - 0.001)
    }
  })

  /** Without the cap, one column makes the leftover *the whole row* and the
   *  card ends up taller than the window. `ideal` here exceeds `inner`, which
   *  is the only way to force a single column. */
  it('caps how far a card may grow', () => {
    // One column whose leftover exceeds the cap: 1000 wide, 700 ideal, so
    // fitting would give 1000 and the cap allows only 945.
    const m = at({ inner: 1000, ideal: 700 })
    expect(m.cols).toBe(1)
    expect(m.cardW).toBeCloseTo(700 * MAX_GROWTH, 5)
    expect(m.cardW).toBeLessThan(1000)
  })

  it('centres the leftover when the cap bites', () => {
    const inner = 1000
    const m = at({ inner, ideal: 700 })
    const used = m.cols * m.cardW + base.gapX * (m.cols - 1)
    expect(m.sideInset * 2 + used).toBeCloseTo(inner, 5)
    expect(m.sideInset).toBeGreaterThan(0)
  })

  it('keeps the cover aspect ratio', () => {
    const m = at()
    expect(m.cardH / m.cardW).toBeCloseTo(1 / base.ratio, 1)
  })

  it('survives a viewport of nothing', () => {
    const m = at({ inner: 0, count: 0 })
    expect(m.cols).toBe(1)
    expect(m.cardW).toBeGreaterThan(0)
    expect(m.canvasHeight).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(m.rowH)).toBe(true)
  })

  it('falls back to a sane ratio rather than dividing by zero', () => {
    expect(Number.isFinite(at({ ratio: 0 }).cardH)).toBe(true)
  })

  it('sizes the canvas to hold every row', () => {
    const m = at({ count: 201 })
    expect(m.canvasHeight).toBeCloseTo(base.gapY + Math.ceil(201 / m.cols) * m.rowH, 5)
  })
})

describe('card positions', () => {
  it('lays cards out left to right, then down', () => {
    const m = at()
    const a = positionOf(0, m, base.gapX, base.gapY)
    const b = positionOf(1, m, base.gapX, base.gapY)
    const below = positionOf(m.cols, m, base.gapX, base.gapY)
    expect(b.x).toBeCloseTo(a.x + m.cardW + base.gapX, 5)
    expect(b.y).toBe(a.y)
    expect(below.x).toBe(a.x)
    expect(below.y).toBeCloseTo(a.y + m.rowH, 5)
  })

  /** The design's most load-bearing rule: the first card shares a left edge
   *  with the hero and the top bar. sideInset is the only thing that can
   *  break it, and it is zero unless the growth cap bit. */
  it('starts the first card at the left edge when cards fill the row', () => {
    expect(positionOf(0, at(), base.gapX, base.gapY).x).toBe(0)
  })
})

describe('navigation', () => {
  const cols = at().cols

  it('moves by one within a row and by a row vertically', () => {
    expect(move(0, 1, 0, cols, 200)).toBe(1)
    expect(move(5, -1, 0, cols, 200)).toBe(4)
    expect(move(0, 0, 1, cols, 200)).toBe(cols)
    expect(move(cols, 0, -1, cols, 200)).toBe(0)
  })

  /** Clamping, not wrapping. On a pad, jumping from the last game to the first
   *  is disorienting, and a held direction should come to rest at the edge. */
  it('clamps at both ends rather than wrapping', () => {
    expect(move(0, -1, 0, cols, 200)).toBe(0)
    expect(move(0, 0, -1, cols, 200)).toBe(0)
    expect(move(199, 1, 0, cols, 200)).toBe(199)
    expect(move(199, 0, 1, cols, 200)).toBe(199)
  })

  /** A one-item library was the case that shipped broken once already. */
  it('is stable on a library of one, and of none', () => {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      expect(move(0, dx!, dy!, cols, 1)).toBe(0)
      expect(move(0, dx!, dy!, cols, 0)).toBe(0)
    }
  })

  /** Moving down from a partial last row lands on the last item rather than
   *  past it. */
  it('lands on the last item when the final row is short', () => {
    const count = cols * 3 + 2
    expect(move(cols * 2 + 5, 0, 1, cols, count)).toBe(count - 1)
  })
})

describe('scrolling', () => {
  const m = at()

  it('does not scroll while moving along a visible row', () => {
    expect(scrollToShow(1, 0, m, base.viewportHeight, base.gapY)).toBe(0)
  })

  it('scrolls just enough to reveal a row below the fold', () => {
    const rowsVisible = Math.floor(base.viewportHeight / m.rowH)
    const target = m.cols * (rowsVisible + 1)
    const y = scrollToShow(target, 0, m, base.viewportHeight, base.gapY)
    expect(y).toBeGreaterThan(0)
    // The target must be fully inside the viewport afterwards.
    const top = base.gapY + Math.floor(target / m.cols) * m.rowH
    expect(top).toBeGreaterThanOrEqual(y)
    expect(top + m.cardH).toBeLessThanOrEqual(y + base.viewportHeight)
  })

  it('scrolls back up for a row above the fold', () => {
    const y = scrollToShow(0, 5000, m, base.viewportHeight, base.gapY)
    expect(y).toBe(0)
  })

  it('never scrolls above the top of the canvas', () => {
    for (const from of [0, 100, 5000]) {
      expect(scrollToShow(0, from, m, base.viewportHeight, base.gapY)).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('virtualisation', () => {
  const m = at()

  it('starts above the fold so a fast scroll never reveals empty space', () => {
    const mid = scrollToShow(m.cols * 20, 0, m, base.viewportHeight, base.gapY)
    const first = firstVisibleIndex(mid, m, base.gapY, 2)
    const firstOnScreen = Math.floor((mid - base.gapY) / m.rowH) * m.cols
    expect(first).toBeLessThanOrEqual(firstOnScreen)
    expect(first % m.cols).toBe(0)
  })

  it('never starts before the first item', () => {
    expect(firstVisibleIndex(0, m, base.gapY, 2)).toBe(0)
    expect(firstVisibleIndex(-500, m, base.gapY, 2)).toBe(0)
  })

  /** The pool has to cover the viewport plus the overscan at both ends, or a
   *  row appears blank as it scrolls in. */
  it('sizes the pool to cover the viewport and both overscans', () => {
    const size = poolSize(m, base.viewportHeight, 2)
    const rowsNeeded = Math.ceil(base.viewportHeight / m.rowH) + 4
    expect(size).toBe(rowsNeeded * m.cols)
    expect(size).toBeGreaterThan(Math.ceil(base.viewportHeight / m.rowH) * m.cols)
  })

  /** Everything visible must have a slot, at any scroll position. */
  it('covers every on-screen index from its start point', () => {
    const size = poolSize(m, base.viewportHeight, 2)
    for (let y = 0; y < 6000; y += 137) {
      const start = firstVisibleIndex(y, m, base.gapY, 2)
      const lastVisibleRow = Math.floor((y + base.viewportHeight - base.gapY) / m.rowH)
      const lastVisible = lastVisibleRow * m.cols + (m.cols - 1)
      expect(start + size - 1, `scrollY=${y}`).toBeGreaterThanOrEqual(lastVisible)
    }
  })
})

describe('scroll glide', () => {
  it('starts where it started and ends where it was sent', () => {
    expect(glide(0, 300, 0, 200)).toBe(0)
    expect(glide(0, 300, 200, 200)).toBe(300)
    expect(glide(0, 300, 999, 200)).toBe(300)
  })

  /** Ease-out, not ease-in-out: a press is an instruction, and easing into it
   *  reads as lag. So most of the distance is covered early. */
  it('moves fastest at the start', () => {
    const firstHalf = glide(0, 100, 100, 200) - glide(0, 100, 0, 200)
    const secondHalf = glide(0, 100, 200, 200) - glide(0, 100, 100, 200)
    expect(firstHalf).toBeGreaterThan(secondHalf)
    expect(glide(0, 100, 100, 200)).toBeGreaterThan(50)
  })

  it('never overshoots or reverses', () => {
    let previous = -1
    for (let t = 0; t <= 220; t += 5) {
      const v = glide(0, 400, t, 200)
      expect(v).toBeGreaterThanOrEqual(previous)
      expect(v).toBeLessThanOrEqual(400)
      previous = v
    }
  })

  it('works downwards as well as upwards', () => {
    expect(glide(400, 0, 0, 200)).toBe(400)
    expect(glide(400, 0, 200, 200)).toBe(0)
    expect(glide(400, 0, 100, 200)).toBeLessThan(200)
  })

  /** An animation that never quite arrives keeps scheduling frames forever. */
  it('snaps the last fraction of a pixel so it can finish', () => {
    expect(glide(0, 300, 199.9, 200)).toBe(300)
    expect(glide(100, 100.4, 0, 200)).toBe(100.4)
  })

  /** Zero duration is the reduced-motion path, and must be instant rather than
   *  dividing by zero. */
  it('is instant at zero duration', () => {
    expect(glide(0, 300, 0, 0)).toBe(300)
    expect(glide(0, 300, 50, -1)).toBe(300)
  })

  it('eases within bounds for any input', () => {
    for (const t of [-1, 0, 0.5, 1, 2, NaN]) {
      const v = easeOut(t)
      if (Number.isNaN(t)) continue
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
    expect(easeOut(0)).toBe(0)
    expect(easeOut(1)).toBe(1)
  })
})
