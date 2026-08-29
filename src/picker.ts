/**
 * Pick a game by name.
 *
 * One overlay serving two jobs, because they are the same question asked twice:
 *
 *   * **Adding a game.** Type a name, get a game.
 *   * **Fixing artwork.** A Steam release with no cover on the CDN, or a
 *     hand-added copy matched to the wrong entry. Same search, and the answer
 *     is an appid to borrow art from rather than a game to create.
 *
 * Sharing it is not just economy. The second job only exists because the first
 * one can be wrong, so they must show the same candidates in the same order --
 * otherwise the fix cannot reach what the mistake reached.
 */
import { searchGames, searchArtwork, coverFor, type SearchHit } from './library'
import { logWarn } from './log'

const DEBOUNCE_MS = 280

export interface PickRequest {
  heading: string
  sub: string
  initial?: string
  /** Which catalogue to search.
   *
   *  `games` is the Steam store — "which game is this". `artwork` is
   *  SteamGridDB — "whose artwork should this use". Using the first for the
   *  second was the bug: it could only ever offer another Steam appid, which
   *  is no help when the missing artwork is Steam's. */
  source?: 'games' | 'artwork'
  /** Offer a file picker alongside the search field. */
  browse?: {
    label: string
    /** Runs the dialog; resolves to the chosen path, or null if cancelled. */
    choose(): Promise<string | null>
  }
  /** Return true to close. Rejecting leaves the overlay up with its results.
   *  `file` is whatever `browse` produced, if anything. */
  onPick(hit: SearchHit, file: string | null): Promise<boolean>
}

/**
 * Guess a game's name from the path to its executable.
 *
 * The folder is named after the game far more often than the executable is --
 * `.../Elden Ring/Game/eldenring.exe` -- so walk up past the structural
 * directories every engine creates and use the first name that looks like a
 * title. It only has to be close: it seeds a search the user confirms.
 */
export function nameFromPath(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean)
  // Drop the file itself, and a .app bundle's internals on macOS.
  const structural = new Set([
    'bin', 'bin64', 'binaries', 'win64', 'win32', 'x64', 'x86', 'game', 'games',
    'retail', 'shipping', 'contents', 'macos', 'resources', 'build', 'redist',
  ])
  for (let i = parts.length - 2; i >= 0; i--) {
    const part = parts[i]!
    const bare = part.replace(/\.(app|exe)$/i, '')
    if (structural.has(bare.toLowerCase())) continue
    // Separators vary by release group; spaces search better than dots.
    return bare.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim()
  }
  return (parts[parts.length - 1] ?? '').replace(/\.[^.]+$/, '')
}

export interface Picker {
  readonly isOpen: boolean
  readonly field: HTMLInputElement
  open(request: PickRequest): void
  close(): void
  handle(action: string): boolean
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  parent?.appendChild(node)
  return node
}

