/**
 * Runtime self-check: asserts the invariants behind bugs that never threw, such
 * as a focus ring clipped by `contain: paint` and covers painted under their
 * fallback. It hit-tests what is painted rather than trusting the DOM, and
 * writes failures to the log.
 *
 * Runs in development or with ?check=1. The flag ships in release bundles on
 * purpose: an installed copy has no query string, but `vite preview` of a
 * production build can turn it on to check the code that actually ships.
 */
import { logInfo, logError, logWarn } from './log'

export interface Check {
  name: string
  ok: boolean
  detail?: string
}

/** Is `el` (or a descendant) the thing actually painted at its own centre? */
function topmostAtCentre(el: Element): { ok: boolean; blocker?: string } {
  const r = el.getBoundingClientRect()
  if (r.width < 2 || r.height < 2) return { ok: false, blocker: 'zero-sized' }
  const x = r.left + r.width / 2
  const y = r.top + r.height / 2
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
    return { ok: true } // off-screen; not something this check can speak to
  }
  const hit = document.elementFromPoint(x, y)
  if (!hit) return { ok: false, blocker: 'nothing hit' }
  if (hit === el || el.contains(hit)) return { ok: true }
  return { ok: false, blocker: describe(hit) }
}

function describe(el: Element): string {
  const cls = typeof el.className === 'string' && el.className ? `.${el.className.split(/\s+/).join('.')}` : ''
  let out = `${el.tagName.toLowerCase()}${cls}`
  // A bare tag name cannot tell apart siblings of the same kind.
  const card = el.closest('.card')
  if (card && card !== el) {
    const cs = getComputedStyle(card)
    out += ` in .card[visibility=${cs.visibility}, transform=${cs.transform === 'none' ? 'none' : 'set'}]`
  }
  return out
}

function check(name: string, ok: boolean, detail?: string): Check {
  return { name, ok, detail }
}

/** Is this element reachable, or is something painted over it? */
function reachable(el: Element): { ok: boolean; blocker?: string } {
  const r = el.getBoundingClientRect()
  if (r.width < 2 || r.height < 2) return { ok: false, blocker: 'zero-sized' }
  if (r.bottom < 0 || r.top > window.innerHeight) return { ok: false, blocker: 'off-screen' }
  const hit = document.elementFromPoint(
    Math.min(window.innerWidth - 1, Math.max(0, r.left + r.width / 2)),
    Math.min(window.innerHeight - 1, Math.max(0, r.top + r.height / 2)),
  )
  if (!hit) return { ok: false, blocker: 'nothing hit' }
  return el.contains(hit) || hit === el ? { ok: true } : { ok: false, blocker: describe(hit) }
}

/**
 * Every surface that legitimately covers the grid, innermost first. One list,
 * because two hand-kept lists drifted and reported overlays as covering the grid.
 */
const OVERLAYS: Array<[selector: string, name: string]> = [
  ['.menu', 'list menu'],
  ['.settings', 'settings'],
  ['.add:not([hidden])', 'panel'],
  ['.detail', 'detail view'],
]

function isOpen(selector: string): boolean {
  const el = document.querySelector<HTMLElement>(selector)
  return !!el && !el.hidden
}

/** The topmost open overlay, or undefined when the grid is the top surface. */
function openOverlay(): [string, string] | undefined {
  return OVERLAYS.find(([selector]) => isOpen(selector))
}

