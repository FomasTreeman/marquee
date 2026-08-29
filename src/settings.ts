/**
 * Settings.
 *
 * One setting so far, and it earns its own screen because without it a lot of
 * libraries look half-finished: **a SteamGridDB key**.
 *
 * Steam's own artwork has real gaps — recent releases publish a grey
 * placeholder where a cover should be, and plenty of games have no transparent
 * wordmark at all. SteamGridDB fills them. The key is free, generated from a
 * profile page, and carries no client secret, which is exactly why it is the
 * second source rather than something needing a server.
 *
 * Strictly optional: everything works without it, and this screen says so
 * rather than presenting an empty field as though setup were incomplete.
 */
import { getSettings, setSteamGridDbKey } from './library'
import { logInfo } from './log'
import { toast } from './toast'

export interface SettingsView {
  readonly isOpen: boolean
  readonly field: HTMLInputElement
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

export function createSettings(onChanged: () => void): SettingsView {
  const root = el('div', 'add', document.body)
  root.hidden = true

  const panel = el('div', 'add-panel', root)
  const heading = el('h2', 'add-heading', panel)
  heading.textContent = 'Settings'

  const label = el('p', 'add-sub', panel)
  label.textContent = 'SteamGridDB key — optional, and free'

  const field = el('input', 'add-field', panel)
  field.type = 'text'
  field.autocomplete = 'off'
  field.spellcheck = false
  field.placeholder = 'Paste a key to fill in missing artwork'

  const help = el('p', 'settings-help', panel)
  help.textContent =
    'Steam has no cover for some recent releases and no wordmark for a lot of ' +
    'games. SteamGridDB has both. Sign in at steamgriddb.com, open Preferences ' +
    '→ API, and generate a key. Everything works without one; this only fills ' +
    'in what Steam is missing.'

  const status = el('div', 'add-status', panel)
  const actions = el('div', 'detail-actions', panel)
  const save = el('button', 'action action-primary', actions)
  save.textContent = 'Save'

  let open = false
  let saving = false

  async function commit(): Promise<void> {
    if (saving) return
    saving = true
    status.textContent = 'Saving…'
    try {
      await setSteamGridDbKey(field.value)
      logInfo('settings', field.value.trim() ? 'SteamGridDB key set' : 'SteamGridDB key cleared')
      // Artwork is re-resolved from scratch, so say what will happen rather
      // than leaving the grid to change on its own with no explanation.
      toast(
        field.value.trim()
          ? 'Key saved. Missing artwork will fill in as you browse.'
          : 'Key cleared.',
        'info',
        6000,
      )
      close()
      onChanged()
    } catch (e) {
      status.textContent = String(e)
    } finally {
      saving = false
    }
  }

  save.onclick = () => void commit()

  function close(): void {
    open = false
    root.hidden = true
    field.blur()
  }

  return {
    get isOpen() { return open },
    get field() { return field },

    open() {
      open = true
      root.hidden = false
      root.classList.add('is-entering')
      requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('is-entering')))
      status.textContent = ''
      field.value = ''
      void getSettings()
        .then((s) => { field.value = s.steamgriddbKey })
        .catch(() => { /* an unreadable setting is an empty field, not an error */ })
      requestAnimationFrame(() => field.focus())
    },

    close,

    handle(action) {
      if (!open) return false
      if (action === 'b') close()
      else if (action === 'a') void commit()
      return true
    },
  }
}
