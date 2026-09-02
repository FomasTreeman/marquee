import type { Device } from './input'
/**
 * The application shell.
 *
 * Structure ported from the browser prototype, which docs/PLAN.md §9 treats as
 * the specification rather than a mockup: a full-bleed backdrop, a top bar, a
 * hero for the focused game, the grid, and a hint legend.
 *
 * The one thing deliberately left behind is Playnite's fixed 1080px canvas
 * scaled by a Viewbox. We have real CSS and lay out against the real viewport.
 * What survives is `--s`, a scale factor derived from viewport height, so the
 * design keeps its proportions on a laptop and on a television without either
 * being a special case.
 */

/**
 * Geometry for the search icon: a magnifying glass drawn instead of the
 * Unicode glyph '⌕' it replaced (see .search-icon in app.css). Kept as data,
 * not just inline SVG markup, so `searchIconBBox` below can compute its
 * stroked bounding box and a test can catch it drifting off-centre again --
 * the glyph it replaced was centred by CSS but still read low, because a
 * character's own ink can sit anywhere within its line box. The same is true
 * of a hand-picked path: a magnifying glass's circle-plus-handle shape is not
 * symmetric, so centring its 24x24 viewBox does not centre its ink. The
 * circle here is offset -0.5,-0.5 from the textbook version of this icon
 * (cx/cy 11, handle from 21,21) for exactly that reason.
 */
export const SEARCH_ICON = {
  viewBox: 24,
  strokeWidth: 2,
  circle: { cx: 10.5, cy: 10.5, r: 7 },
  handle: { x1: 20.5, y1: 20.5, x2: 16.15, y2: 16.15 },
}

export function searchIconMarkup(): string {
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
 * The stroked bounding box of {@link SEARCH_ICON}, conservative about the
 * round line cap (it extends a capped endpoint by the full half-stroke-width
 * in both axes, which is where a cap's own bounding box actually reaches,
 * not just along the line's direction). Centring the icon means this box's
 * centre lands on the viewBox's own centre.
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

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  parent?.appendChild(node)
  return node
}

/**
 * Keep `--s` in step with the window.
 *
 * Clamped at both ends: below about 0.6 the type stops being legible, and
 * above 2 a 4K display would render everything at cinema size rather than
 * showing more of the library.
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

  // --- backdrop -------------------------------------------------------
  // Two images, cross-faded. One would flash black between games; swapping
  // opacity between a pair is the cheapest way to avoid it, and opacity is
  // compositor-only so the fade costs no layout.
  const backdrop = el('div', 'backdrop', root)
  const backdropA = el('img', 'backdrop-img', backdrop)
  const backdropB = el('img', 'backdrop-img', backdrop)
  for (const img of [backdropA, backdropB]) {
    img.alt = ''
    img.decoding = 'async'
  }
  el('div', 'backdrop-scrim', backdrop)

  const stage = el('div', 'stage', root)

  // --- top bar --------------------------------------------------------
  const topbar = el('header', 'topbar', stage)
  const brand = el('div', 'brand', topbar)
  brand.textContent = 'Library'
  const presets = el('nav', 'presets', topbar)

  el('div', 'spacer', topbar)

  // One control, not two. It used to be a labelled button beside the presets
  // with the input living on the far side of the spacer -- so the icon a
  // keyboard user clicked and the box that then appeared were on opposite
  // sides of the bar, which read as two different search bars rather than
  // one opening into the other. Grouped together, in the top-right corner
  // where a console puts search, so there is one thing to look at rather
  // than a button, a box, and a summary all naming the same query.
  const search = el('div', 'search', topbar)
  const searchButton = el('button', 'search-button', search)
  searchButton.type = 'button'
  searchButton.setAttribute('aria-label', 'Search')
  // Drawn, not the Unicode '⌕' this replaced -- see SEARCH_ICON above for why
  // even a drawn icon needed its coordinates nudged to actually centre.
  searchButton.innerHTML = searchIconMarkup()

  // Hidden until there is a query. A search box occupying the top bar
  // permanently would be a desktop habit imposed on a television.
  const query = el('input', 'query', search)
  query.type = 'text'
  query.placeholder = 'Search'
  query.autocomplete = 'off'
  query.spellcheck = false
  query.hidden = true
  const status = el('div', 'status', topbar)
  const count = el('span', 'count', status)
  const clock = el('span', 'clock', status)

  // --- hero -----------------------------------------------------------
  const hero = el('section', 'hero', stage)
  const heroInner = el('div', 'hero-inner', hero)
  const heroLogo = el('img', 'hero-logo', heroInner)
  heroLogo.alt = ''
  heroLogo.decoding = 'async'
  const heroTitle = el('h1', 'hero-title', heroInner)
  const heroMeta = el('div', 'hero-meta', heroInner)

  // --- grid -----------------------------------------------------------
  const library = el('main', 'library', stage)
  const gridViewport = el('div', 'grid-viewport', library)

  // --- legend ---------------------------------------------------------
  const hints = el('footer', 'hints', stage)

  const tick = () => {
    clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  tick()
  setInterval(tick, 20_000)

  return { hero, presets, searchButton, query, backdropA, backdropB, heroLogo, heroTitle, heroMeta, gridViewport, count, clock, hints }
}

export interface Hint {
  /** The key or button cap. Absent for a mouse, which has no keystroke to
   *  name -- those render as a pill you press instead. */
  key?: string
  label: string
  /** Clicking the hint does the thing. A legend nobody can press is decoration
   *  for anyone holding a mouse. */
  onClick?: () => void
}

/**
 * The legend along the bottom.
 *
 * Rebuilt whenever the input device changes, because telling someone to press A
 * while they are holding a mouse is worse than telling them nothing. Each entry
 * is clickable where there is something to click, which is what makes sort,
 * search and the menus reachable without learning a binding.
 */
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
 * The legend, in the vocabulary of whatever is being held.
 *
 * Telling someone to press A while they are holding a mouse is worse than
 * telling them nothing, and a keyboard user has no way to guess that O sorts.
 *
 * Data rather than DOM so the property that matters can be asserted: every
 * action is offered on every device. It was not -- the mouse row had no
 * Details and no Favourite, and because moving the mouse switches the legend,
 * a mouse user never saw the keyboard's "Y Details" either. Two missing rows
 * made a whole screen unreachable.
 */
export function legendFor(device: Device, on: LegendActions): Hint[] {
  switch (device) {
    case 'pad':
      return [
        { key: 'A', label: 'Play', onClick: on.play },
        { key: 'Y', label: 'Details', onClick: on.details },
        { key: 'X', label: 'Favourite', onClick: on.favourite },
        { key: 'L3', label: 'Sort', onClick: on.sort },
        // Presets are already always on screen as the nav tabs along the top,
        // so a menu that only re-listed them was a second press to reach
        // something already one press away. Right stick now opens the one
        // thing the nav cannot do: type a query.
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
      // No keystrokes to name, so these are pills you press. The two that
      // describe the grid keep their caption; the rest are buttons.
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
    // No key means there is no keystroke to show -- the chip itself is the
    // control. It used to render an em dash in the key slot, which read as
    // "this action has no binding" rather than "click this", and left mouse
    // users with five actions they could not tell were reachable at all.
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
