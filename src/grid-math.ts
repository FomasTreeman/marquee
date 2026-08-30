/**
 * The grid's arithmetic, with no DOM in it.
 *
 * Extracted because this is where the grid keeps going wrong. Four separate
 * bugs so far — stale slots left visible when the list shrank, a pool that was
 * never parked, dead space against the right edge, cards misaligned with the
 * hero — and every one of them was arithmetic, found by eye, in a component
 * that could not be tested without a browser.
 *
 * All of it is pure, so all of it is tested.
 */

export interface Metrics {
  /** Columns that fit at the ideal card width. */
  cols: number
  /** Card width after growing to consume the leftover. */
  cardW: number
  cardH: number
  /** Distance between the top of one row and the next. */
  rowH: number
  /** Leftover width after fitting, halved, so the grid stays centred. */
  sideInset: number
  /** Height of the scrollable canvas for `count` items. */
  canvasHeight: number
}

export interface MetricsInput {
  /** Usable width, inside the viewport's padding. */
  inner: number
  viewportHeight: number
  /** Preferred card width before fitting. */
  ideal: number
  /** Horizontal gutter. Wider than the vertical one — cards are portrait, so
   *  equal gaps read as tighter side to side. */
  gapX: number
  gapY: number
  /** Cover aspect, width ÷ height. 2:3 box art is 0.6667. */
  ratio: number
  count: number
}

/**
 * How much a card may grow beyond its ideal width to fill the row.
 *
 * Without a cap, one or two columns produce a card taller than the window: at
 * 1 column the leftover *is* the whole row.
 */
export const MAX_GROWTH = 1.35

export function metrics(i: MetricsInput): Metrics {
  const ideal = Math.max(1, i.ideal)
  const gapX = Math.max(0, i.gapX)
  const gapY = Math.max(0, i.gapY)
  const inner = Math.max(0, i.inner)
  const ratio = i.ratio > 0 ? i.ratio : 0.6667

  // The gutter only exists *between* columns, hence the +gapX on both sides.
  const cols = Math.max(1, Math.floor((inner + gapX) / (ideal + gapX)))

  // Cards grow to consume the leftover rather than leaving it as dead space at
  // one edge; the gutters stay constant so the rhythm does not change with the
  // window.
  const fitted = (inner - gapX * (cols - 1)) / cols
  const cardW = Math.max(ideal, Math.min(fitted, ideal * MAX_GROWTH))
  const cardH = Math.round(cardW / ratio)
  const rowH = cardH + gapY

  const used = cols * cardW + gapX * (cols - 1)
  const rows = Math.ceil(Math.max(0, i.count) / cols)

  return {
    cols,
    cardW,
    cardH,
    rowH,
    sideInset: Math.max(0, (inner - used) / 2),
    // padTop is one vertical gap, matching the gap between rows, so the first
    // row is not tighter to the hero than the second is to the first.
    canvasHeight: gapY + rows * rowH,
  }
}

/** Where a card sits on the canvas. */
export function positionOf(index: number, m: Metrics, gapX: number, gapY: number): { x: number; y: number } {
  const col = index % m.cols
  const row = Math.floor(index / m.cols)
  return {
    x: m.sideInset + col * (m.cardW + gapX),
    y: gapY + row * m.rowH,
  }
}

/**
 * Move the selection, clamped to the library.
 *
 * Clamping rather than wrapping: on a pad, wrapping from the last item to the
 * first is disorienting, and holding a direction should come to rest at the
 * edge rather than cycling forever.
 */
export function move(index: number, dx: number, dy: number, cols: number, count: number): number {
  if (count <= 0) return 0
  return Math.max(0, Math.min(count - 1, index + dx + dy * cols))
}

/**
 * The scroll position that brings `index` fully into view, or the current one
 * if it already is.
 *
 * Only ever moves by the minimum needed, so navigating along a visible row
 * does not scroll at all.
 */
