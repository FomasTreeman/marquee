import { describe, expect, it } from 'vitest'
import {
  MAX_GROWTH, easeOut, firstVisibleIndex, glide, metrics, move, poolSize,
  positionOf, scrollToShow, topClearance, gapCoversEdges, imageAction, type MetricsInput,
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

describe('clearance for the focused row', () => {
  /**
   * The focused card is bigger than the box the grid lays out: it scales about
   * its centre and draws a ring outside that. Leaving only a gap clipped both,
   * which looked like the card growing into a cut-off border.
   */
  it('accounts for the scale and the ring', () => {
    expect(topClearance(300, 1.055, 4)).toBeCloseTo((300 * 1.055 - 300) / 2 + 4, 5)
  })

  it('is just the ring when nothing scales', () => {
    expect(topClearance(300, 1, 4)).toBeCloseTo(4, 5)
    // A scale below 1 is not a shrink instruction; it must not reduce clearance.
    expect(topClearance(300, 0.5, 4)).toBeCloseTo(4, 5)
  })

  it('keeps the focused row clear of the top edge', () => {
    const m = at()
    const c = topClearance(m.cardH, 1.055, 4)
    const target = m.cols * 4
    const y = scrollToShow(target, 99999, m, base.viewportHeight, base.gapY, c)
    expect(base.gapY + 4 * m.rowH - y).toBeGreaterThanOrEqual(c - 0.001)
  })

  /** The first row cannot be scrolled off, so it keeps its plain gap rather
   *  than being pushed down by clearance it does not need. */
  it('does not apply to the first row', () => {
    const m = at()
    expect(scrollToShow(0, 99999, m, base.viewportHeight, base.gapY, 500)).toBe(0)
  })

  /**
   * The assertion that was missing, and its absence let a regression through.
   *
   * Clipping the previous row's shadow wants a *small* clearance and the focus
   * ring wants a large one, so the two pull opposite ways. A rewrite took the
   * larger of the two, which satisfies the ring and leaves the shadow visible —
   * and every existing test still passed, because they all only checked the
   * ring. Both sides are asserted now.
   */
  it('pushes the previous row and its shadow fully out of view', () => {
    // A gap that actually covers both, as the design's does. The fixture's
    // default 20 does not, and asserting against it would be testing the
    // failure mode rather than the behaviour.
    const gapY = 36
    const shadow = 19
    const m = at({ gapY })
    const clearance = topClearance(m.cardH, 1.055, 4)
    expect(gapCoversEdges(gapY, shadow, clearance)).toBe(true)

    const row = 4
    const y = scrollToShow(m.cols * row, 99999, m, base.viewportHeight, gapY, clearance, shadow)

    const previousShadowBottom = gapY + (row - 1) * m.rowH + m.cardH + shadow
    expect(previousShadowBottom).toBeLessThanOrEqual(y + 0.001)

    // And the focused row's ring must still fit above it.
    expect(gapY + row * m.rowH - y).toBeGreaterThanOrEqual(clearance - 0.001)
  })

  /** When the gap cannot pay for both, the ring wins: a clipped ring is uglier
   *  than a shadow, and the runtime check says the gap needs raising. */
  it('protects the ring when the gap cannot cover both', () => {
    const m = at()
    const clearance = topClearance(m.cardH, 1.055, 4)
    const y = scrollToShow(m.cols * 4, 99999, m, base.viewportHeight, base.gapY, clearance, 999)
    expect(base.gapY + 4 * m.rowH - y).toBeGreaterThanOrEqual(clearance - 0.001)
  })
})

describe('the gap has to pay for both edges', () => {
  /**
   * With a hard top edge, two things compete for the space above a row scrolled
   * to the top: the focused card's ring needs clearance, and the previous row's
   * shadow needs *not* to be cleared into view. The gap has to cover both,
   * with a few pixels to spare at the ideal card size — a coincidence of three
   * tuned numbers, not something to rely on anyone remembering.
   */
  // The design's own values, from design/tokens.json. A card at the ideal
  // width of 188 is 282 tall at 2:3.
  const CARD_H = 282
  const GAP = 36
  const SHADOW = 19
  const SCALE = 1.055
  const RING = 4

  it('holds for the current design values', () => {
    expect(gapCoversEdges(GAP, SHADOW, topClearance(CARD_H, SCALE, RING))).toBe(true)
  })

  /** The gap this replaced. Kept as a test because it is the case that was
   *  actually shipping: 30 did not cover 19 + 16, and the result was a sliver
   *  of the previous row's shadow at the top edge. */
  it('did not hold at the previous gap of 30', () => {
    expect(gapCoversEdges(30, SHADOW, topClearance(CARD_H, SCALE, RING))).toBe(false)
  })

  it('fails when the shadow grows past what the gap can pay for', () => {
    expect(gapCoversEdges(GAP, 40, topClearance(CARD_H, SCALE, RING))).toBe(false)
  })

  it('fails when the focus scale grows past it', () => {
    expect(gapCoversEdges(GAP, SHADOW, topClearance(CARD_H, 1.4, RING))).toBe(false)
  })

  it('is satisfied by making the gap larger', () => {
    expect(gapCoversEdges(120, 40, topClearance(CARD_H, 1.4, RING))).toBe(true)
  })
})

describe('a recycled slot handed a cover', () => {
  it('loads one it does not hold yet', () => {
    expect(imageAction(null, undefined, 'a.jpg')).toBe('load')
    expect(imageAction('a.jpg', undefined, 'b.jpg')).toBe('load')
  })

  it('shows one it already holds', () => {
    expect(imageAction('a.jpg', undefined, 'a.jpg')).toBe('show')
  })

  it('keeps hidden one that failed to decode in it, rather than showing the broken-image glyph', () => {
    expect(imageAction('a.jpg', 'a.jpg', 'a.jpg')).toBe('hide')
  })

  it('reloads after a failure once a different cover is asked for', () => {
    expect(imageAction('a.jpg', 'a.jpg', 'b.jpg')).toBe('load')
  })

  it('hides when there is nothing to show', () => {
    expect(imageAction('a.jpg', undefined, undefined)).toBe('hide')
  })
})
