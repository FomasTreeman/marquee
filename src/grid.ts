import { logWarn } from './log'
import {
  firstVisibleIndex, glide, metrics, move as moveIndex, poolSize, positionOf,
  scrollToShow, topClearance, gapCoversEdges, imageAction, type Metrics,
} from './grid-math'

/**
 * Virtualised cover grid, sized to hold frame rate with 2,000 games on
 * integrated graphics (docs/PLAN.md §2). Only the visible rows plus overscan
 * exist; card nodes are pooled and reassigned, never created on scroll; and
 * position is a `transform`, which stays on the compositor, never `top`/`left`.
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
  /** Bumped on every reassignment so a superseded decode cannot reveal the
   *  wrong game's cover while fast-scrolling. */
  generation: number
  /** The src that last failed to decode in this node, if it is still set. */
  failed: string | undefined
  /** Which item this pooled node currently shows, or -1 when parked. */
  index: number
  /** Last values written to the DOM, compared before every write: unconditional
   *  writes on every slot were most of the navigation p99. */
  transform: string
  focus: boolean
  /** Not derivable from `index`, which layout() resets to -1 for every slot;
   *  relying on it left stale cards visible after filtering. */
  visible: boolean
}

const OVERSCAN_ROWS = 2

/** Summarised rather than logged per card, or a blocked host writes a line per
 *  cover on every scroll. */
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
  /** Update one title in place; rebuilding the list would reset scroll and focus. */
  setTitle(index: number, title: string): void
  /** The layout the grid is actually using, for development. */
  debug(): { metrics: Metrics; scrollY: number; scrollTarget: number; gliding: boolean; viewH: number; gap: number; gapX: number; focused: number; items: number }
  move(dx: number, dy: number): void
  get focused(): number
  get columns(): number
  destroy(): void
}