export function createPicker(): Picker {
  const root = el('div', 'add', document.body)
  root.hidden = true

  const panel = el('div', 'add-panel', root)
  const heading = el('h2', 'add-heading', panel)
  const sub = el('p', 'add-sub', panel)
  const field = el('input', 'add-field', panel)
  field.type = 'text'
  field.autocomplete = 'off'
  field.spellcheck = false
  const status = el('div', 'add-status', panel)
  const results = el('div', 'add-results', panel)
  const extras = el('div', 'detail-actions', panel)
  const browseButton = el('button', 'action', extras)

  let open = false
  let hits: SearchHit[] = []
  let selected = 0
  let timer: number | undefined
  /** Guards against a slow response for an old term overwriting a newer one. */
  let generation = 0
  let request: PickRequest | undefined
  /** A file chosen through `browse`, carried through to onPick. */
  let file: string | null = null

  function paint(): void {
    results.textContent = ''
    hits.forEach((hit, i) => {
      const card = el('button', 'add-result', results)
      card.dataset['selected'] = i === selected ? '1' : '0'
      const img = el('img', undefined, card)
      img.alt = ''
      img.loading = 'lazy'
      // Steam's own thumbnail is the last resort, and it is wide rather than
      // portrait, so it is contained rather than cropped to a sliver.
      let triedThumbnail = false
      img.addEventListener('error', () => {
        if (!triedThumbnail && hit.thumbnail) {
          triedThumbnail = true
          img.style.objectFit = 'contain'
          img.src = hit.thumbnail
          return
        }
        img.style.visibility = 'hidden'
      })
      // Only reached for Steam's own thumbnail, which is a wide capsule. A
      // cover from the artwork pipeline is always portrait.
      img.addEventListener('load', () => {
        if (img.naturalWidth > img.naturalHeight) img.style.objectFit = 'contain'
      })
      // A SteamGridDB result has no Steam appid to build a cover from, so its
      // own thumbnail is the picture.
      img.src = hit.appId.startsWith('sgdb:')
        ? (hit.thumbnail || '')
        : (coverFor(hit) ?? hit.thumbnail)
      const name = el('span', undefined, card)
      name.textContent = hit.name
      card.onclick = () => { selected = i; void choose() }
    })
    ;(results.children[selected] as HTMLElement | undefined)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  async function run(term: string): Promise<void> {
    const gen = ++generation
    if (term.trim().length < 2) {
      hits = []
      status.textContent = ''
      paint()
      return
    }
    status.textContent = 'Searching…'
    try {
      const found = request?.source === 'artwork'
        ? (await searchArtwork(term)).map((e) => ({
            appId: `sgdb:${e.id}`,
            name: e.name,
            thumbnail: e.cover,
          }))
        : await searchGames(term)
      if (gen !== generation) return
      hits = found
      selected = 0
      status.textContent = found.length
        ? `${found.length} result${found.length === 1 ? '' : 's'}`
        : 'Nothing found. Try a shorter name.'
      paint()
    } catch (e) {
      if (gen !== generation) return
      hits = []
      paint()
      status.textContent = String(e)
      logWarn('picker', 'search failed', e)
    }
  }

  async function choose(): Promise<void> {
    const hit = hits[selected]
    if (!hit || !request) return
    if (await request.onPick(hit, file)) close()
  }

  browseButton.onclick = async () => {
    if (!request?.browse) return
    const chosen = await request.browse.choose()
    if (!chosen) return
    file = chosen
    // The file answers "where is it"; the search still answers "what is it",
    // because artwork and metadata are keyed by the game, not the path.
    const guess = nameFromPath(chosen)
    field.value = guess
    status.textContent = `Found ${chosen.split(/[/\\]/).pop()} — now pick the game it is`
    await run(guess)
  }

  function close(): void {
    open = false
    root.hidden = true
    field.blur()
    request = undefined
    generation++
  }

  field.addEventListener('input', () => {
    window.clearTimeout(timer)
    const term = field.value
    // Debounced: typing "hollow knight" is thirteen keystrokes and Steam's
    // search endpoint should see one request, not thirteen.
    timer = window.setTimeout(() => void run(term), DEBOUNCE_MS)
  })

  return {
    get isOpen() { return open },
    get field() { return field },

    open(next) {
      request = next
      file = null
      open = true
      root.hidden = false
      browseButton.hidden = !next.browse
      browseButton.textContent = next.browse?.label ?? ''
      heading.textContent = next.heading
      sub.textContent = next.sub
      field.value = next.initial ?? ''
      field.placeholder = 'Hollow Knight'
      hits = []
      selected = 0
      status.textContent = ''
      results.textContent = ''
      // Focus after the frame: focusing a hidden element does nothing in
      // WebKit, and the element is still hidden this tick.
      requestAnimationFrame(() => field.focus())
      if (field.value) void run(field.value)
    },

    close,

    handle(action) {
      if (!open) return false
      // Everything is consumed while open, so navigation cannot reach the grid
      // behind the overlay.
      switch (action) {
        case 'b': close(); break
        case 'a': void choose(); break
        case 'left': selected = Math.max(0, selected - 1); paint(); break
        case 'right': selected = Math.min(hits.length - 1, selected + 1); paint(); break
      }
      return true
    },
  }
}
