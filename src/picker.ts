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
import { searchGames, type SearchHit } from './library'
import { logWarn } from './log'

const DEBOUNCE_MS = 280

export interface PickRequest {
  heading: string
  sub: string
  initial?: string
  /** Return true to close. Rejecting leaves the overlay up with its results. */
  onPick(hit: SearchHit): Promise<boolean>
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

  let open = false
  let hits: SearchHit[] = []
  let selected = 0
  let timer: number | undefined
  /** Guards against a slow response for an old term overwriting a newer one. */
  let generation = 0
  let request: PickRequest | undefined

  function paint(): void {
    results.textContent = ''
    hits.forEach((hit, i) => {
      const card = el('button', 'add-result', results)
      card.dataset['selected'] = i === selected ? '1' : '0'
      const img = el('img', undefined, card)
      img.src = hit.cover
      img.alt = ''
      img.loading = 'lazy'
      img.addEventListener('error', () => { img.style.visibility = 'hidden' })
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
      const found = await searchGames(term)
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
    if (await request.onPick(hit)) close()
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
      open = true
      root.hidden = false
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
