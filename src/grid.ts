import { logWarn } from './log'
import {
  firstVisibleIndex, glide, metrics, move as moveIndex, poolSize, positionOf,
  scrollToShow, topClearance, gapCoversEdges, type Metrics,
} from './grid-math'

/**
 * Virtualised cover grid.
 *
 * This is the load-bearing performance component: docs/PLAN.md §2 budgets a
 * locked frame rate with 2,000 games on integrated graphics, and a naive grid
 * of 2,000 DOM nodes does not come close on any of the three webviews.
 *
 * Three rules make it work, and all three matter:
 *
 *   1. Only the visible window plus an overscan margin exists in the DOM.
 *   2. Card elements are POOLED. Scrolling reassigns content to existing
 *      nodes; it never creates or destroys them, so there is no allocation
 *      churn and no style recalculation for nodes that merely moved.
 *   3. Position is a `transform`, never `top`/`left`. Transforms are
 *      compositor-only; box offsets are layout, and layout at 120Hz is how
 *      you lose the budget.
 */

export interface GridItem {
  id: number
  title: string
  /** Deterministic placeholder tint, used until real artwork arrives. */
  tint: string
  /** Cover URL. Absent means draw the fallback. */
  art?: string
}

interface Slot {
  el: HTMLElement
  art: HTMLElement
  fallback: HTMLElement
  img: HTMLImageElement
  /** Bumped on every reassignment.
   *
   *  A slot recycled while scrolling keeps showing its previous cover until
   *  the new one decodes -- which is why fast scrolling appeared to show
   *  duplicates: the same artwork on two cards, one of them stale. The image
   *  is hidden on assignment and revealed on load, and this guards against a
   *  slow load for an assignment that has since been superseded revealing the
   *  wrong game's art. */
  generation: number
  /** Which item this pooled node currently shows, or -1 when parked. */
  index: number
  /** Last values written to the DOM. Every write is compared against these
   *  first: an unconditional `style.transform` on 49 nodes is 49 style
   *  invalidations per frame, and an unconditional `data-focus` is 49 more
   *  when exactly two of them ever change. That was most of the navigation
   *  p99. */
  transform: string
  focus: boolean
  /** Whether the node is currently showing anything.
   *
   *  Tracked separately from `index` because layout() resets index to -1 for
   *  every slot, which made the "park it" branch below a no-op -- so shrinking
   *  the item list left the old cards on screen, fully visible. That is how
   *  filtering to two results still showed forty-eight. */
  visible: boolean
}

const OVERSCAN_ROWS = 2

/** Artwork failures are summarised rather than logged one per card: a blocked
 *  host would otherwise write one line per visible cover, every scroll. */
let artFailures = 0
let artReportTimer: number | undefined
let firstArtFailure = ''

function reportArtFailure(url: string): void {
  if (!artFailures) firstArtFailure = url
  artFailures++
  window.clearTimeout(artReportTimer)
  artReportTimer = window.setTimeout(() => {
    logWarn('art', `${artFailures} cover image(s) failed to load`, firstArtFailure)
    artFailures = 0
  }, 1000)
}

export interface Grid {
  setItems(items: GridItem[]): void
  focus(index: number): void
  /** Update one item's title in place. Metadata arrives progressively and
   *  rebuilding the whole list for each name would reset scroll and focus. */
  setTitle(index: number, title: string): void
  /** The layout the grid is actually using. Development only — the arithmetic
   *  is testable in isolation, but "what did it compute *here*" is a different
   *  question and was previously only answerable by inference. */
  debug(): { metrics: Metrics; scrollY: number; scrollTarget: number; gliding: boolean; viewH: number; gap: number; gapX: number; focused: number; items: number }
  move(dx: number, dy: number): void
  get focused(): number
  get columns(): number
  destroy(): void
}

