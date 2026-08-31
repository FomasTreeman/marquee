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
  diagnosticReport, exportProfile, getSettings, importProfile, setProfileFolder, setSetting, setSteamGridDbKey,
} from './library'
import { onAnyInput, padStatus, webviewPads } from './input'
import { applyBackgroundStyle, resolveBackgroundStyle, type BackgroundStyle } from './perf'
import { hostInfo } from './host'
import { checkForUpdate } from './update'
import { logInfo, logWarn } from './log'
import { toast } from './toast'

/**
 * Which focusable index `up`/`down` should land on next, skipping anything
 * disabled -- landing the cursor on a button that does nothing is the same
 * class of bug as not moving it at all. `undefined` for a direction that is
 * not a move, or when nothing in the list can take focus.
 *
 * A pure decision so it is checkable without a DOM, per this project's
 * no-jsdom convention. This used to be `settingsScrollDelta`, which scrolled
 * the panel by a fixed pixel amount on `up`/`down` -- so the left stick moved
 * the view, but nothing was ever actually focused, and `A` always did the one
 * thing it had always done (save the SteamGridDB key) no matter where you had
 * scrolled to. Settings could be scrolled but not driven.
 */
export function nextSettingsFocus(
  action: string,
  current: number,
  count: number,
  isDisabled: (index: number) => boolean,
): number | undefined {
  if (count <= 0) return undefined
  const delta = action === 'up' ? -1 : action === 'down' ? 1 : 0
  if (delta === 0) return undefined
  // Nothing focused yet (the panel just opened, say): down should reach the
  // first control and up the last, rather than both landing wherever -1
  // happens to wrap to.
  let next = current < 0 ? (delta > 0 ? -1 : 0) : current
  for (let step = 0; step < count; step++) {
    next = (next + delta + count) % count
    if (!isDisabled(next)) return next
  }
  return undefined
}

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

