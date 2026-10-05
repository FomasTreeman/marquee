/**
 * A list menu, shared by the main menu and the sort menu so they behave alike.
 * Anchored to the control that opened it rather than centred, as on consoles.
 */
import { logInfo } from './log'
import { el } from './dom'

export interface MenuItem {
  id: string
  label: string
  /** Shown dimmed to the right, such as a current value or a count. */
  detail?: string
  /** Marks the current choice. */
  selected?: boolean
  /** Present but unusable, with the reason shown. */
  disabled?: string
  /** Asks for a second press, for anything that ends the session. */
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
      // Confirmation replaces the label: one press arms, a second commits, and
      // B or moving away disarms.
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
    // Skip disabled rows.
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
      // Start on the current choice.
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
        // Swallow everything else; the menu is modal.
      }
      return true
    },
  }
}

/**
 * Ids that end the user's session, mirroring `Action::affects_the_machine` in
 * src-tauri/src/system.rs. Kept as data so a test can assert they need two presses.
 */
export const ENDS_THE_SESSION = ['restart', 'shutdown'] as const

/**
 * The Start-button menu. Ids must match `Action::parse` in Rust, except
 * `settings` and `rescan`, which the frontend handles.
 */
export function mainMenuItems(gameCount: number): MenuItem[] {
  return [
    { id: 'settings', label: 'Settings' },
    { id: 'rescan', label: 'Update game library', detail: `${gameCount} games` },
    { id: 'minimise', label: 'Minimise' },
    { id: 'quit', label: 'Exit Marquee' },
    // Two presses each, as ending the session cannot be undone.
    { id: 'restart', label: 'Restart system', confirm: 'Restart? Press again' },
    { id: 'shutdown', label: 'Turn off system', confirm: 'Turn off? Press again' },
  ]
}
