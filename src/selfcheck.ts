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
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
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

export function runSelfCheck(): Check[] {
  const out: Check[] = []

  // --- artwork is actually visible ------------------------------------
  // The exact bug from the header. A loaded image behind an opaque sibling
  // passes every other kind of test there is.
  const cards = [...document.querySelectorAll<HTMLElement>('.card')].filter((c) => {
    const r = c.getBoundingClientRect()
    return r.top < window.innerHeight && r.bottom > 0 && c.style.visibility !== 'hidden'
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
  const focused = document.querySelector<HTMLElement>('.card[data-focus="1"]')
  if (focused) {
    const ring = focused.querySelector<HTMLElement>('.card-ring')
    const ringOk = !!ring && parseFloat(getComputedStyle(ring).opacity) > 0.5
    out.push(check('focus ring is visible', ringOk, ring ? `opacity ${getComputedStyle(ring).opacity}` : 'no ring element'))

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
  const centre = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
  out.push(
    check(
      'no overlay intercepts the centre of the screen',
      !centre?.classList.contains('hud') && !centre?.classList.contains('backdrop-scrim'),
      centre ? describe(centre) : 'nothing',
    ),
  )

  // --- the shell is present -------------------------------------------
  for (const sel of ['.topbar', '.hero', '.grid-viewport', '.hints']) {
    const el = document.querySelector(sel)
    const r = el?.getBoundingClientRect()
    out.push(check(`${sel} laid out`, !!r && r.height > 0, r ? `${Math.round(r.height)}px` : 'missing'))
  }

  return out
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
export function scheduleSelfCheck(delayMs = 900): void {
  window.setTimeout(() => {
    const results = runSelfCheck()
    const failed = results.filter((r) => !r.ok)
    if (!failed.length) {
      logInfo('selfcheck', `${results.length} checks passed`)
      return
    }
    // Below the fold in a hidden tab everything is unreliable; say so rather
    // than reporting noise as a defect.
    const level = document.visibilityState === 'hidden' ? logWarn : logError
    level(
      'selfcheck',
      `${failed.length}/${results.length} checks FAILED` +
        (document.visibilityState === 'hidden' ? ' (window hidden — results unreliable)' : ''),
      failed.map((f) => `${f.name}: ${f.detail ?? ''}`).join('\n    '),
    )
  }, delayMs)
}