export function runSelfCheck(): Check[] {
  const out: Check[] = []

  // Positions are written in rAF, which a hidden window pauses, so position is
  // only asserted when the window can paint.
  const painting = document.visibilityState === 'visible'

  // Grid assertions are only true while the grid is the top surface.
  const covering = openOverlay()?.[0]

  // --- artwork is actually visible ------------------------------------
  // Only cards fully on screen: a partly visible card's centre can be off the
  // viewport, where elementFromPoint returns null.
  const cards = covering ? [] : [...document.querySelectorAll<HTMLElement>('.card')].filter((c) => {
    const r = c.getBoundingClientRect()
    return (
      c.style.visibility !== 'hidden' &&
      r.top >= 0 && r.left >= 0 &&
      r.bottom <= window.innerHeight && r.right <= window.innerWidth
    )
  })
  const withArt = cards.filter((c) => {
    const img = c.querySelector('img')
    return img?.getAttribute('src') && img.naturalWidth > 0 && img.style.display !== 'none'
  })
  if (withArt.length) {
    const covered = withArt
      .map((c) => ({ card: c, hit: topmostAtCentre(c.querySelector('img')!) }))
      .filter((r) => !r.hit.ok)
    out.push(
      check(
        'cover art is painted on top',
        covered.length === 0,
        covered.length
          ? `${covered.length}/${withArt.length} covers are behind ${covered[0]!.hit.blocker}`
          : `${withArt.length} covers visible`,
      ),
    )
  }

  // --- the focus ring exists and is not clipped -----------------------
  // Slots are pooled, so a stale attribute can leave a second ring on a
  // recycled card.
  const marked = document.querySelectorAll<HTMLElement>('.card[data-focus="1"]')
  if (!covering && document.querySelector('.card')) {
    out.push(check('exactly one card is marked focused', marked.length === 1,
      `${marked.length} marked`))
  }

  const focused = covering ? null : (marked[0] ?? null)
  if (focused) {
    const fr = focused.getBoundingClientRect()
    if (painting) {
      out.push(check('the focused card is on screen',
        fr.top >= -1 && fr.bottom <= window.innerHeight + 1,
        `top ${Math.round(fr.top)} bottom ${Math.round(fr.bottom)} of ${window.innerHeight}`))
    }

    // The ring's opacity transition freezes in a hidden window, so the painted
    // value is only asserted when visible.
    const ring = focused.querySelector<HTMLElement>('.card-ring')
    const style = ring ? getComputedStyle(ring) : undefined
    const present = !!ring && style!.display !== 'none' && style!.visibility !== 'hidden'
    out.push(check('focus ring exists on the focused card', present,
      ring ? `display ${style!.display}` : 'no ring element'))
    if (present && document.visibilityState === 'visible') {
      out.push(check('focus ring is painted', parseFloat(style!.opacity) > 0.5,
        `opacity ${style!.opacity}`))
    }

    // Paint containment on an ancestor clips an outset ring away silently.
    const clipping = ancestorsOf(focused).find((a) => {
      const c = getComputedStyle(a).contain
      return c.includes('paint') || c === 'strict' || c === 'content'
    })
    out.push(
      check(
        'no ancestor clips the outset ring',
        !clipping,
        clipping ? `${describe(clipping)} has contain: ${getComputedStyle(clipping).contain}` : undefined,
      ),
    )
  } else if (cards.length) {
    out.push(check('something is focused', false, 'no card carries data-focus="1"'))
  }

  // --- the grid fills its width ---------------------------------------
  // Fixed-width cards can leave nearly a card's width of dead space on the right.
  const fitRaw = document.querySelector<HTMLElement>('.grid-canvas')?.dataset['fit']
  if (fitRaw) {
    try {
      const fit = JSON.parse(fitRaw) as { inner: number; used: number; cols: number }
      const slack = fit.inner - fit.used
      const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gap')) || 20
      out.push(check('the grid fills the width', slack < gap * 2,
        `${slack}px unused across ${fit.cols} columns`))
    } catch {
      // A malformed dataset is not worth failing the run over.
    }
  }

  // --- animation stays on the compositor -------------------------------
  // Animating a layout property only shows up as dropped frames on a slow GPU.
  const offenders = animatedLayoutProperties()
  out.push(check('nothing animates a layout property', offenders.length === 0,
    offenders.length ? offenders.slice(0, 3).join('; ') : 'transform and opacity only'))

  // --- layout ---------------------------------------------------------
  const de = document.documentElement
  out.push(
    check(
      'no horizontal overflow',
      de.scrollWidth <= de.clientWidth + 1,
      `scrollWidth ${de.scrollWidth} vs ${de.clientWidth}`,
    ),
  )

  // --- overlays must not swallow input --------------------------------
  if (!covering) {
    const centre = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
    out.push(
      check(
        'no overlay intercepts the centre of the screen',
        !centre?.classList.contains('hud') && !centre?.classList.contains('backdrop-scrim'),
        centre ? describe(centre) : 'nothing',
      ),
    )
  }

  // --- the design's alignment invariants ------------------------------
  // The hero, the top bar and the first card share a left edge.
  const firstCard = covering
    ? null
    : document.querySelector<HTMLElement>('.card[data-focus="1"]')
      ?? document.querySelector<HTMLElement>('.card')
  const heroInner = document.querySelector<HTMLElement>('.hero-inner')
  const brand = document.querySelector<HTMLElement>('.brand')
  if (firstCard && heroInner && brand && firstCard.style.visibility !== 'hidden') {
    const card = firstCard.getBoundingClientRect()
    const hero = heroInner.getBoundingClientRect()
    const bar = brand.getBoundingClientRect()
    out.push(check('first card aligns with the hero', Math.abs(card.left - hero.left) <= 2,
      `card ${Math.round(card.left)} vs hero ${Math.round(hero.left)}`))
    out.push(check('hero aligns with the top bar', Math.abs(hero.left - bar.left) <= 2,
      `hero ${Math.round(hero.left)} vs bar ${Math.round(bar.left)}`))
    if (painting) {
      out.push(check('first card is on screen', card.top >= 0 && card.bottom <= window.innerHeight + 1,
        `top ${Math.round(card.top)} bottom ${Math.round(card.bottom)} of ${window.innerHeight}`))
    }
  }

  // --- the hero actually says something --------------------------------
  // With one game the initial selection was never announced and the hero
  // stayed empty.
  const logo = document.querySelector<HTMLImageElement>('.hero-logo')
  const heroTitle = document.querySelector<HTMLElement>('.hero-title')
  const heroMeta = document.querySelector<HTMLElement>('.hero-meta')
  if (!covering && document.querySelector('.card')) {
    const hasLogo = !!logo && !logo.hidden && logo.naturalWidth > 0
    const hasTitle = !!heroTitle && !heroTitle.hidden && (heroTitle.textContent ?? '').trim().length > 0
    out.push(check('hero identifies the selected game', hasLogo || hasTitle,
      `logo=${hasLogo} title=${hasTitle}`))
    out.push(check('hero shows facts', (heroMeta?.childElementCount ?? 0) > 0,
      `${heroMeta?.childElementCount ?? 0} facts`))
  }

  // --- the grid shows what it was given --------------------------------
  // Pooled slots are hidden, not removed, so a shrinking list can leave stale
  // cards visible.
  const canvas = document.querySelector<HTMLElement>('.grid-canvas')
  const declared = Number(canvas?.dataset['items'] ?? NaN)
  if (Number.isFinite(declared)) {
    const shown = [...document.querySelectorAll<HTMLElement>('.card')]
      .filter((c) => c.style.visibility !== 'hidden').length
    out.push(check('no more cards visible than items', shown <= declared,
      `${shown} cards for ${declared} items`))
  }

  // --- filter presets --------------------------------------------------
  const pills = [...document.querySelectorAll<HTMLElement>('.preset')]
  if (pills.length) {
    const active = pills.filter((p) => p.dataset['active'] === '1')
    out.push(check('exactly one filter preset is active', active.length === 1,
      `${active.length} of ${pills.length}`))
  }

  // --- the search entry is reachable ------------------------------------
  // A button behind the scrim looks identical to a working one.
  if (!covering) {
    const searchButton = document.querySelector<HTMLElement>('.search-button')
    if (searchButton) {
      const hit = reachable(searchButton)
      out.push(check('search button is reachable', hit.ok, hit.blocker ?? 'ok'))
    }

    // The field once opened across the bar from its icon and read as a second,
    // unrelated search bar.
    const field = document.querySelector<HTMLElement>('.query')
    if (searchButton && field && !field.hidden) {
      const b = searchButton.getBoundingClientRect()
      const f = field.getBoundingClientRect()
      const gap = f.left - b.right
      out.push(check('search field opens beside its icon, not across the bar',
        gap >= 0 && gap < 40, `${Math.round(gap)}px between them`))
    }
  }

  // --- overlays, when one is open --------------------------------------
  // Only the topmost: the picker opens over the detail view, whose buttons are
  // correctly unreachable underneath.
  const topmost = openOverlay()
  for (const [sel, name] of topmost ? [topmost] : []) {
    const overlay = document.querySelector<HTMLElement>(sel)
    if (!overlay || overlay.hidden) continue
    const r = overlay.getBoundingClientRect()
    out.push(check(`${name} covers the screen`,
      r.width >= window.innerWidth - 1 && r.height >= window.innerHeight - 1,
      `${Math.round(r.width)}x${Math.round(r.height)} of ${window.innerWidth}x${window.innerHeight}`))

    // Settings scrolls; only what is on screen can be blocked.
    const buttons = [...overlay.querySelectorAll<HTMLElement>('.action, .add-result')]
      .filter((b) => { const br = b.getBoundingClientRect(); return br.bottom > 0 && br.top < window.innerHeight })
    const blocked = buttons.map((b) => ({ b, hit: reachable(b) })).filter((x) => !x.hit.ok)
    if (buttons.length) {
      out.push(check(`${name} buttons are reachable`, blocked.length === 0,
        blocked.length
          ? `${blocked.length}/${buttons.length} behind ${blocked[0]!.hit.blocker}`
          : `${buttons.length} reachable`))
    }

    // The on-screen keyboard is bottom-anchored while the panel is centred.
    const input = overlay.querySelector<HTMLInputElement>('input')
    if (input) out.push(check(`${name} field is reachable`, reachable(input).ok,
      reachable(input).blocker ?? 'ok'))
  }

  // --- list menus ------------------------------------------------------
  const menu = document.querySelector<HTMLElement>('.menu')
  if (menu && !menu.hidden) {
    const rows = [...menu.querySelectorAll<HTMLElement>('.menu-item')]
    const choosable = rows.filter((r) => r.dataset['disabled'] !== '1')
    out.push(check('the menu has something to choose', choosable.length > 0,
      `${choosable.length} of ${rows.length} usable`))

    const on = rows.filter((r) => r.dataset['on'] === '1')
    out.push(check('exactly one menu row is highlighted', on.length === 1, `${on.length}`))

    out.push(check('the highlighted row is not disabled',
      on.length === 0 || on[0]!.dataset['disabled'] !== '1'))

    if (on[0]) {
      const hit = reachable(on[0])
      out.push(check('the menu row is reachable', hit.ok, hit.blocker ?? 'ok'))
    }
  }

  // --- the on-screen keyboard ------------------------------------------
  const osk = document.querySelector<HTMLElement>('.osk')
  if (osk && !osk.hidden) {
    const on = osk.querySelectorAll('.osk-key[data-on="1"]')
    out.push(check('exactly one key is highlighted', on.length === 1, `${on.length} keys`))

    const oskRect = osk.getBoundingClientRect()
    const fields = [...document.querySelectorAll<HTMLElement>('.add-field, .query')]
      .filter((f) => !f.hidden && f.getBoundingClientRect().width > 0)
    const covered = fields.filter((f) => {
      const r = f.getBoundingClientRect()
      return r.bottom > oskRect.top && r.top < oskRect.bottom
        && r.right > oskRect.left && r.left < oskRect.right
    })
    out.push(check('keyboard does not cover the field it drives', covered.length === 0,
      `${covered.length} field(s) overlapped`))

    // Issue #18: the keyboard stayed up after its screen had closed.
    const owner = ['.settings', '.add', '.detail', '.query'].some((sel) => {
      const el = document.querySelector<HTMLElement>(sel)
      return !!el && !el.hidden
    })
    out.push(check('keyboard has an open screen to belong to', owner))
  }

  // --- toasts must never swallow input ---------------------------------
  const toastHost = document.querySelector<HTMLElement>('.toasts')
  if (toastHost) {
    out.push(check('toasts do not intercept input',
      getComputedStyle(toastHost).pointerEvents === 'none',
      getComputedStyle(toastHost).pointerEvents))
  }

  // --- the shell is present -------------------------------------------
  for (const sel of ['.topbar', '.hero', '.grid-viewport', '.hints']) {
    const el = document.querySelector(sel)
    const r = el?.getBoundingClientRect()
    out.push(check(`${sel} laid out`, !!r && r.height > 0, r ? `${Math.round(r.height)}px` : 'missing'))
  }

  return out
}