export function createSettings(onChanged: () => void, onClose?: () => void): SettingsView {
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

  // --- launching ------------------------------------------------------
  const launching = section(
    body,
    'Launching',
    'Marquee is fullscreen, and a fullscreen window in front of a game that is ' +
      'still starting is how a game ends up running but hidden behind it.',
  )
  const minimiseToggle = el('button', 'action', launching.controls)
  let minimiseOnLaunch = true

  function describeMinimise(): void {
    minimiseToggle.textContent = minimiseOnLaunch
      ? 'Minimise when a game starts: on'
      : 'Minimise when a game starts: off'
    minimiseToggle.classList.toggle('action-primary', minimiseOnLaunch)
  }

  minimiseToggle.onclick = () => {
    minimiseOnLaunch = !minimiseOnLaunch
    describeMinimise()
    void setSetting('minimise_on_launch', minimiseOnLaunch ? '1' : '0')
      .catch((e) => toast(`Could not save that. ${String(e)}`, 'error'))
  }

  // --- background -------------------------------------------------------
  const background = section(
    body,
    'Background',
    'Grain is a fixed texture behind everything and costs nothing to redraw. ' +
      'Blur softens the hero art behind the grid instead -- it reads well, but ' +
      'costs more, so it is worth turning off on an older machine.',
  )
  const backgroundToggle = el('button', 'action', background.controls)
  let backgroundStyle: BackgroundStyle = 'grain'

  function describeBackground(): void {
    backgroundToggle.textContent = backgroundStyle === 'blur' ? 'Background: blur' : 'Background: grain'
    backgroundToggle.classList.toggle('action-primary', backgroundStyle === 'blur')
  }

  backgroundToggle.onclick = () => {
    backgroundStyle = backgroundStyle === 'blur' ? 'grain' : 'blur'
    describeBackground()
    applyBackgroundStyle(backgroundStyle)
    void setSetting('background_style', backgroundStyle)
      .catch((e) => toast(`Could not save that. ${String(e)}`, 'error'))
  }

  // --- updates --------------------------------------------------------
  //
  // The automatic check is deliberately quiet and only fires once, well after
  // startup, on an idle screen. That is right for daily use and useless for
  // finding out whether the thing works, so there is a button that asks now
  // and reports whatever it finds, including "nothing".
  const updates = section(
    body,
    'Updates',
    'Checked once shortly after launch, and only offered when nothing else is ' +
      'on screen. Every update is signed, and one that fails its signature ' +
      'check will not install.',
  )
  const updateButton = el('button', 'action', updates.controls)
  updateButton.textContent = 'Check for updates'
  const updateStatus = el('p', 'settings-status', updates.root)
  let version = ''
  void hostInfo()
    .then((h) => { version = h.version; updateStatus.textContent = `Version ${version}.` })
    .catch(() => { /* the version is a nicety; the button works without it */ })

  updateButton.onclick = () => {
    updateButton.disabled = true
    updateStatus.textContent = 'Checking…'
    void checkForUpdate()
      .then(async (update) => {
        if (!update) {
          updateStatus.textContent = `Version ${version} is the latest.`
          return
        }
        updateStatus.textContent = `Version ${update.version} is available. Downloading…`
        await update.install((percent) => {
          if (percent !== undefined) {
            updateStatus.textContent = `Downloading ${update.version}… ${percent}%`
          }
        })
      })
      .catch((e) => {
        // Asked for explicitly, so unlike the automatic check this reports its
        // failure rather than swallowing it.
        logWarn('update', 'manual update check failed', e)
        updateStatus.textContent = `Could not check for updates. ${String(e)}`
      })
      .finally(() => { updateButton.disabled = false })
  }

  // --- controller -----------------------------------------------------
  //
  // Silence here is unhelpful: a pad that does not work looks identical to an
  // app that does not support one. On Windows the usual cause is not a fault
  // at all, and saying so is the whole value of this section.
  const pad = section(
    body,
    'Controller',
    'Everything here works with a pad, a keyboard or a mouse. The legend along ' +
      'the bottom follows whichever you last used.',
  )
  const padStatusLine = el('p', 'settings-status', pad.root)
  /** The detail behind the headline: which backend, and what it enumerated. */
  const padDetail = el('pre', 'settings-diagnostic', pad.root)

  /**
   * Say what is actually happening, not what is probably happening.
   *
   * This screen used to guess -- it told Windows users that only
   * Xbox-compatible pads are visible and to install DS4Windows, which was
   * wrong: the backend is Windows.Gaming.Input, which enumerates any HID game
   * controller. A confident wrong answer sends someone off installing drivers
   * they do not need, so this now reports the backend, every device it saw,
   * and anything the webview can see that the backend could not.
   */
  async function describePad(): Promise<void> {
    try {
      const status = await padStatus()
      const web = webviewPads()

      if (status.connected > 0) {
        padStatusLine.textContent =
          `${status.connected} controller${status.connected === 1 ? '' : 's'} connected.`
      } else if (status.failure) {
        padStatusLine.textContent = status.failure
      } else if (!status.supported) {
        padStatusLine.textContent =
          'This machine reports no gamepad support at all. Keyboard and mouse only.'
      } else if (web.length) {
        // The interesting case: the native path is running and saw nothing,
        // but the webview can see the pad, so the fallback is driving it.
        padStatusLine.textContent =
          `${status.backend} found no controller, but the webview can see ` +
          `${web.length === 1 ? 'one' : web.length}. Marquee is using that instead — ` +
          'everything works, latency is a little higher.'
      } else {
        padStatusLine.textContent =
          'No controller detected. Plug one in, press a button, then reopen this screen — ' +
          'a wireless pad is invisible until it has something to say.'
      }

      const driving = web.length && status.connected < web.length
        ? 'the webview' : status.backend
      const lines = [`driving: ${driving}`, `${status.backend} sees:`]
      if (status.silenced.length) {
        // A control that has been switched off must say so somewhere findable.
        // Doing it silently is the same class of mistake as the fault it was
        // added to work around.
        lines.push(`ignoring: ${status.silenced.join(', ')} — reporting faster than a hand can`)
      }
      for (const d of status.devices) lines.push(`  ${d}`)
      if (!status.devices.length) lines.push('  (nothing enumerated)')
      lines.push('the webview sees:')
      for (const d of web) lines.push(`  ${d}`)
      if (!web.length) lines.push('  (nothing)')
      // The two read genuinely different APIs, so either can see a pad the
      // other cannot. Which is the whole reason both exist.
      if (web.length !== status.connected) {
        lines.push(`(the two disagree: ${status.connected} native, ${web.length} in the webview)`)
      }
      padDetail.textContent = lines.join('\n')
      padDetail.hidden = false
    } catch (e) {
      logWarn('input', 'could not read controller status', e)
      padStatusLine.textContent = ''
      padDetail.hidden = true
    }
  }

  /**
   * What the controller is actually sending.
   *
   * Enumerating devices answers "is it there". It does not answer "why does
   * this button do nothing", which is a different question and the one that
   * keeps being asked -- a pad whose buttons arrive under names we do not map
   * behaves exactly like a pad that sends nothing at all, and no amount of
   * staring at a device list separates the two.
   *
   * So: press a button, see what arrived. Including the ones that mapped to
   * nothing, which are the interesting ones.
   */
  const testButton = el('button', 'action', pad.controls)
  testButton.textContent = 'Test a controller'
  const testOut = el('pre', 'settings-diagnostic', pad.root)
  testOut.hidden = true

  /**
   * A report you can paste, rather than one you have to read out.
   *
   * Three rounds of this project's controller debugging turned on a
   * distinction between two device lists that was on screen the whole time.
   * Asking somebody to transcribe a diagnosis is a poor way to get one.
   */
  const reportButton = el('button', 'action', pad.controls)
  reportButton.textContent = 'Copy a debug report'
  reportButton.onclick = () => {
    void diagnosticReport()
      .then(async (report) => {
        // The webview's own view of the hardware is not visible to Rust, and
        // it is half the answer whenever the two disagree.
        const web = webviewPads()
        const full =
          `${report}\n-- the webview sees --\n` +
          (web.length ? web.map((d) => `  ${d}`).join('\n') : '  (nothing)') +
          '\n'
        await navigator.clipboard.writeText(full)
        toast('Debug report copied. Paste it into an issue.', 'info', 6000)
        logInfo('diag', 'debug report copied')
      })
      .catch((e) => {
        logWarn('diag', 'could not build the report', e)
        toast(`Could not copy that. ${String(e)}`, 'error', 6000)
      })
  }

  let testing = false
  let seen: string[] = []
  let stopTest: (() => void) | undefined

  function note(line: string): void {
    // Newest first: the thing you just pressed should not be off the bottom.
    seen.unshift(line)
    seen = seen.slice(0, 12)
    testOut.textContent = seen.join('\n')
  }

  testButton.onclick = () => {
    testing = !testing
    testButton.textContent = testing ? 'Stop testing' : 'Test a controller'
    testButton.classList.toggle('action-primary', testing)
    testOut.hidden = !testing
    if (!testing) { stopTest?.(); stopTest = undefined; return }

    seen = []
    note('Press every button in turn. Anything that arrives shows up here.')
    stopTest = onAnyInput(
      (action, device) => note(`${device.padEnd(8)} ${action}`),
      (raw) => note(`unmapped  ${raw}   <- this is why that button does nothing`),
    )
  }

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
  // The exported file contains the SteamGridDB key. Small stakes -- it is a
  // free, per-user, rate-limited key -- but somebody sharing a profile should
  // know what is in it rather than find out.
  const profileWarning = el('p', 'settings-status', profile.root)
  profileWarning.textContent =
    'The file includes your SteamGridDB key, so it moves to a new machine with ' +
    'everything else. Worth knowing before sharing one.'

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

  /**
   * Every control `up`/`down` should be able to reach, top to bottom in the
   * order they read on screen. Kept as one flat list rather than per-section
   * groups because a controller does not care which section it is in, only
   * what is next.
   */
  const focusables: HTMLElement[] = [
    field, saveKey, minimiseToggle, backgroundToggle, updateButton,
    testButton, reportButton, exportButton, importButton, folderButton,
  ]

  function isDisabled(el: HTMLElement): boolean {
    return el instanceof HTMLButtonElement && el.disabled
  }

  function close(): void {
    open = false
    root.hidden = true
    field.blur()
    // The field this screen owns is the only reason the on-screen keyboard is
    // ever attached here; leaving it up after the field is gone is issue #18.
    onClose?.()
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
      void describePad()
      profileFolder = ''
      describeFolder()
      describeMinimise()
      describeBackground()
      void getSettings()
        .then((s) => {
          field.value = s.steamgriddbKey
          profileFolder = s.profileFolder
          minimiseOnLaunch = s.minimiseOnLaunch
          backgroundStyle = resolveBackgroundStyle(s.backgroundStyle)
          describeFolder()
          describeMinimise()
          describeBackground()
        })
        .catch(() => { /* an unreadable setting is an empty field, not an error */ })
      requestAnimationFrame(() => field.focus())
    },

    close,

    handle(action) {
      if (!open) return false
      if (action === 'b') { close(); return true }
      if (action === 'a') {
        const active = document.activeElement
        // The field keeps its old shortcut -- A saves the key -- because
        // clicking a text input does nothing. Everything else is a real
        // button now that it can actually be reached, so A is just a click.
        if (active === field) void commitKey()
        else if (active instanceof HTMLElement && focusables.includes(active)) active.click()
        return true
      }
      const current = focusables.indexOf(document.activeElement as HTMLElement)
      const next = nextSettingsFocus(action, current, focusables.length, (i) => isDisabled(focusables[i]!))
      if (next !== undefined) {
        const target = focusables[next]!
        target.focus()
        target.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
      return true
    },
  }
}
