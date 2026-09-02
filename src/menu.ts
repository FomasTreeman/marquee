/**
 * A list menu.
 *
 * One component behind the main menu and the sort menu, because on a console
 * they are the same thing: a short vertical list, up and down to move, A to
 * choose, B to leave. Building these separately is how they end up behaving
 * differently for no reason.
 *
 * Anchored rather than centred. A sort menu that appears in the middle of the
 * screen has lost its connection to the thing it sorts; PS5 and Xbox both drop
 * these from the control that opened them.
 */
import { logInfo } from './log'

export interface MenuItem {
  id: string
  label: string
  /** Shown dimmed to the right — a current value, a count, a shortcut. */
  detail?: string
  /** Marks the current choice. */
  selected?: boolean
  /** Present but unusable, with the reason shown. */
  disabled?: string
  /** Ask before doing it. For anything that ends the session or the machine. */
  confirm?: string
}

export interface MenuRequest {
  title: string
  items: MenuItem[]
  /** Where to put it: under the top bar on the left, or on the right. */
  anchor?: 'left' | 'right'
  onChoose(id: string): void | Promise<void>
}

export interface Menu {
  readonly isOpen: boolean
  open(request: MenuRequest): void
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

export function createMenu(): Menu {
  const root = el('div', 'menu', document.body)
  root.hidden = true
  const panel = el('div', 'menu-panel', root)
  const heading = el('div', 'menu-title', panel)
  const list = el('div', 'menu-list', panel)

  let request: MenuRequest | undefined
  let index = 0
  /** The item awaiting a second press, for anything that ends the session. */
  let pendingConfirm: string | undefined

  function paint(): void {
    list.textContent = ''
    const items = request?.items ?? []
    items.forEach((item, i) => {
      const row = el('div', 'menu-item', list)
      row.dataset['on'] = i === index ? '1' : '0'
      if (item.disabled) row.dataset['disabled'] = '1'
      if (item.selected) row.dataset['selected'] = '1'

      const label = el('span', 'menu-label', row)
      // A confirmation replaces the label rather than opening a second dialog:
      // one press to arm, one to commit, and B or moving away disarms it.
      label.textContent =
        pendingConfirm === item.id ? (item.confirm ?? 'Press again to confirm') : item.label

      const detail = el('span', 'menu-detail', row)
      detail.textContent = item.disabled ?? item.detail ?? ''
      row.onclick = () => { index = i; void choose() }
    })
    ;(list.children[index] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' })
  }

  function move(delta: number): void {
    const items = request?.items ?? []
    if (!items.length) return
    // Skip disabled rows rather than letting the cursor rest somewhere that
    // does nothing.
    let next = index
    for (let step = 0; step < items.length; step++) {
      next = (next + delta + items.length) % items.length
      if (!items[next]!.disabled) break
    }
    if (next === index) return
    index = next
    pendingConfirm = undefined
    paint()
  }

  async function choose(): Promise<void> {
    const item = request?.items[index]
    if (!item || item.disabled || !request) return

    if (item.confirm && pendingConfirm !== item.id) {
      pendingConfirm = item.id
      paint()
      return
    }
    const { onChoose } = request
    const id = item.id
    logInfo('menu', `chose ${id}`)
    close()
    await onChoose(id)
  }

  function close(): void {
    root.hidden = true
    request = undefined
    pendingConfirm = undefined
  }

  return {
    get isOpen() { return !root.hidden },

    open(next) {
      request = next
      pendingConfirm = undefined
      heading.textContent = next.title
      root.dataset['anchor'] = next.anchor ?? 'left'
      // Start on the current choice, so a menu of five sort orders opens with
      // the cursor on the one in use rather than at the top.
      index = Math.max(0, next.items.findIndex((i) => i.selected))
      if (next.items[index]?.disabled) move(1)
      root.hidden = false
      paint()
    },

    close,

    handle(action) {
      if (root.hidden) return false
      switch (action) {
        case 'up': move(-1); break
        case 'down': move(1); break
        case 'a': void choose(); break
        case 'b': close(); break
        // Everything else is swallowed: a menu is modal, and letting left or
        // right through would move the grid behind it.
      }
      return true
    },
  }
}

/** True when this menu owns the given number of usable items. Exposed for the
 *  self-check, which asserts a menu never opens with nothing to choose. */
export function usableCount(items: MenuItem[]): number {
  return items.filter((i) => !i.disabled).length
}

/**
 * Ids that end the user's whole session rather than just this app.
 *
 * The mirror of `Action::affects_the_machine` in src-tauri/src/system.rs. Kept
 * here as data so the "two presses" rule can be asserted rather than trusted to
 * whoever next edits the menu. Exiting Marquee is deliberately not on it: you
 * land back where you started, which is not a loss.
 */
export const ENDS_THE_SESSION = ['restart', 'shutdown'] as const

/**
 * The Start-button menu, as data.
 *
 * Separate from the dispatch that acts on it so the shape can be tested. The
 * ids have to match `Action::parse` on the Rust side; `settings` and `rescan`
 * are handled in the frontend and never reach it.
 */
export function mainMenuItems(gameCount: number): MenuItem[] {
  return [
    { id: 'settings', label: 'Settings' },
    { id: 'rescan', label: 'Update game library', detail: `${gameCount} games` },
    { id: 'minimise', label: 'Minimise' },
    { id: 'quit', label: 'Exit Marquee' },
    // Two presses each. Ending someone's session from a misread menu row is
    // not a mistake they can undo.
    { id: 'restart', label: 'Restart system', confirm: 'Restart? Press again' },
    { id: 'shutdown', label: 'Turn off system', confirm: 'Turn off? Press again' },
  ]
}
