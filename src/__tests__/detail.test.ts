import { describe, expect, it, vi } from 'vitest'
import { renameIntent, revealThenFocus, createDetail } from '../detail'
import { setHidden } from '../library'
import type { Game } from '../library'

vi.mock('../toast', () => ({ toast: vi.fn() }))
vi.mock('../library', () => ({
  setHidden: vi.fn(() => Promise.resolve()),
  setManualExecutable: vi.fn(),
  removeManualGame: vi.fn(),
  findExecutable: vi.fn(),
  uninstallGame: vi.fn(),
  setCustomTitle: vi.fn(),
}))

/**
 * Renaming is the one place the user overrides metadata by hand, so the rule
 * for when an override is written matters more than it looks. Storing a title
 * identical to the one already showing pins the name against everything the
 * metadata worker learns later, and it does it invisibly -- the game looks
 * unchanged the day you do it.
 */
describe('renameIntent', () => {
  it('writes an override for a real change', () => {
    expect(renameIntent('ELDEN RING', 'Elden Ring')).toEqual({ kind: 'set', title: 'Elden Ring' })
  })

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
 * A stand-in for just enough of the DOM to build the overlay, since there is
 * no jsdom in this project. Element identity and children don't matter here;
 * only that every call `createDetail` makes on a node during setup and during
 * a button click has somewhere to land.
 */
class FakeElement {
  children: FakeElement[] = []
  hidden = false
  textContent = ''
  className = ''
  value = ''
  src = ''
  alt = ''
  scrollTop = 0
  onclick: (() => void) | null = null
  onerror: (() => void) | null = null
  classList = { add: () => {}, remove: () => {}, contains: () => false }
  private attrs = new Map<string, string>()

  appendChild(child: FakeElement): FakeElement { this.children.push(child); return child }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value) }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null }
  addEventListener(): void {}
  scrollBy(): void {}
  blur(): void {}
  focus(): void {}
  select(): void {}
  remove(): void {}
}

/** Depth-first search for the button carrying this label, wherever setup put it. */
function findByText(node: FakeElement, text: string): FakeElement | undefined {
  if (node.textContent === text) return node
  for (const child of node.children) {
    const found = findByText(child, text)
    if (found) return found
  }
  return undefined
}

function fakeGame(): Game {
  return {
    id: 'steam:220', provider: 'steam', providerId: '220', title: 'Half-Life 2',
    installed: true, installDir: null, sizeBytes: 0, lastPlayed: null,
    playtimeMinutes: 0, favourite: false, hidden: false, artAppId: null,
  }
}

/**
 * The bug this guards against: the hide and uninstall handlers called a bare
 * `close()`. `createDetail` never declared a local `function close()`, only a
 * `close()` *method* on the returned object, so that bare call resolved to
 * the global `Window.close()` -- which `tsc` cannot flag, since the global
 * has the same `(): void` signature. In a real Tauri window that closes the
 * app (the reported black screen); under this test's node environment there
 * is no global `close` at all, so the same bug throws `ReferenceError: close
 * is not defined` before `onChanged` ever runs.
 */
describe('createDetail hide button', () => {
  it('closes the overlay and reloads the library once hiding succeeds', async () => {
    const body = new FakeElement()
    vi.stubGlobal('document', { createElement: () => new FakeElement(), body })
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0 })

    const onChanged = vi.fn()
    const view = createDetail({ onPlay: () => {}, onChanged, onFindArtwork: () => {} })
    const game = fakeGame()
    view.open(game, undefined, {})

    const hideButton = findByText(body, 'Hide this game')
    if (!hideButton) throw new Error('hide button not found in the fake DOM tree')
    hideButton.onclick?.()
    // setHidden resolves asynchronously; flush the microtask queue for its .then().
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(setHidden).toHaveBeenCalledWith(game.id, true)
    expect(view.isOpen).toBe(false)
    expect(onChanged).toHaveBeenCalledTimes(1)

    vi.unstubAllGlobals()
  })
})
