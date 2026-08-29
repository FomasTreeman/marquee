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
   * How far a card's shadow reaches past its own box.
   *
   * Cards cast a shadow below themselves, so scrolling to leave a full `gapY`
   * above a row leaves the *previous* row's shadow in view against the top
   * edge — a smudge, and a sliver of card under it.
   *
   * The geometry does not allow both: the previous row's shadow ends `gapY -
   * shadow` above the focused row, so any clearance larger than that shows it.
   * Scrolling exactly that far puts the shadow's last pixel on the top edge.
   *
   * A small gap inside the grid is not a cramped one — the hero sits directly
   * above with its own padding, so what the eye reads is the sum of the two.
   */
  shadowReach = 0,
): number {
  const row = Math.floor(index / m.cols)
  const top = gapY + row * m.rowH
  const bottom = top + m.cardH
  // The first row has nothing above it to clip, so it keeps its full gap.
  // Charging it the shadow clearance would scroll that gap away and press the
  // top row against the hero.
  const above = row === 0 ? gapY : Math.max(0, gapY - shadowReach)
  if (top - above < scrollY) return Math.max(0, top - above)
  if (bottom + gapY > scrollY + viewportHeight) return Math.max(0, bottom + gapY - viewportHeight)
  return scrollY
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
