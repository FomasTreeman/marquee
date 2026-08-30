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
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import {
  getSettings, setSteamGridDbKey, exportProfile, importProfile, setProfileFolder,
} from './library'
import { logInfo, logWarn } from './log'
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

  // --- profile --------------------------------------------------------
  //
  // The small, irreplaceable half of this app's state: favourites, hidden
  // games, hand-added games and where they live, artwork corrections. A fresh
  // Windows install wipes the database holding it, and none of it can be
  // rebuilt by scanning — nobody remembers which forty games they had hidden.
  const profileLabel = el('p', 'add-sub', panel)
  profileLabel.textContent = 'Your profile'
  profileLabel.style.marginTop = 'calc(30px * var(--s))'

  const profileHelp = el('p', 'settings-help', panel)
  const folderRow = el('div', 'detail-actions', panel)

  const exportButton = el('button', 'action', folderRow)
  exportButton.textContent = 'Export…'
  const importButton = el('button', 'action', folderRow)
  importButton.textContent = 'Import…'
  const folderButton = el('button', 'action', folderRow)

  let profileFolder = ''

  function describeFolder(): void {
    folderButton.textContent = profileFolder ? 'Change folder…' : 'Keep a copy in…'
    profileHelp.textContent = profileFolder
      ? `A copy is kept in ${profileFolder} and rewritten whenever anything changes. ` +
        'Put that folder on a second drive or a synced one and it survives reinstalling this machine.'
      : 'Export writes a file you can keep anywhere. Better: choose a folder and a ' +
        'copy is kept there automatically, rewritten on every change. A second drive ' +
        'survives a reinstall; a synced folder reaches another machine.'
  }

  exportButton.onclick = async () => {
    const path = await saveDialog({ title: 'Save your profile', defaultPath: 'marquee-profile.json' })
    if (typeof path !== 'string') return
    try {
      await exportProfile(path)
      toast(`Profile saved to ${path}`, 'info', 6000)
    } catch (e) {
      toast(`Could not save that. ${String(e)}`, 'error', 7000)
    }
  }

  importButton.onclick = async () => {
    const picked = await openDialog({
      title: 'Choose a profile',
      multiple: false,
      filters: [{ name: 'Marquee profile', extensions: ['json'] }],
    })
    if (typeof picked !== 'string') return
    try {
      const s = await importProfile(picked)
      logInfo('profile', `imported from ${picked}`)
      toast(
        `Imported ${s.games} game settings and ${s.manual} hand-added games.`,
        'info',
        7000,
      )
      close()
      onChanged()
    } catch (e) {
      toast(`Could not import that. ${String(e)}`, 'error', 8000)
    }
  }

  folderButton.onclick = async () => {
    const picked = await openDialog({ title: 'Where should the copy live?', directory: true })
    if (typeof picked !== 'string') return
    try {
      await setProfileFolder(picked)
      profileFolder = picked
      describeFolder()
      toast('A copy will be kept there from now on.', 'info', 5000)
    } catch (e) {
      logWarn('profile', 'could not set the folder', e)
      toast(`Could not use that folder. ${String(e)}`, 'error', 7000)
    }
  }

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
        .then((s) => {
          field.value = s.steamgriddbKey
          profileFolder = s.profileFolder
          describeFolder()
        })
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