export function scrollToShow(
  index: number,
  scrollY: number,
  m: Metrics,
  viewportHeight: number,
  gapY: number,
  /**
   * Smallest space the focused row can have above it before its ring clips.
   * From `topClearance`.
   */
  minClearance = 0,
  /** How far a card's shadow reaches below its own box. */
  shadowReach = 0,
): number {
  const row = Math.floor(index / m.cols)
  const top = gapY + row * m.rowH
  const bottom = top + m.cardH

  // Two opposed constraints, and the direction is easy to get backwards.
  //
  // The previous row's card ends `gapY` above this one, and its shadow reaches
  // `shadowReach` further. Leaving *less* room above the focused row pushes
  // that shadow out of view — so clipping it wants a SMALL clearance, exactly
  // `gapY - shadowReach`. The focus ring wants a LARGE one. Taking the larger
  // of the two satisfies the ring and leaves the shadow showing, which is
  // precisely the bug this comment exists to prevent recurring.
  //
  // When the gap covers both (see gapCoversEdges) `gapY - shadowReach` is
  // already at least `minClearance` and wins. When it does not, the ring is
  // protected and the shadow bleeds — the less ugly of the two failures.
  const above = row === 0 ? gapY : Math.max(minClearance, gapY - shadowReach)
  if (top - above < scrollY) return Math.max(0, top - above)
  if (bottom + gapY > scrollY + viewportHeight) return Math.max(0, bottom + gapY - viewportHeight)
  return scrollY
}

/**
 * How much room the focused row needs above it.
 *
 * The focused card is larger than the box the grid lays out: it scales about
 * its centre, so it grows by half the extra height upwards, and its ring sits
 * outside that again. Clearance smaller than this clips the ring against the
 * top of the grid.
 */
export function topClearance(cardHeight: number, focusScale: number, ringOffset: number): number {
  const grown = (cardHeight * Math.max(1, focusScale) - cardHeight) / 2
  return grown + ringOffset
}

/**
 * Does the vertical gap pay for everything that has to fit inside it?
 *
 * The edge of the grid is a hard one, so exactly two things compete for the
 * space above a row scrolled to the top: the focused card's ring, which needs
 * clearance, and the previous row's shadow, which needs *not* to be cleared
 * into view. The gap has to cover both:
 *
 *     gapY  >=  shadowReach + topClearance
 *
 * It currently balances exactly, which is a coincidence of three tuned numbers
 * and not a property anyone should rely on remembering. Hence a function, a
 * test, and a runtime check.
 */
export function gapCoversEdges(gapY: number, shadowReach: number, clearance: number): boolean {
  return gapY + 0.5 >= shadowReach + clearance
}

/**
 * The first item index the pooled slots should render, given where we are.
 *
 * Starts a couple of rows above the fold so a fast scroll does not reveal
 * empty space before the next row is painted.
 */
export function firstVisibleIndex(
  scrollY: number,
  m: Metrics,
  gapY: number,
  overscanRows: number,
): number {
  const firstRow = Math.max(0, Math.floor((scrollY - gapY) / m.rowH) - overscanRows)
  return firstRow * m.cols
}

/** How many pooled elements are needed to cover the viewport plus overscan. */
export function poolSize(m: Metrics, viewportHeight: number, overscanRows: number): number {
  const rows = Math.ceil(viewportHeight / m.rowH) + overscanRows * 2
  return rows * m.cols
}

/**
 * Ease-out for the scroll glide.
 *
 * Out, not in-out: the movement should start at full speed and settle, because
 * a press is an instruction and easing *into* it reads as lag. The same reason
 * every console list moves this way.
 */
export function easeOut(t: number): number {
  const c = Math.min(1, Math.max(0, t))
  return 1 - Math.pow(1 - c, 3)
}

/**
 * Where a scroll glide should be right now.
 *
 * Retargeting rather than restarting is the important part. Holding a direction
 * repeats every 95 ms while the glide lasts ~200 ms, so a glide that restarted
 * from a standstill on every repeat would stutter at exactly the moment
 * smoothness matters most. Continuing from wherever the last one had reached
 * turns a held direction into one continuous movement.
 */
export function glide(from: number, to: number, elapsed: number, duration: number): number {
  if (duration <= 0) return to
  const value = from + (to - from) * easeOut(elapsed / duration)
  // Snap the last fraction of a pixel: an animation that never quite arrives
  // keeps scheduling frames forever.
  return Math.abs(to - value) < 0.5 ? to : value
}
