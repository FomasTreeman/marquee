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

export interface Shell {
  presets: HTMLElement
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

  // Hidden until there is a query. A search box occupying the top bar
  // permanently would be a desktop habit imposed on a television.
  const query = el('input', 'query', topbar)
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

  return { presets, query, backdropA, backdropB, heroLogo, heroTitle, heroMeta, gridViewport, count, clock, hints }
}

/** The button legend along the bottom. Labels follow the Xbox layout, with
 *  PlayStation in brackets, exactly as the prototype does. */
export function setHints(hints: HTMLElement, entries: Array<[string, string]>): void {
  hints.textContent = ''
  for (const [button, label] of entries) {
    const item = el('span', 'hint', hints)
    const key = el('b', 'hint-key', item)
    key.textContent = button
    const text = el('span', undefined, item)
    text.textContent = label
  }
}
