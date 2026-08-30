/**
 * Runtime self-check.
 *
 * Error handling does not catch the bugs this project actually has. Both of
 * the real ones so far were silent and looked correct:
 *
 *   1. `contain: paint` on the card clipped the focus ring, drawn outset by
 *      design. No error. Ring simply never visible.
 *   2. `.card-fallback` was absolutely positioned and the cover image was
 *      static, so the fallback painted on top. Every cover in the library was
 *      fully loaded, network clean, `naturalWidth` correct, and invisible.
 *
 * Nothing throws in either case, so nothing logs. The only conventional way to
 * find them is for a human to look at the screen.
 *
 * So this asserts the invariants that would have failed. It hit-tests what is
 * actually painted on top rather than trusting the DOM, and writes failures to
 * the same log as everything else -- which means they can be read from a
 * terminal without anyone looking at the window.
 *
 * Runs in development, or with ?check=1. Never in a release build.
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
  // A bare tag name is useless when the blocker is a sibling of the same kind.
  // Walk up far enough to say *which* one.
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

/**
 * Is this element actually reachable, or is something painted over it?
 *
 * The question every overlay has to answer. A button behind a scrim looks
 * completely normal in the DOM and in a screenshot, and does nothing.
 */
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
 * Every surface that legitimately covers the grid, innermost first.
 *
 * One list, used both to decide whether grid assertions apply and to pick the
 * topmost overlay to check. It was two hand-maintained lists, and adding a new
 * surface meant remembering both -- which was forgotten three times, each one
 * producing a confident false failure about the grid being covered by the thing
 * that is supposed to cover it.
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

  // Positions are written during a requestAnimationFrame, and a hidden window
  // pauses those indefinitely while synchronous state carries on changing. So
  // in a background tab the DOM can be an arbitrary number of moves behind
  // reality, and any assertion about *where* something is measures the past.
  //
  // This has produced a false failure three times now, each one costing an
  // investigation. Position is asserted only when the window can paint.
  const painting = document.visibilityState === 'visible'

  // Assertions about the grid only mean anything while the grid is the top
  // surface. With an overlay open, "the cover art is painted on top" is false
  // and correct -- and a check that fires when the interface is working is
  // worse than no check, because it teaches everyone to ignore the output.
  const covering = openOverlay()?.[0]

  // --- artwork is actually visible ------------------------------------
  // The exact bug from the header. A loaded image behind an opaque sibling
  // passes every other kind of test there is.
  // Only cards FULLY on screen. A partially visible card has its geometric
  // centre outside the viewport, where elementFromPoint returns null -- which
  // the hit test would report as "covered by nothing". A check that cries wolf
  // is a check that gets ignored, so it only asserts what it can actually see.
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
  // Exactly one, and it must be the one the grid thinks it is. Pooled slots
  // are reused, so a stale attribute leaves a second ring on a card that has
  // been recycled to a different game -- which is what happened.
  const marked = document.querySelectorAll<HTMLElement>('.card[data-focus="1"]')
  if (!covering && document.querySelector('.card')) {
    out.push(check('exactly one card is marked focused', marked.length === 1,
      `${marked.length} marked`))
  }

  const focused = covering ? null : (marked[0] ?? null)
  if (focused) {
    // Not just any card -- the focused one is where the cursor is, and a
    // cursor off the bottom of the viewport is how a grid loses its user.
    const fr = focused.getBoundingClientRect()
    if (painting) {
      out.push(check('the focused card is on screen',
        fr.top >= -1 && fr.bottom <= window.innerHeight + 1,
        `top ${Math.round(fr.top)} bottom ${Math.round(fr.bottom)} of ${window.innerHeight}`))
    }

    // The ring's opacity is transitioned, and a hidden window freezes
    // compositor animations mid-flight -- so a backgrounded tab reports 0 for a
    // ring that is plainly visible in a screenshot. Assert the DOM state
    // always, and the painted value only when the window can actually paint.
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
  // Cards are fixed-width by default, so an awkward window size leaves up to a
  // whole card's worth of dead space against the right edge. Nothing else here
  // can see that: every card is painted, aligned and correct.
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
  // Priority #1 is performance, and "we only animate transform and opacity" is
  // a promise nothing checked. Animating a layout property is invisible until
  // a television with a slow GPU is dropping frames on a menu, so it is
  // asserted here where it costs nothing to be sure.
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
  // The hero, the top bar and the first card share a left edge. That is the
  // single most load-bearing rule in the design -- it took many iterations to
  // get right in the Playnite theme -- and it is exactly the kind of thing a
  // description like "the card is halfway down on the right" is reporting.
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
  // With one game in the library the initial selection was never announced,
  // so the hero stayed empty and the screen was black but for a lone card.
  // Nothing errored. This is that bug, as an assertion.
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
  // Pooled slots are hidden rather than removed, so a shrinking item list can
  // leave stale cards on screen looking entirely correct. Filtering to two
  // results once showed forty-eight of them, and nothing errored.
  const canvas = document.querySelector<HTMLElement>('.grid-canvas')
  const declared = Number(canvas?.dataset['items'] ?? NaN)
  if (Number.isFinite(declared)) {
    const shown = [...document.querySelectorAll<HTMLElement>('.card')]
      .filter((c) => c.style.visibility !== 'hidden').length
    out.push(check('no more cards visible than items', shown <= declared,
      `${shown} cards for ${declared} items`))
  }

  // --- filter presets --------------------------------------------------
  // Exactly one preset is active. Zero means the pills are decoration; two
  // means the grid is showing one filter and the bar is claiming another.
  const pills = [...document.querySelectorAll<HTMLElement>('.preset')]
  if (pills.length) {
    const active = pills.filter((p) => p.dataset['active'] === '1')
    out.push(check('exactly one filter preset is active', active.length === 1,
      `${active.length} of ${pills.length}`))
  }

  // --- overlays, when one is open --------------------------------------
  // Only asserted while open. An overlay is exactly the kind of surface that
  // is hard to reach and easy to break, and its buttons are the only things in
  // the interface that can be silently unclickable.
  //
  // Only the TOPMOST one. The picker opens from the detail view, so the detail
  // view stays open underneath -- and its buttons are then correctly
  // unreachable. Asserting on it reported a failure while the interface was
  // working exactly as designed, which is the second time that mistake has
  // been made here and the reason the rule below is written down.
  // Innermost first. `.add` is shared by the picker and the settings panel,
  // and only one of them is ever open.
  const overlays: Array<[string, string]> = [
    ['.add:not([hidden])', 'panel'],
    ['.detail', 'detail view'],
  ]
  const topmost = overlays.find(([sel]) => {
    const el = document.querySelector<HTMLElement>(sel)
    return el && !el.hidden
  })
  for (const [sel, name] of topmost ? [topmost] : []) {
    const overlay = document.querySelector<HTMLElement>(sel)
    if (!overlay || overlay.hidden) continue
    const r = overlay.getBoundingClientRect()
    out.push(check(`${name} covers the screen`,
      r.width >= window.innerWidth - 1 && r.height >= window.innerHeight - 1,
      `${Math.round(r.width)}x${Math.round(r.height)} of ${window.innerWidth}x${window.innerHeight}`))

    const buttons = [...overlay.querySelectorAll<HTMLElement>('.action, .add-result')]
    const blocked = buttons.map((b) => ({ b, hit: reachable(b) })).filter((x) => !x.hit.ok)
    if (buttons.length) {
      out.push(check(`${name} buttons are reachable`, blocked.length === 0,
        blocked.length
          ? `${blocked.length}/${buttons.length} behind ${blocked[0]!.hit.blocker}`
          : `${buttons.length} reachable`))
    }

    // A picker with a field the keyboard cannot reach is unusable, and the
    // on-screen keyboard is bottom-anchored while the panel is centred.
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

    // A highlighted row that is disabled is a cursor resting somewhere that
    // does nothing, which reads as the menu being broken.
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

    // It must not cover the field it is driving, or you type blind.
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
 * Properties that are cheap to animate.
 *
 * `transform` and `opacity` are handled by the compositor and never touch
 * layout or paint. `backdrop-filter` and `filter` do repaint, but there is no
 * other way to express a couple of things the design needs, so they are
 * permitted and used sparingly rather than banned.
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
        // Media queries and other groupings.
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
 * Run once the interface has settled, and report to the log.
 *
 * Deferred by a beat because several of these checks hit-test real pixels, and
 * hit-testing before the first paint answers a question nobody asked.
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
    // Below the fold in a hidden tab everything is unreliable; say so rather
    // than reporting noise as a defect.
    const level = document.visibilityState === 'hidden' ? logWarn : logError
    level(
      'selfcheck',
      `${failed.length}/${results.length} checks FAILED${where}` +
        (document.visibilityState === 'hidden' ? ' (window hidden — results unreliable)' : ''),
      failed.map((f) => `${f.name}: ${f.detail ?? ''}`).join('\n    '),
    )
  }, delayMs)
}
