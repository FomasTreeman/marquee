/**
 * Pick a game by name, both to add a game and to fix its artwork. One overlay
 * for both, so the fix offers the same candidates the original match did.
 */
import { searchGames, searchArtwork, coverFor, type SearchHit } from './library'
import { logWarn } from './log'
import { el } from './dom'

const DEBOUNCE_MS = 280

export interface PickRequest {
  heading: string
  sub: string
  initial?: string
  /** `games` searches the Steam store; `artwork` searches SteamGridDB, which
   *  can help when Steam itself has no artwork. */
  source?: 'games' | 'artwork'
  /** Offer a file picker alongside the search field. */
  browse?: {
    label: string
    /** Runs the dialog; resolves to the chosen path, or null if cancelled. */
    choose(): Promise<string | null>
  }
  /** Return true to close; rejecting keeps the results. `file` comes from `browse`. */
  onPick(hit: SearchHit, file: string | null): Promise<boolean>
}

/**
 * Guess a game's name from its executable path, to seed a search. Uses the
 * nearest non-structural folder, as in `.../Elden Ring/Game/eldenring.exe`.
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

export function createPicker(onClose?: () => void): Picker {
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
      // Fall back to Steam's wide thumbnail, contained rather than cropped.
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
      img.addEventListener('load', () => {
        if (img.naturalWidth > img.naturalHeight) img.style.objectFit = 'contain'
      })
      // A SteamGridDB hit has no appid to build a cover from. Decided by
      // `source`; an id-prefix check silently stopped matching once.
      img.src = hit.source === 'sgdb'
        ? (hit.thumbnail || '')
        : (coverFor(hit) ?? hit.thumbnail)
      const name = el('span', undefined, card)
      name.textContent = hit.name
      // A Steam hit brings metadata and art; a SteamGridDB hit brings art only.
      const from = el('span', 'picker-source', card)
      from.textContent = hit.source === 'sgdb' ? 'SteamGridDB' : 'Steam'
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
        ? await searchArtwork(term)
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
    // Still search, because artwork and metadata are keyed by game, not path.
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
    // Lets the caller dismiss the on-screen keyboard (issue #18).
    onClose?.()
  }

  field.addEventListener('input', () => {
    window.clearTimeout(timer)
    const term = field.value
    // Debounced so Steam sees one request per pause, not one per keystroke.
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
      // WebKit skips a transition started in the same frame as a `display` change.
      root.classList.add('is-entering')
      requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('is-entering')))
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
      // WebKit ignores focus on an element that is still hidden this tick.
      requestAnimationFrame(() => field.focus())
      if (field.value) void run(field.value)
    },

    close,

    handle(action) {
      if (!open) return false
      // Consume everything so navigation cannot reach the grid behind.
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
