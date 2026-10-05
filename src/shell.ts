import type { Device } from './input'
import { el } from './dom'
/**
 * The application shell: backdrop, top bar, hero, grid and hint legend.
 * Layout uses the real viewport; `--s` scales the design by viewport height.
 */

/**
 * The search icon, kept as data so a test can assert its ink is centred.
 * The circle is nudged -0.5,-0.5 because a magnifying glass is asymmetric.
 */
export const SEARCH_ICON = {
  viewBox: 24,
  strokeWidth: 2,
  circle: { cx: 10.5, cy: 10.5, r: 7 },
  handle: { x1: 20.5, y1: 20.5, x2: 16.15, y2: 16.15 },
}

function searchIconMarkup(): string {
  const { viewBox, strokeWidth, circle, handle } = SEARCH_ICON
  return (
    `<svg class="search-icon" viewBox="0 0 ${viewBox} ${viewBox}" fill="none" ` +
    `stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">` +
    `<circle cx="${circle.cx}" cy="${circle.cy}" r="${circle.r}"></circle>` +
    `<path d="M${handle.x1} ${handle.y1}L${handle.x2} ${handle.y2}"></path></svg>`
  )
}

/**
 * The stroked bounding box of {@link SEARCH_ICON}, extending each round cap by
 * half the stroke width in both axes.
 */
