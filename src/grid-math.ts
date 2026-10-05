/**
 * The grid's arithmetic, kept free of the DOM so it can be tested. Stale
 * slots, an unparked pool, dead space at the right edge and misalignment with
 * the hero were all arithmetic bugs found only by eye.
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
  /** Horizontal gutter, wider than the vertical because portrait cards make
   *  equal gaps look tighter side to side. */
  gapX: number
  gapY: number
  /** Cover aspect, width ÷ height. 2:3 box art is 0.6667. */
  ratio: number
  count: number
}

/** How far a card may grow to fill the row; uncapped, one column makes a card
 *  taller than the window. */
export const MAX_GROWTH = 1.35

export function metrics(i: MetricsInput): Metrics {
  const ideal = Math.max(1, i.ideal)
  const gapX = Math.max(0, i.gapX)
  const gapY = Math.max(0, i.gapY)
  const inner = Math.max(0, i.inner)
  const ratio = i.ratio > 0 ? i.ratio : 0.6667

  // Gutters sit only between columns, hence +gapX on both sides.
  const cols = Math.max(1, Math.floor((inner + gapX) / (ideal + gapX)))

  // Cards grow into the leftover while the gutters stay constant.
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
    // One gap above the first row, matching the gap between rows.
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

/** Move the selection, clamped rather than wrapped so a held direction stops
 *  at the edge. */
export function move(index: number, dx: number, dy: number, cols: number, count: number): number {
  if (count <= 0) return 0
  return Math.max(0, Math.min(count - 1, index + dx + dy * cols))
}

/**
 * The scroll position that brings `index` fully into view, moving by the
 * minimum needed, or the current one if it already is.
 */
export function scrollToShow(
  index: number,
  scrollY: number,
  m: Metrics,
  viewportHeight: number,
  gapY: number,
  /** Smallest space above the focused row before its ring clips (`topClearance`). */
  minClearance = 0,
  /** How far a card's shadow reaches below its own box. */
  shadowReach = 0,
): number {
  const row = Math.floor(index / m.cols)
  const top = gapY + row * m.rowH
  const bottom = top + m.cardH
  // The ring wants a large clearance; hiding the previous row's shadow wants a
  // small one, `gapY - shadowReach`. Taking the plain maximum let the shadow
  // show. If the gap cannot cover both, the ring wins.
  const above = row === 0 ? gapY : Math.max(minClearance, gapY - shadowReach)
  if (top - above < scrollY) return Math.max(0, top - above)
  if (bottom + gapY > scrollY + viewportHeight) return Math.max(0, bottom + gapY - viewportHeight)
  return scrollY
}

/**
 * Room the focused row needs above it: the card scales about its centre and
 * its ring sits outside that.
 */
export function topClearance(cardHeight: number, focusScale: number, ringOffset: number): number {
  const grown = (cardHeight * Math.max(1, focusScale) - cardHeight) / 2
  return grown + ringOffset
}

/**
 * Whether the vertical gap covers both the focus ring's clearance and the
 * previous row's shadow: `gapY >= shadowReach + topClearance`. The margin is a
 * few pixels across three tuned tokens, hence a test and a runtime check.
 */
export function gapCoversEdges(gapY: number, shadowReach: number, clearance: number): boolean {
  return gapY + 0.5 >= shadowReach + clearance
}

/** The first item index the pool should render, starting a few rows above the
 *  fold so a fast scroll does not reveal empty space. */
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
 * What a recycled slot's image should do with the art it is handed. A cover
 * that failed to decode stays hidden, or layout() re-reveals it as the
 * browser's broken-image glyph.
 */
export function imageAction(
  current: string | null, failed: string | undefined, art: string | undefined,
): 'load' | 'show' | 'hide' {
  if (!art) return 'hide'
  if (current !== art) return 'load'
  return failed === art ? 'hide' : 'show'
}

/** Ease-out for the scroll glide: a press should start at full speed, or it
 *  reads as lag. */
export function easeOut(t: number): number {
  const c = Math.min(1, Math.max(0, t))
  return 1 - Math.pow(1 - c, 3)
}

/**
 * Where a scroll glide should be now. Callers retarget from the current value
 * rather than restarting, so a held direction is one continuous movement.
 */
export function glide(from: number, to: number, elapsed: number, duration: number): number {
  if (duration <= 0) return to
  const value = from + (to - from) * easeOut(elapsed / duration)
  // Snap the last half-pixel, or the animation never arrives and keeps
  // scheduling frames.
  return Math.abs(to - value) < 0.5 ? to : value
}
