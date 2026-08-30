/**
 * Settings.
 *
 * Two sections, and both exist because of something that cannot be recovered
 * any other way:
 *
 *   * **Artwork** — Steam publishes a grey placeholder where some covers should
 *     be and no wordmark at all for plenty of games. A SteamGridDB key fills
 *     those in. Optional, and the screen says so rather than presenting an
 *     empty field as though setup were incomplete.
 *
 *   * **Your profile** — favourites, hidden games, hand-added games and where
 *     they live, artwork corrections. A fresh install wipes the database
 *     holding it and none of it can be rebuilt by scanning.
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

/** A titled block with an explanation and its own controls. */
function section(parent: HTMLElement, title: string, note: string) {
  const root = el('section', 'settings-section', parent)
  el('h3', 'settings-heading', root).textContent = title
  el('p', 'settings-note', root).textContent = note
  return { root, controls: el('div', 'settings-controls', root) }
}

export function createSettings(onChanged: () => void): SettingsView {
  const root = el('div', 'settings', document.body)
  root.hidden = true
  const panel = el('div', 'settings-panel', root)

  const header = el('header', 'settings-header', panel)
  el('h2', 'settings-title', header).textContent = 'Settings'
  el('span', 'settings-dismiss', header).textContent = 'B to close'

  const body = el('div', 'settings-body', panel)

  // --- artwork --------------------------------------------------------
  const artwork = section(
    body,
    'Artwork',
    'Steam has no cover for some recent releases and no wordmark for a lot of ' +
      'games. SteamGridDB has both, and a key is free: sign in at ' +
      'steamgriddb.com, open Preferences → API, generate one. Everything works ' +
      'without it — this only fills in what Steam is missing.',
  )
  const field = el('input', 'settings-field', artwork.controls)
  field.type = 'text'
  field.autocomplete = 'off'
  field.spellcheck = false
  field.placeholder = 'Paste a SteamGridDB key'
  const saveKey = el('button', 'action action-primary', artwork.controls)
  saveKey.textContent = 'Save key'
  const keyStatus = el('p', 'settings-status', artwork.root)

  // --- profile --------------------------------------------------------
  const profile = section(
    body,
    'Your profile',
    'Favourites, hidden games, anything added by hand and where it lives, and ' +
      'artwork corrections. None of it can be rebuilt by scanning.',
  )
  const exportButton = el('button', 'action', profile.controls)
  exportButton.textContent = 'Export…'
  const importButton = el('button', 'action', profile.controls)
  importButton.textContent = 'Import…'
  const folderButton = el('button', 'action action-primary', profile.controls)
  const folderStatus = el('p', 'settings-status', profile.root)

  let open = false
  let saving = false
  let profileFolder = ''

  function describeFolder(): void {
    folderButton.textContent = profileFolder ? 'Change folder…' : 'Keep a copy in…'
    folderStatus.textContent = profileFolder
      ? `Kept in ${profileFolder}, rewritten whenever anything changes.`
      : 'Choose a folder and a copy is kept there automatically. A second drive ' +
        'survives reinstalling this machine; a synced folder reaches another one.'
  }

  async function commitKey(): Promise<void> {
    if (saving) return
    saving = true
    keyStatus.textContent = 'Saving…'
    try {
      await setSteamGridDbKey(field.value)
      logInfo('settings', field.value.trim() ? 'SteamGridDB key set' : 'SteamGridDB key cleared')
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
      keyStatus.textContent = String(e)
    } finally {
      saving = false
    }
  }

  saveKey.onclick = () => void commitKey()

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
      const summary = await importProfile(picked)
      logInfo('profile', `imported from ${picked}`)
      toast(
        `Imported ${summary.games} game settings and ${summary.manual} hand-added games.`,
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
      requestAnimationFrame(() =>
        requestAnimationFrame(() => root.classList.remove('is-entering')))
      keyStatus.textContent = ''
      field.value = ''
      profileFolder = ''
      describeFolder()
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
      else if (action === 'a') void commitKey()
      return true
    },
  }
}