export function searchIconBBox(): { minX: number; maxX: number; minY: number; maxY: number } {
  const { strokeWidth, circle, handle } = SEARCH_ICON
  const half = strokeWidth / 2
  const xs = [circle.cx - circle.r - half, circle.cx + circle.r + half, handle.x1 - half, handle.x1 + half, handle.x2 - half, handle.x2 + half]
  const ys = [circle.cy - circle.r - half, circle.cy + circle.r + half, handle.y1 - half, handle.y1 + half, handle.y2 - half, handle.y2 + half]
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

export interface Shell {
  hero: HTMLElement
  presets: HTMLElement
  searchButton: HTMLButtonElement
  query: HTMLInputElement
  backdropA: HTMLImageElement
  backdropB: HTMLImageElement
  heroLogo: HTMLImageElement
  heroTitle: HTMLElement
  heroMeta: HTMLElement
  gridViewport: HTMLElement
  count: HTMLElement
  clock: HTMLElement
  hints: HTMLElement
}

/** The design is tuned at 1080px tall, the height Playnite's canvas used. */
const DESIGN_HEIGHT = 1080

/**
 * Keep `--s` in step with the window. Clamped because type is illegible below
 * 0.6, and above 2 a 4K display would show bigger cards rather than more.
 */
function installScale(): void {
  const apply = () => {
    const s = Math.min(2, Math.max(0.6, window.innerHeight / DESIGN_HEIGHT))
    document.documentElement.style.setProperty('--s', s.toFixed(4))
  }
  apply()
  window.addEventListener('resize', apply, { passive: true })
}

export function createShell(root: HTMLElement): Shell {
  installScale()

  // Two images cross-faded by opacity, which is compositor-only. One image
  // would flash black between games.
  const backdrop = el('div', 'backdrop', root)
  const backdropA = el('img', 'backdrop-img', backdrop)
  const backdropB = el('img', 'backdrop-img', backdrop)
  for (const img of [backdropA, backdropB]) {
    img.alt = ''
    img.decoding = 'async'
  }
  el('div', 'backdrop-scrim', backdrop)

  const stage = el('div', 'stage', root)

  const topbar = el('header', 'topbar', stage)
  const brand = el('div', 'brand', topbar)
  brand.textContent = 'Library'
  const presets = el('nav', 'presets', topbar)

  el('div', 'spacer', topbar)

  // Button and input share one group so the box opens where the icon is;
  // apart, they read as two different search bars.
  const search = el('div', 'search', topbar)
  const searchButton = el('button', 'search-button', search)
  searchButton.type = 'button'
  searchButton.setAttribute('aria-label', 'Search')
  searchButton.innerHTML = searchIconMarkup()

  // Hidden until there is a query.
  const query = el('input', 'query', search)
  query.type = 'text'
  query.placeholder = 'Search'
  query.autocomplete = 'off'
  query.spellcheck = false
  query.hidden = true
  const status = el('div', 'status', topbar)
  const count = el('span', 'count', status)
  const clock = el('span', 'clock', status)

  const hero = el('section', 'hero', stage)
  const heroInner = el('div', 'hero-inner', hero)
  const heroLogo = el('img', 'hero-logo', heroInner)
  heroLogo.alt = ''
  heroLogo.decoding = 'async'
  const heroTitle = el('h1', 'hero-title', heroInner)
  const heroMeta = el('div', 'hero-meta', heroInner)

  const library = el('main', 'library', stage)
  const gridViewport = el('div', 'grid-viewport', library)

  const hints = el('footer', 'hints', stage)

  const tick = () => {
    clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  tick()
  setInterval(tick, 20_000)

  return { hero, presets, searchButton, query, backdropA, backdropB, heroLogo, heroTitle, heroMeta, gridViewport, count, clock, hints }
}

export interface Hint {
  /** The key or button cap. Absent for mouse hints, which render as buttons. */
  key?: string
  label: string
  /** Clicking the hint performs the action. */
  onClick?: () => void
}

/** The actions a legend can offer, whatever the device. */
export interface LegendActions {
  play(): void
  details(): void
  favourite(): void
  sort(): void
  search(): void
  menu(): void
  add(): void
}

/**
 * The legend for the current input device. Returned as data so a test can
 * assert every action is offered on every device; a missing mouse row once
 * made the details screen unreachable.
 */
export function legendFor(device: Device, on: LegendActions): Hint[] {
  switch (device) {
    case 'pad':
      return [
        { key: 'A', label: 'Play', onClick: on.play },
        { key: 'Y', label: 'Details', onClick: on.details },
        { key: 'X', label: 'Favourite', onClick: on.favourite },
        { key: 'L3', label: 'Sort', onClick: on.sort },
        { key: 'R3', label: 'Search', onClick: on.search },
        { key: '☰', label: 'Menu', onClick: on.menu },
        { key: '⧉', label: 'Add', onClick: on.add },
        { key: 'LB/RB', label: 'Tabs' },
      ]
    case 'keyboard':
      return [
        { key: '↵', label: 'Play', onClick: on.play },
        { key: 'Y', label: 'Details', onClick: on.details },
        { key: 'X', label: 'Favourite', onClick: on.favourite },
        { key: 'O', label: 'Sort', onClick: on.sort },
        { key: '/', label: 'Search', onClick: on.search },
        { key: 'Tab', label: 'Menu', onClick: on.menu },
        { key: 'N', label: 'Add', onClick: on.add },
        { key: 'Esc', label: 'Back' },
      ]
    case 'mouse':
      // The two grid gestures keep a caption; the rest are buttons.
      return [
        { key: 'Click', label: 'Select' },
        { key: 'Double-click', label: 'Play' },
        { label: 'Details', onClick: on.details },
        { label: 'Favourite', onClick: on.favourite },
        { label: 'Sort', onClick: on.sort },
        { label: 'Search', onClick: on.search },
        { label: 'Menu', onClick: on.menu },
        { label: 'Add', onClick: on.add },
      ]
  }
}

export function setHints(hints: HTMLElement, entries: Hint[]): void {
  hints.textContent = ''
  for (const entry of entries) {
    const item = el(entry.onClick ? 'button' : 'span', 'hint', hints)
    if (entry.onClick) {
      item.classList.add('is-clickable')
      ;(item as HTMLButtonElement).onclick = entry.onClick
    }
    // Without a key the chip itself is the button. An empty key slot read as
    // "no binding" rather than "click this".
    if (entry.key) {
      const key = el('b', 'hint-key', item)
      key.textContent = entry.key
    } else {
      item.classList.add('is-button')
    }
    const text = el('span', undefined, item)
    text.textContent = entry.label
  }
}
