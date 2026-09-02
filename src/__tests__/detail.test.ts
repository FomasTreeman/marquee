import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDetail, nextActionFocus, renameIntent, revealThenFocus } from '../detail'
import type { Game } from '../library'

vi.mock('../library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../library')>()
  return { ...actual, setHidden: vi.fn(() => Promise.resolve()) }
})

/**
 * Renaming is the one place the user overrides metadata by hand, so the rule
 * for when an override is written matters more than it looks. Storing a title
 * identical to the one already showing pins the name against everything the
 * metadata worker learns later, and it does it invisibly -- the game looks
 * unchanged the day you do it.
 */
describe('renameIntent', () => {
  it('does nothing when the name is unchanged', () => {
    expect(renameIntent('Portal 2', 'Portal 2')).toEqual({ kind: 'none' })
  })

  it('ignores whitespace either side when deciding that', () => {
    // Opening the field and pressing save should never write anything, and a
    // stray space from an on-screen keyboard is not a change.
    expect(renameIntent('Portal 2', '  Portal 2  ')).toEqual({ kind: 'none' })
    expect(renameIntent(' Portal 2', 'Portal 2')).toEqual({ kind: 'none' })
  })

  it('trims what it does store', () => {
    expect(renameIntent('Portal', ' Portal 2 ')).toEqual({ kind: 'set', title: 'Portal 2' })
  })

  it('treats an empty field as "restore the original"', () => {
    // The only route back to the provider's own name. Storing '' instead would
    // leave a game with no title at all and no way to fix it.
    expect(renameIntent('My Name', '')).toEqual({ kind: 'clear' })
    expect(renameIntent('My Name', '   ')).toEqual({ kind: 'clear' })
  })

  it('clears rather than doing nothing when the game had no name either', () => {
    // A game with no title yet and an empty field still has to clear: there
    // may be an override behind the blank that the user is trying to remove.
    expect(renameIntent('', '')).toEqual({ kind: 'clear' })
  })

  it('is case sensitive, because capitalisation is the usual reason to rename', () => {
    expect(renameIntent('ELDEN RING', 'Elden Ring')).toEqual({ kind: 'set', title: 'Elden Ring' })
  })
})

/**
 * The bug this guards against: `beginRename` used to unhide the field and
 * call `.focus()` in the same synchronous tick. WebKit ignores a focus() on
 * an element that is still `display: none` at the moment it runs, so the
 * field opened looking focused and a physical keyboard typed into nothing.
 * picker.ts and settings.ts already defer with `requestAnimationFrame`; this
 * proves rename does the same rather than calling focus straight away.
 */
describe('revealThenFocus', () => {
  it('does not focus until the scheduled frame runs', () => {
    const calls: string[] = []
    let frame: (() => void) | undefined
    revealThenFocus(
      () => calls.push('reveal'),
      () => calls.push('focus'),
      (cb) => { frame = cb; return 0 },
    )
    expect(calls).toEqual(['reveal'])
    frame?.()
    expect(calls).toEqual(['reveal', 'focus'])
  })
})

/**
 * A stand-in for the DOM elements `createDetail` builds: this project has no
 * jsdom, but `el()` only ever calls createElement/appendChild and sets a
 * handful of properties, so a plain object with those covers it.
 */
function fakeElement(): Record<string, unknown> {
  let text = ''
  let kids: Record<string, unknown>[] = []
  const node: Record<string, unknown> = {
    className: '', hidden: false, style: {},
    get children() { return kids },
    classList: { add: () => {}, remove: () => {} },
    get textContent() { return text },
    set textContent(v: string) { text = v; kids = [] },
    appendChild(child: Record<string, unknown>) { kids.push(child); return child },
    addEventListener() {}, setAttribute() {}, scrollBy() {},
    blur() {}, focus() {}, select() {}, remove() {},
    scrollTop: 0,
  }
  return node
}

function findByText(
  node: Record<string, unknown> | undefined, needle: string,
): Record<string, unknown> | undefined {
  if (!node) return undefined
  if (typeof node.textContent === 'string' && node.textContent.includes(needle)) return node
  for (const child of node.children as Record<string, unknown>[]) {
    const found = findByText(child, needle)
    if (found) return found
  }
  return undefined
}