export function createGrid(
  viewport: HTMLElement,
  onFocusChange?: (index: number, item: GridItem | undefined) => void,
  /** Double-click, or a second click on the selected card, so a mouse cannot
   *  launch a game by accident. */
  onActivate?: (index: number) => void,
  /** Right-click, opening the details screen. */
  onInspect?: (index: number) => void,
): Grid {
  const canvas = document.createElement('div')
  canvas.className = 'grid-canvas'
  viewport.appendChild(canvas)

  let items: GridItem[] = []
  let slots: Slot[] = []
  /** The arithmetic lives in grid-math.ts; this module is the DOM half. */
  let m: Metrics = metrics({
    inner: 0, viewportHeight: 0, ideal: 188, gapX: 30, gapY: 20, ratio: 0.6667, count: 0,
  })
  let gap = 20
  /** Horizontal gutter, wider than the vertical one (design/tokens.json). */
  let gapX = 30
  /** Room the focused row needs above it for its scale and outset ring. */
  let clearance = 12
  /** How far a card's shadow reaches below it, so the row above scrolls fully
   *  out of view. */
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
  /** Where the scroll is heading. Moves accumulate from here, or a held
   *  direction under-scrolls during a glide. */
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
    // Multiplied here because a `calc(... * var(--s))` token comes back from
    // getComputedStyle as an unresolved string.
    const scale = px('--s', 1) || 1
    gap = px('--gap', 20) * scale
    gapX = px('--gap-x', 30) * scale
    shadowReach = px('--card-shadow-reach', 19) * scale

    viewH = viewport.clientHeight
    m = metrics({
      inner: viewport.clientWidth - parseFloat(getComputedStyle(viewport).paddingLeft) * 2,
      viewportHeight: viewH,
      ideal: px('--card-w', 188) * scale,
      gapX,
      gapY: gap,
      ratio: px('--cover-ratio', 0.6667) || 0.6667,
      count: items.length,
    })
    // After metrics(), or the clearance lags one layout behind a resize.
    clearance = topClearance(m.cardH, px('--focus-scale', 1) || 1, px('--ring-offset', 4) * scale)

    // The gap must cover both the ring's clearance and the previous row's
    // shadow; a token change that breaks this shows as a sliver at the top.
    if (!gapCoversEdges(gap, shadowReach, clearance)) {
      logWarn(
        'grid',
        'the vertical gap no longer covers the focus ring and the shadow above it; ' +
          'the top edge will show a sliver of the previous row',
        { gap, clearance, shadowReach },
      )
    }
  }

  function makeSlot(): Slot {
    const el = document.createElement('div')
    el.className = 'card'
    const art = document.createElement('div')
    art.className = 'card-art'
    const img = document.createElement('img')
    // Not lazy: the browser judges "near the viewport" from layout and does not
    // re-evaluate transformed slots, so covers stayed blank until a refocus.
    img.decoding = 'async'
    img.draggable = false
    // A missing cover shows the tinted fallback, but is still reported so a CSP
    // block on every image cannot pass silently.
    img.addEventListener('error', () => {
      img.style.display = 'none'
      reportArtFailure(img.getAttribute('src') ?? '(no src)')
    })
    const fallback = document.createElement('div')
    fallback.className = 'card-fallback'
    const ring = document.createElement('div')
    ring.className = 'card-ring'
    art.append(fallback, img)
    el.append(art, ring)

    const s: Slot = {
      el, art, fallback, img,
      index: -1, transform: '', focus: false, visible: false, generation: 0, failed: undefined,
    }
    // Parked until given an item, or the unused pool stacks at 0,0 over the
    // first card and looks like its artwork failing.
    el.style.visibility = 'hidden'

    // Click selects and double-click plays, so a click cannot launch a game.
    el.addEventListener('click', () => {
      if (s.index >= 0) setFocus(s.index)
    })
    el.addEventListener('dblclick', () => {
      if (s.index >= 0) onActivate?.(s.index)
    })
    // Select first, so right-click shows this card rather than the previous one.
    el.addEventListener('contextmenu', (e) => {
      if (s.index < 0) return
      e.preventDefault()
      setFocus(s.index)
      onInspect?.(s.index)
    })

    canvas.appendChild(el)
    return s
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
      const action = imageAction(s.img.getAttribute('src'), s.failed, item.art)
      if (action === 'load') {
        // Hidden until decoded, or the previous game's cover shows under the
        // new title.
        s.img.style.display = 'none'
        s.img.src = item.art!
        s.failed = undefined
        const reveal = () => {
          if (s.generation !== generation) return
          s.img.style.display = ''
        }
        s.img.decode().then(reveal).catch(() => {
          // Being superseded is routine; a real decode failure is reported.
          if (s.generation !== generation) return
          s.failed = item.art
          reportArtFailure(String(item.art))
        })
      } else if (action === 'show') {
        s.img.style.display = ''
      } else {
        if (!item.art) s.img.removeAttribute('src')
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
    // Clear the DOM attribute as well as the flag: paintSlot only writes on a
    // mismatch, so a stale data-focus="1" left two focus rings.
    for (const s of slots) {
      s.index = -1
      s.transform = ''
      s.focus = false
      s.el.dataset['focus'] = '0'
    }
    // Published for the self-check's item-count and fill-width assertions.
    canvas.dataset['items'] = String(items.length)
    canvas.dataset['fit'] = JSON.stringify({
      inner: Math.round(viewport.clientWidth - parseFloat(getComputedStyle(viewport).paddingLeft) * 2),
      used: Math.round(m.cols * m.cardW + gapX * (m.cols - 1) + m.sideInset * 2),
      cols: m.cols,
    })
    // Set once on the canvas rather than written onto every card.
    canvas.style.setProperty('--card-w-fit', `${m.cardW}px`)
    canvas.style.setProperty('--card-h-fit', `${m.cardH}px`)
    scrollIntoView()
    render()
  }

  /**
   * Glide the focused card into view, computed from the scroll target rather
   * than the current position. Writes only, so it cannot force a layout.
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

    // Retarget from wherever the current glide has reached.
    glideFrom = scrollY
    glideStart = performance.now()
    glideMs = duration
    scrollTarget = next
    if (!gliding) {
      gliding = true
      requestAnimationFrame(stepGlide)
    }
  }

  /** Zero under reduced motion, making the scroll instant. */
  function scrollDuration(): number {
    const cs = getComputedStyle(document.documentElement)
    const motion = parseFloat(cs.getPropertyValue('--motion'))
    const base = parseFloat(cs.getPropertyValue('--scroll-ms'))
    return (Number.isFinite(motion) ? motion : 1) * (Number.isFinite(base) ? base : 190)
  }

  function stepGlide(now: number): void {
    // Duration is read once per glide, since getComputedStyle per frame forces
    // style resolution.
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
    // A wheel or trackpad scroll overrides a glide in flight.
    if (!gliding) scrollTarget = scrollY
    schedule()
  }
  viewport.addEventListener('scroll', onScroll, { passive: true })

  function setFocus(next: number): void {
    const clamped = Math.max(0, Math.min(items.length - 1, next))
    if (clamped === focused) return
    focused = clamped
    scrollIntoView()
    // Through rAF only; rendering here too meant two renders per keypress.
    schedule()
    onFocusChange?.(focused, items[focused])
  }

  /** Announce the selection unconditionally. setFocus() skips an unchanged
   *  index, which left the hero empty in a one-game library. */
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
