/**
 * Add a game by name.
 *
 * The headline flow from docs/PLAN.md §5. One field. You type "Hollow Knight",
 * pick it from results showing real cover art, and it lands in the library
 * complete with artwork and metadata.
 *
 * There is deliberately **no file picker here**. Identifying a game and
 * locating it on disk are different questions, and the interesting one is the
 * one we can answer for you. The executable is set later from the detail page,
 * so a game looks finished before you have said anything about where it lives.
 */
import { searchGames, addManualGame, type SearchHit } from './library'
import { logInfo, logWarn } from './log'
import { toast } from './toast'

const DEBOUNCE_MS = 280

export interface AddView {
  readonly isOpen: boolean
  open(): void
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

export function createAdd(onAdded: () => void): AddView {
  const root = el('div', 'add', document.body)
  root.hidden = true

  const panel = el('div', 'add-panel', root)
  const heading = el('h2', 'add-heading', panel)
  heading.textContent = 'Add a game'
  const sub = el('p', 'add-sub', panel)
  sub.textContent = 'Type its name. Everything else comes from that.'

  const field = el('input', 'add-field', panel)
  field.type = 'text'
  field.placeholder = 'Hollow Knight'
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
    const chosen = results.children[selected] as HTMLElement | undefined
    chosen?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
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
      logWarn('add', 'search failed', e)
    }
  }

  async function choose(): Promise<void> {
    const hit = hits[selected]
    if (!hit) return
    try {
      await addManualGame(hit.name, hit.appId)
      logInfo('add', `added ${hit.name} (steam appid ${hit.appId})`)
      toast(`Added ${hit.name}. Set its executable from its details page.`, 'info', 6000)
      close()
      onAdded()
    } catch (e) {
      toast(`Could not add ${hit.name}. ${String(e)}`, 'error', 6000)
    }
  }

  function close(): void {
    open = false
    root.hidden = true
    field.blur()
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

    open() {
      open = true
      root.hidden = false
      field.value = ''
      hits = []
      selected = 0
      status.textContent = ''
      results.textContent = ''
      // Focus after the frame so the field is actually visible when it takes
      // focus; focusing a hidden element does nothing in WebKit.
      requestAnimationFrame(() => field.focus())
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