/**
 * Properties cheap enough to animate. `transform` and `opacity` stay on the
 * compositor; `filter` and `backdrop-filter` repaint but are allowed sparingly.
 */
const COMPOSITOR_SAFE = new Set(['transform', 'opacity', 'filter', 'backdrop-filter', 'all', 'none', ''])

/** Every transitioned or keyframed property that is not compositor-safe. */
function animatedLayoutProperties(): string[] {
  const bad: string[] = []
  const note = (where: string, prop: string) => {
    const clean = prop.trim().toLowerCase()
    if (clean && !COMPOSITOR_SAFE.has(clean)) bad.push(`${where} animates ${clean}`)
  }

  const walk = (rules: CSSRuleList, from: string): void => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        const t = rule.style.transitionProperty
        if (t) for (const p of t.split(',')) note(rule.selectorText, p)
      } else if (rule instanceof CSSKeyframesRule) {
        for (const frame of Array.from(rule.cssRules)) {
          if (!(frame instanceof CSSKeyframeRule)) continue
          for (const p of Array.from(frame.style)) note(`@keyframes ${rule.name}`, p)
        }
      } else if ('cssRules' in rule) {
        walk((rule as CSSGroupingRule).cssRules, from)
      }
    }
  }

  for (const sheet of Array.from(document.styleSheets)) {
    try {
      walk(sheet.cssRules, sheet.href ?? 'inline')
    } catch {
      // A stylesheet we are not allowed to read is not one we wrote.
    }
  }
  return bad
}

function ancestorsOf(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = []
  let p = el.parentElement
  while (p && p !== document.body) {
    out.push(p)
    p = p.parentElement
  }
  return out
}

/**
 * Run once the interface has settled and report to the log. Deferred because
 * hit-testing before the first paint means nothing.
 */
export function scheduleSelfCheck(delayMs = 900, context = ''): void {
  window.setTimeout(() => {
    const results = runSelfCheck()
    const failed = results.filter((r) => !r.ok)
    const where = context ? ` (${context})` : ''
    if (!failed.length) {
      logInfo('selfcheck', `${results.length} checks passed${where}`)
      return
    }
    // Results from a hidden window are unreliable, so they warn rather than fail.
    const level = document.visibilityState === 'hidden' ? logWarn : logError
    level(
      'selfcheck',
      `${failed.length}/${results.length} checks FAILED${where}` +
        (document.visibilityState === 'hidden' ? ' (window hidden — results unreliable)' : ''),
      failed.map((f) => `${f.name}: ${f.detail ?? ''}`).join('\n    '),
    )
  }, delayMs)
}
