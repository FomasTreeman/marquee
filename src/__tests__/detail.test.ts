import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDetail, nextActionFocus, renameIntent, revealThenFocus } from '../detail'
import { viewInStore } from '../library'
import type { Game } from '../library'

vi.mock('../library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../library')>()
  return {
    ...actual,
    setHidden: vi.fn(() => Promise.resolve()),
    viewInStore: vi.fn(() => Promise.resolve('steam://store/220')),
  }
})

describe('renameIntent', () => {
  it('does nothing when the name is unchanged', () => {
    expect(renameIntent('Portal 2', 'Portal 2')).toEqual({ kind: 'none' })
  })

  it('ignores whitespace either side when deciding that', () => {
    expect(renameIntent('Portal 2', '  Portal 2  ')).toEqual({ kind: 'none' })
    expect(renameIntent(' Portal 2', 'Portal 2')).toEqual({ kind: 'none' })
  })

  it('trims what it does store', () => {
    expect(renameIntent('Portal', ' Portal 2 ')).toEqual({ kind: 'set', title: 'Portal 2' })
  })

  it('treats an empty field as "restore the original"', () => {
    expect(renameIntent('My Name', '')).toEqual({ kind: 'clear' })
    expect(renameIntent('My Name', '   ')).toEqual({ kind: 'clear' })
  })

  it('clears rather than doing nothing when the game had no name either', () => {
    // There may be an override behind the blank that the user wants removed.
    expect(renameIntent('', '')).toEqual({ kind: 'clear' })
  })

  it('is case sensitive, because capitalisation is the usual reason to rename', () => {
    expect(renameIntent('ELDEN RING', 'Elden Ring')).toEqual({ kind: 'set', title: 'Elden Ring' })
  })
})

// WebKit ignores focus() on an element revealed in the same tick.
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

/** Enough of a DOM element for `el()` and `createDetail`, since there is no jsdom. */
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

// Issue #16: a bare `close()` once resolved to `window.close()`, so the
// overlay never closed and the library never reloaded.
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

describe('createDetail view in store button', () => {
  const steamGame: Game = {
    id: 'steam:220', provider: 'steam', providerId: '220', title: 'Half-Life 2',
    installed: false, updateAvailable: false, updating: false, installDir: null, sizeBytes: 0, lastPlayed: null,
    playtimeMinutes: 0, favourite: false, hidden: false, artAppId: null,
  }
  const manualGame: Game = {
    id: 'manual:1', provider: 'manual', providerId: '1', title: 'Some Game',
    installed: true, updateAvailable: false, updating: false, installDir: 'C:/game.exe', sizeBytes: 0, lastPlayed: null,
    playtimeMinutes: 0, favourite: false, hidden: false, artAppId: null,
  }

  afterEach(() => vi.unstubAllGlobals())

  function stubDom(): { body: Record<string, unknown> } {
    const body = fakeElement()
    vi.stubGlobal('document', { createElement: () => fakeElement(), body })
    vi.stubGlobal('window', { setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms) })
    vi.stubGlobal('requestAnimationFrame', () => 0)
    return { body }
  }

  it('shows for a Steam game and hands its id to Steam', async () => {
    const { body } = stubDom()
    const view = createDetail({ onPlay: vi.fn(), onChanged: vi.fn(), onFindArtwork: vi.fn() })
    view.open(steamGame, undefined, {})

    const root = (body.children as Record<string, unknown>[])[0]
    const button = findByText(root, 'View in Steam Store')
    expect(button).toBeDefined()
    ;(button?.onclick as () => void)()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(viewInStore).toHaveBeenCalledWith('steam:220')
  })

  it('does not show for a hand-added game', () => {
    const { body } = stubDom()
    const view = createDetail({ onPlay: vi.fn(), onChanged: vi.fn(), onFindArtwork: vi.fn() })
    view.open(manualGame, undefined, {})

    const root = (body.children as Record<string, unknown>[])[0]
    expect(findByText(root, 'View in Steam Store')).toBeUndefined()
  })
})

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