/**
 * The bug this guards against (issue #16): the hide button called a bare
 * `close()`. `createDetail` never declared a local `function close()`, only a
 * `close()` *method* on the returned view, so the bare call resolved to the
 * global `Window.close()` -- which does not exist under Node and throws
 * `ReferenceError: close is not defined`. That was thrown inside the
 * `.then()`, so it was swallowed by the handler's own `.catch()` and turned
 * into a toast; `onChanged()` was never reached and the overlay never closed,
 * which is why hiding a game looked like the whole screen going blank rather
 * than the library reloading without that game.
 */
describe('createDetail hide button', () => {
  const game: Game = {
    id: 'steam:220', provider: 'steam', providerId: '220', title: 'Half-Life 2',
    installed: false, updateAvailable: false, updating: false, installDir: null, sizeBytes: 0, lastPlayed: null,
    playtimeMinutes: 0, favourite: false, hidden: false, artAppId: null,
  }

  afterEach(() => vi.unstubAllGlobals())

  it('closes the overlay and reloads the library, rather than leaving the screen blank', async () => {
    const doc = { createElement: () => fakeElement(), body: fakeElement() }
    vi.stubGlobal('document', doc)
    vi.stubGlobal('window', { setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms) })
    vi.stubGlobal('requestAnimationFrame', () => 0)

    const onChanged = vi.fn()
    const view = createDetail({ onPlay: vi.fn(), onChanged, onFindArtwork: vi.fn() })
    view.open(game, undefined, {})

    const root = (doc.body.children as Record<string, unknown>[])[0]
    const hide = findByText(root, 'Hide this game')
    ;(hide?.onclick as () => void)()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(view.isOpen).toBe(false)
    expect(onChanged).toHaveBeenCalledOnce()
  })

  /**
   * Hide and Uninstall sit in the corner, outside the action row, and the pad
   * only ever moved along the row -- so for a long while they were reachable
   * with a mouse and nothing else, on a launcher whose whole premise is a
   * sofa. `left` from the first action wraps onto the corner, and `a` presses
   * whatever the pad landed on.
   */
  it('reaches Hide from the pad, by wrapping left off the action row', async () => {
    const body = fakeElement()
    const doc: Record<string, unknown> = {
      createElement: () => {
        const node = fakeElement()
        node.focus = () => { doc.activeElement = node }
        return node
      },
      body,
      activeElement: undefined,
    }
    vi.stubGlobal('document', doc)
    vi.stubGlobal('window', { setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms) })
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { cb(); return 0 })
    // `handle('a')` checks `instanceof HTMLElement` before clicking.
    vi.stubGlobal('HTMLElement', class {
      static [Symbol.hasInstance](o: unknown) { return typeof o === 'object' && o !== null }
    })

    const onChanged = vi.fn()
    const view = createDetail({ onPlay: vi.fn(), onChanged, onFindArtwork: vi.fn() })
    view.open(game, undefined, {})

    const root = (body.children as Record<string, unknown>[])[0]
    const hide = findByText(root, 'Hide this game')
    expect(doc.activeElement).not.toBe(hide)

    view.handle('left')
    expect(doc.activeElement).toBe(hide)

    hide!.click = hide!.onclick
    view.handle('a')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.isOpen).toBe(false)
    expect(onChanged).toHaveBeenCalledOnce()
  })
})

/**
 * Before this, `handle()` sent every `a` straight to `onPlay()` and left
 * `left`/`right` unhandled -- swallowed along with everything else while the
 * view was open, per the comment on `handle`. That meant no route to Find
 * artwork or Rename, and no way to move between action buttons, at all.
 */
describe('nextActionFocus', () => {
  it('moves right from nothing focused to the first button', () => {
    expect(nextActionFocus('right', -1, 3)).toBe(0)
  })

  it('moves left from nothing focused to the last button', () => {
    expect(nextActionFocus('left', -1, 3)).toBe(2)
  })

  it('wraps past either end', () => {
    expect(nextActionFocus('right', 2, 3)).toBe(0)
    expect(nextActionFocus('left', 0, 3)).toBe(2)
  })

  it('leaves actions that are not a move alone', () => {
    expect(nextActionFocus('up', 0, 3)).toBeUndefined()
    expect(nextActionFocus('down', 0, 3)).toBeUndefined()
    expect(nextActionFocus('a', 0, 3)).toBeUndefined()
    expect(nextActionFocus('b', 0, 3)).toBeUndefined()
  })

  it('has nothing to land on in an empty row', () => {
    expect(nextActionFocus('right', -1, 0)).toBeUndefined()
  })
})
