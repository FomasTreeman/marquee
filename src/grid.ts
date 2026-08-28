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
  /** Which item this pooled node currently shows, or -1 when parked. */
  index: number
}

const OVERSCAN_ROWS = 2

export interface Grid {
  setItems(items: GridItem[]): void
  focus(index: number): void
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
  let cols = 1
  let cardW = 188
  let cardH = 282
  let gap = 20
  let padTop = 0
  let focused = 0
  let scheduled = false

  function readMetrics(): void {
    const cs = getComputedStyle(document.documentElement)
    const px = (name: string, fallback: number) => {
      const v = parseFloat(cs.getPropertyValue(name))
      return Number.isFinite(v) ? v : fallback
    }
    cardW = px('--card-w', 188)
    gap = px('--gap', 20)
    const ratio = px('--cover-ratio', 0.6667) || 0.6667
    cardH = Math.round(cardW / ratio)
    padTop = gap

    const inner = viewport.clientWidth - parseFloat(getComputedStyle(viewport).paddingLeft) * 2
    // The gap only exists *between* columns, hence the +gap on both sides.
    cols = Math.max(1, Math.floor((inner + gap) / (cardW + gap)))
  }

  function rowHeight(): number { return cardH + gap }

  function makeSlot(): Slot {
    const el = document.createElement('div')
    el.className = 'card'
    const art = document.createElement('div')
    art.className = 'card-art'
    const img = document.createElement('img')
    img.loading = 'lazy'
    img.decoding = 'async'
    img.draggable = false
    const fallback = document.createElement('div')
    fallback.className = 'card-fallback'
    const ring = document.createElement('div')
    ring.className = 'card-ring'
    art.append(fallback, img)
    el.append(art, ring)
    canvas.appendChild(el)
    return { el, art, fallback, img, index: -1 }
  }

  /** Size the pool to cover the viewport plus overscan, once, on resize. */
  function ensurePool(): void {
    const rows = Math.ceil(viewport.clientHeight / rowHeight()) + OVERSCAN_ROWS * 2
    const want = rows * cols
    while (slots.length < want) slots.push(makeSlot())
    while (slots.length > want) {
      const s = slots.pop()
      s?.el.remove()
    }
  }

  function paintSlot(s: Slot, index: number): void {
    const item = items[index]
    if (!item) {
      // Parked: kept in the pool, moved off-screen rather than removed.
      if (s.index !== -1) { s.el.style.visibility = 'hidden'; s.index = -1 }
      return
    }
    const col = index % cols
    const row = (index / cols) | 0
    const x = col * (cardW + gap)
    const y = padTop + row * rowHeight()
    s.el.style.transform = `translate3d(${x}px, ${y}px, 0)`

    if (s.index !== index) {
      s.el.style.visibility = 'visible'
      s.el.style.setProperty('--card-tint', item.tint)
      s.fallback.textContent = item.title
      if (item.art) {
        if (s.img.getAttribute('src') !== item.art) s.img.src = item.art
        s.img.style.display = ''
      } else {
        s.img.removeAttribute('src')
        s.img.style.display = 'none'
      }
      s.index = index
    }
    s.el.dataset['focus'] = index === focused ? '1' : '0'
  }

  function render(): void {
    scheduled = false
    const rh = rowHeight()
    const firstRow = Math.max(0, ((viewport.scrollTop - padTop) / rh | 0) - OVERSCAN_ROWS)
    const start = firstRow * cols
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
    const rows = Math.ceil(items.length / cols)
    canvas.style.height = `${padTop + rows * rowHeight()}px`
    // A resize can change the column count under the cursor; keep the focused
    // card on screen rather than leaving the user somewhere else entirely.
    for (const s of slots) s.index = -1
    render()
    scrollIntoView()
  }

  function scrollIntoView(): void {
    const rh = rowHeight()
    const row = (focused / cols) | 0
    const top = padTop + row * rh
    const bottom = top + cardH
    const vh = viewport.clientHeight
    if (top - gap < viewport.scrollTop) {
      viewport.scrollTop = Math.max(0, top - gap)
    } else if (bottom + gap > viewport.scrollTop + vh) {
      viewport.scrollTop = bottom + gap - vh
    }
  }

  const ro = new ResizeObserver(() => layout())
  ro.observe(viewport)
  viewport.addEventListener('scroll', schedule, { passive: true })

  function setFocus(next: number): void {
    const clamped = Math.max(0, Math.min(items.length - 1, next))
    if (clamped === focused) return
    focused = clamped
    scrollIntoView()
    render()
    onFocusChange?.(focused, items[focused])
  }

  return {
    setItems(next) { items = next; focused = Math.min(focused, next.length - 1); layout() },
    focus(i) { setFocus(i) },
    move(dx, dy) { setFocus(focused + dx + dy * cols) },
    get focused() { return focused },
    get columns() { return cols },
    destroy() { ro.disconnect(); viewport.removeEventListener('scroll', schedule); canvas.remove() },
  }
}