export function createGrid(
  viewport: HTMLElement,
  onFocusChange?: (index: number, item: GridItem | undefined) => void,
): Grid {
  const canvas = document.createElement('div')
  canvas.className = 'grid-canvas'
  viewport.appendChild(canvas)

  let items: GridItem[] = []
  let slots: Slot[] = []
  /** All the arithmetic lives in grid-math.ts, where it can be tested without
   *  a browser. This module is the DOM half only. */
  let m: Metrics = metrics({
    inner: 0, viewportHeight: 0, ideal: 188, gapX: 30, gapY: 20, ratio: 0.6667, count: 0,
  })
  let gap = 20
  /** Horizontal gutter. Wider than the vertical one -- see design/tokens.json. */
  let gapX = 30
  /** Space the focused row needs above it: it scales and draws a ring outside
   *  its own box, both of which clip against a hard top edge. */
  let clearance = 12
  /** How far a card's shadow reaches below it. Subtracted from the gap so the
   *  row above is pushed fully out of view rather than leaving its shadow. */
  let shadowReach = 19
  let focused = 0
  let scheduled = false
  /* Our own copies of the two scroll-related layout values.
     Reading `scrollTop`/`clientHeight` and then writing `scrollTop` in the
     same turn forces a synchronous layout, and scrollIntoView() did exactly
     that on every single focus move. We track them instead: the scroll
     listener keeps scrollY honest, and clientHeight only changes on resize,
     which is where we read it. */
  let scrollY = 0
  let viewH = 0
  /** Where the scroll is heading, which is not where it is during a glide.
   *  Successive moves must accumulate from the destination, or holding a
   *  direction under-scrolls by however far the last glide had left to go. */
  let scrollTarget = 0
  let glideFrom = 0
  let glideStart = 0
  let glideMs = 190
  let gliding = false

  function readMetrics(): void {
    const cs = getComputedStyle(document.documentElement)
    const px = (name: string, fallback: number) => {
      const v = parseFloat(cs.getPropertyValue(name))
      return Number.isFinite(v) ? v : fallback
    }
    // Chrome scales with viewport height (see src/shell.ts). Both operands
    // are read as plain numbers and multiplied here, because a token defined
    // as `calc(... * var(--s))` comes back from getComputedStyle as the
    // unresolved calc() string, not a number.
    const scale = px('--s', 1) || 1
    gap = px('--gap', 20) * scale
    gapX = px('--gap-x', 30) * scale
    clearance = topClearance(m.cardH, px('--focus-scale', 1) || 1, px('--ring-offset', 4) * scale)
    shadowReach = px('--card-shadow-reach', 19) * scale

    // The gap has to pay for the ring's clearance *and* keep the previous
    // row's shadow out of view. Those pull in opposite directions and the
    // numbers currently balance exactly, so a change to any of them is worth
    // hearing about rather than discovering as a sliver at the top edge.
    if (!gapCoversEdges(gap, shadowReach, clearance)) {
      logWarn(
        'grid',
        'the vertical gap no longer covers the focus ring and the shadow above it; ' +
          'the top edge will show a sliver of the previous row',
        { gap, clearance, shadowReach: px('--card-shadow-reach', 19) * scale },
      )
    }

    viewH = viewport.clientHeight
    m = metrics({
      inner: viewport.clientWidth - parseFloat(getComputedStyle(viewport).paddingLeft) * 2,
      viewportHeight: viewH,
      // Both operands are read as plain numbers and multiplied here: a token
      // defined as `calc(... * var(--s))` comes back from getComputedStyle as
      // the unresolved calc() string, not a number.
      ideal: px('--card-w', 188) * scale,
      gapX,
      gapY: gap,
      ratio: px('--cover-ratio', 0.6667) || 0.6667,
      count: items.length,
    })
  }



  function makeSlot(): Slot {
    const el = document.createElement('div')
    el.className = 'card'
    const art = document.createElement('div')
    art.className = 'card-art'
    const img = document.createElement('img')
    img.loading = 'lazy'
    img.decoding = 'async'
    img.draggable = false
    // Not every appid has every asset on the CDN. A missing cover reveals the
    // tinted fallback underneath rather than a broken image frame -- but it is
    // reported, because a *silently* missing cover is indistinguishable from a
    // CSP rule quietly blocking every image in the library.
    img.addEventListener('error', () => {
      img.style.display = 'none'
      reportArtFailure(img.getAttribute('src') ?? '(no src)')
    })
    // No shape handling here any more: the artwork pipeline rejects anything
    // that is not portrait and composes a real cover when none exists, so what
    // arrives is always box art. Deciding shape at paint time was papering
    // over a banner being accepted in the first place.
    const fallback = document.createElement('div')
    fallback.className = 'card-fallback'
    const ring = document.createElement('div')
    ring.className = 'card-ring'
    art.append(fallback, img)
    el.append(art, ring)
    // Parked until it is given an item. A fresh slot has index -1 and no
    // transform, so without this the whole unused pool sits stacked at 0,0 on
    // top of the first card -- which looks exactly like the first card failing
    // to load its artwork. Found by the self-check, after being misread as an
    // image bug three times.
    el.style.visibility = 'hidden'
    canvas.appendChild(el)
    return {
      el, art, fallback, img,
      index: -1, transform: '', focus: false, visible: false, generation: 0,
    }
  }

  /** Size the pool to cover the viewport plus overscan, once, on resize. */
  function ensurePool(): void {
    const want = poolSize(m, viewH, OVERSCAN_ROWS)
    while (slots.length < want) slots.push(makeSlot())
    while (slots.length > want) {
      const s = slots.pop()
      s?.el.remove()
    }
  }

  function paintSlot(s: Slot, index: number): void {
    const item = items[index]
    if (!item) {
      // Parked: kept in the pool, hidden rather than removed.
      if (s.visible) {
        s.el.style.visibility = 'hidden'
        s.visible = false
      }
      s.index = -1
      s.focus = false
      return
    }
    const { x, y } = positionOf(index, m, gapX, gap)
    const transform = `translate3d(${x}px, ${y}px, 0)`
    if (s.transform !== transform) {
      s.el.style.transform = transform
      s.transform = transform
    }

    if (!s.visible) {
      s.el.style.visibility = 'visible'
      s.visible = true
    }
    if (s.index !== index) {
      s.el.style.setProperty('--card-tint', item.tint)
      s.fallback.textContent = item.title
      const generation = ++s.generation
      if (item.art) {
        if (s.img.getAttribute('src') !== item.art) {
          // Hidden until the new artwork has actually decoded. Without this the
          // previous game's cover stays on screen underneath the new game's
          // title, which reads as the grid showing duplicates.
          s.img.style.display = 'none'
          s.img.src = item.art
          const reveal = () => {
            if (s.generation !== generation) return
            s.img.style.display = ''
          }
          // decode() resolves once the image is ready to paint, so revealing it
          // cannot land on a half-decoded frame. It rejects on a 404 or when
          // superseded, and both mean "leave the fallback showing".
          s.img.decode().then(reveal).catch(() => {})
        } else {
          s.img.style.display = ''
        }
      } else {
        s.img.removeAttribute('src')
        s.img.style.display = 'none'
      }
      s.index = index
    }
    const isFocused = index === focused
    if (s.focus !== isFocused) {
      s.el.dataset['focus'] = isFocused ? '1' : '0'
      s.focus = isFocused
    }
  }

  function render(): void {
    scheduled = false
    const start = firstVisibleIndex(scrollY, m, gap, OVERSCAN_ROWS)
    for (let i = 0; i < slots.length; i++) paintSlot(slots[i]!, start + i)
  }

  function schedule(): void {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(render)
  }

  function layout(): void {
    readMetrics()
    ensurePool()
    canvas.style.height = `${m.canvasHeight}px`
    // A resize can change the column count under the cursor; keep the focused
    // card on screen rather than leaving the user somewhere else entirely.
    // The DOM attribute must be cleared too, not just the tracked flag.
    // paintSlot only writes when the flag disagrees with reality, so resetting
    // the flag alone leaves a stale data-focus="1" on a slot that has since
    // been reassigned -- two focus rings, and the one the checks find is the
    // wrong one. Same hole as the visibility flag, left open in the same place.
    for (const s of slots) {
      s.index = -1
      s.transform = ''
      s.focus = false
      s.el.dataset['focus'] = '0'
    }
    // The grid publishes its item count so the self-check can assert that no
    // more cards are visible than there are items -- the exact bug above.
    canvas.dataset['items'] = String(items.length)
    // Published so the self-check can assert the grid actually fills its width
    // -- dead space at the right edge is invisible to every other assertion.
    canvas.dataset['fit'] = JSON.stringify({
      inner: Math.round(viewport.clientWidth - parseFloat(getComputedStyle(viewport).paddingLeft) * 2),
      used: Math.round(m.cols * m.cardW + gapX * (m.cols - 1) + m.sideInset * 2),
      cols: m.cols,
    })
    // Card size is computed, not a token, so it is published as a variable the
    // stylesheet reads rather than written onto every card.
    canvas.style.setProperty('--card-w-fit', `${m.cardW}px`)
    canvas.style.setProperty('--card-h-fit', `${m.cardH}px`)
    scrollIntoView()
    render()
  }

  /**
   * Bring the focused card into view, gliding rather than jumping.
   *
   * Computed from where the scroll is *heading*, not where it currently is:
   * during a glide those differ, and using the current position would leave a
   * held direction permanently a fraction of a row behind.
   *
   * Writes only, never reads back, so it cannot force a layout.
   */
  function scrollIntoView(): void {
    const next = scrollToShow(focused, scrollTarget, m, viewH, gap, clearance, shadowReach)
    if (next === scrollTarget) return

    const duration = scrollDuration()
    if (duration <= 0) {
      scrollTarget = next
      scrollY = next
      viewport.scrollTop = next
      return
    }

    // Retarget from wherever the current glide has reached rather than
    // restarting from a standstill.
    glideFrom = scrollY
    glideStart = performance.now()
    glideMs = duration
    scrollTarget = next
    if (!gliding) {
      gliding = true
      requestAnimationFrame(stepGlide)
    }
  }

  /** Zero when the platform or the design asks for no motion, in which case the
   *  scroll is instant -- which is the correct reduced-motion behaviour, not a
   *  degraded one. */
  function scrollDuration(): number {
    const cs = getComputedStyle(document.documentElement)
    const motion = parseFloat(cs.getPropertyValue('--motion'))
    const base = parseFloat(cs.getPropertyValue('--scroll-ms'))
    return (Number.isFinite(motion) ? motion : 1) * (Number.isFinite(base) ? base : 190)
  }

  function stepGlide(now: number): void {
    // Duration is read when the glide starts, not per frame: getComputedStyle
    // forces a style resolution, and doing that every frame of an animation is
    // the exact cost this whole component is arranged to avoid.
    const value = glide(glideFrom, scrollTarget, now - glideStart, glideMs)
    scrollY = value
    viewport.scrollTop = value
    if (value === scrollTarget) {
      gliding = false
      return
    }
    requestAnimationFrame(stepGlide)
  }

  const ro = new ResizeObserver(() => layout())
  ro.observe(viewport)
  const onScroll = () => {
    scrollY = viewport.scrollTop
    // A wheel or trackpad scroll overrides a glide: the user's hand beats an
    // animation that was already in flight.
    if (!gliding) scrollTarget = scrollY
    schedule()
  }
  viewport.addEventListener('scroll', onScroll, { passive: true })

  function setFocus(next: number): void {
    const clamped = Math.max(0, Math.min(items.length - 1, next))
    if (clamped === focused) return
    focused = clamped
    scrollIntoView()
    // Always through rAF. Rendering synchronously here AND again from the
    // scroll event that scrollIntoView just triggered meant two full renders
    // per keypress, one of them outside the frame.
    schedule()
    onFocusChange?.(focused, items[focused])
  }

  /** Announce the current selection unconditionally.
   *
   *  setFocus() returns early when the index has not changed, which is right
   *  for navigation and wrong for the initial selection -- and catastrophically
   *  wrong for a one-game library, where every move clamps back to 0 and the
   *  hero was therefore never populated at all. The initial announcement is a
   *  separate concern from a focus *change*, so it gets its own path. */
  function announce(): void {
    onFocusChange?.(focused, items[focused])
  }

  return {
    setItems(next) {
      items = next
      focused = Math.max(0, Math.min(focused, next.length - 1))
      layout()
      if (next.length) announce()
    },
    focus(i) { setFocus(i) },
    setTitle(index, title) {
      const item = items[index]
      if (!item) return
      item.title = title
      const slot = slots.find((s) => s.index === index && s.visible)
      if (slot) slot.fallback.textContent = title
    },
    move(dx, dy) { setFocus(moveIndex(focused, dx, dy, m.cols, items.length)) },
    get focused() { return focused },
    get columns() { return m.cols },
    debug() {
      return { metrics: m, scrollY, scrollTarget, gliding, viewH, gap, gapX, focused, items: items.length }
    },
    destroy() { ro.disconnect(); viewport.removeEventListener('scroll', onScroll); canvas.remove() },
  }
}
