/**
 * The game detail view: art, description, facts and actions on one scroll.
 * Opened with Y, closed with B. It takes all input while open, so navigation
 * cannot move the grid selection underneath.
 */
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import {
  setManualExecutable, removeManualGame, findExecutable, setHidden, uninstallGame,
  setCustomTitle, updateGame, viewInStore,
  type ArtworkManifest, type Game, type Meta, type Artwork,
} from './library'
import { toast } from './toast'
import { logInfo } from './log'
import { inApp } from './host'
import { el } from './dom'

export interface DetailView {
  readonly isOpen: boolean
  open(game: Game, meta: Meta | undefined, art: Artwork, provenance?: ArtworkManifest): void
  close(): void
  /** Returns true if the action was consumed. */
  handle(action: string): boolean
}

const SOURCE_NAMES: Record<string, string> = {
  steam: 'Steam',
  steamgriddb: 'SteamGridDB',
  composed: 'made from key art',
  none: 'missing',
}

function describeArtwork(m: ArtworkManifest | undefined): string {
  if (!m) return 'not resolved yet'
  if (m.steamComplete) return 'Steam — complete'
  // Per field, because "no wordmark" is actionable and "partly Steam" is not.
  const parts = [`cover ${SOURCE_NAMES[m.cover]}`, `art ${SOURCE_NAMES[m.hero]}`, `logo ${SOURCE_NAMES[m.logo]}`]
  const missing = m.cover === 'none' || m.logo === 'none'
  return parts.join(', ') + (missing ? ' — a SteamGridDB key would fill these' : '')
}

function minutesLabel(minutes: number): string {
  if (minutes <= 0) return 'Never played'
  if (minutes < 60) return `${minutes} minutes`
  return `${Math.round(minutes / 60)} hours`
}

/**
 * Point a hand-added game at its executable. Kept out of the add flow because
 * the user may not want to locate it yet.
 */
async function pickExecutable(game: Game, onChanged: () => void): Promise<void> {
  if (!inApp) return
  const id = Number(game.id.split(':')[1])
  if (!Number.isFinite(id)) return
  const picked = await openFileDialog({
    multiple: false,
    directory: false,
    title: `Where is ${game.title}?`,
    // Only Windows executables have a reliable extension, hence the '*'.
    filters: [{ name: 'Programs', extensions: ['exe', 'app', 'sh', 'bat', 'cmd', 'AppImage', '*'] }],
  })
  if (typeof picked !== 'string') return
  await setManualExecutable(id, picked)
  logInfo('detail', `${game.title} executable set to ${picked}`)
  toast(`${game.title} is ready to play.`)
  onChanged()
}

/**
 * What committing a rename should do. An unchanged title stores nothing, so it
 * does not pin the name against future metadata; an empty one clears the
 * override, which is the only way back to the provider's name.
 */
export function renameIntent(
  showing: string,
  typed: string,
): { kind: 'none' } | { kind: 'clear' } | { kind: 'set'; title: string } {
  const next = typed.trim()
  if (!next) return { kind: 'clear' }
  if (next === showing.trim()) return { kind: 'none' }
  return { kind: 'set', title: next }
}

/**
 * Reveal the rename field, then focus it a frame later. WebKit ignores
 * `.focus()` on an element revealed in the same tick.
 */
export function revealThenFocus(
  reveal: () => void,
  focus: () => void,
  schedule: (cb: () => void) => number = requestAnimationFrame,
): void {
  reveal()
  schedule(focus)
}

/** Which action button `left`/`right` moves to next, wrapping. */
export function nextActionFocus(action: string, current: number, count: number): number | undefined {
  if (count <= 0) return undefined
  const delta = action === 'left' ? -1 : action === 'right' ? 1 : 0
  if (delta === 0) return undefined
  const start = current < 0 ? (delta > 0 ? -1 : 0) : current
  return (start + delta + count) % count
}

export interface DetailHooks {
  onPlay(): void
  onChanged(): void
  /** Re-match this game's artwork against the store search. */
  onFindArtwork(game: Game): void
  /** Offer the on-screen keyboard for a field. main.ts owns it, because the
   *  input chain must consume for it first. */
  onTextField?(field: HTMLInputElement): void
  /** The rename field is going away; close the keyboard too (issue #18). */
  onTextFieldClosed?(): void
}

/**
 * Look for the executable in the usual places. The scan can take a couple of
 * seconds, so the button says what it is doing.
 */
async function autoLocate(game: Game, button: HTMLElement, onChanged: () => void): Promise<void> {
  const id = Number(game.id.split(':')[1])
  if (!Number.isFinite(id)) return
  const original = button.textContent
  button.textContent = 'Looking…'
  try {
    const found = await findExecutable(game.title)
    if (!found) {
      toast(
        `Could not find ${game.title}. Choose the file instead — once you have, ` +
          'games in that folder will be found automatically.',
        'error',
        7000,
      )
      return
    }
    await setManualExecutable(id, found)
    logInfo('detail', `${game.title} located at ${found}`)
    toast(`Found it: ${found.split(/[/\\]/).pop()}`, 'info', 5000)
    onChanged()
  } finally {
    button.textContent = original
  }
}

export function createDetail(hooks: DetailHooks): DetailView {
  const { onPlay, onChanged, onFindArtwork, onTextField, onTextFieldClosed } = hooks
  const root = el('div', 'detail', document.body)
  root.hidden = true

  const bg = el('div', 'detail-bg', root)
  const bgImg = el('img', undefined, bg)
  bgImg.alt = ''
  el('div', 'detail-scrim', bg)

  const scroll = el('div', 'detail-scroll', root)
  const body = el('div', 'detail-body', scroll)

  // Hide and Uninstall sit apart from the main actions so nobody hits them by
  // accident; `left`/`right` still reach them, or a pad could not.
  const corner = el('div', 'detail-corner', root)

  const logo = el('img', 'detail-logo', body)
  logo.alt = ''
  const title = el('h1', 'detail-title', body)

  // Renaming happens in place of the title rather than in another overlay.
  const rename = el('div', 'detail-rename', body)
  rename.hidden = true
  const renameField = el('input', 'detail-rename-field', rename)
  renameField.type = 'text'
  renameField.spellcheck = false
  renameField.setAttribute('aria-label', 'Game name')
  const renameHint = el('p', 'detail-rename-hint', rename)

  const tags = el('div', 'detail-tags', body)
  const actions = el('div', 'detail-actions', body)
  const desc = el('p', 'detail-desc', body)
  const facts = el('dl', 'detail-facts', body)

  let open = false
  /** The game on screen, so the rename knows what it is renaming. */
  let current: Game | undefined
  let renaming = false

  /** Everything a pad can land on, in the order `right` visits it. */
  function ring(): HTMLElement[] {
    return [...actions.children, ...corner.children] as HTMLElement[]
  }

  function endRename(): void {
    if (renaming) onTextFieldClosed?.()
    renaming = false
    rename.hidden = true
    renameField.blur()
    // A wordmark hides the typed title; restore whichever open() chose.
    logo.hidden = !logoAvailable
    title.hidden = logoAvailable
  }

  function beginRename(): void {
    if (!current) return
    renaming = true
    logo.hidden = true
    title.hidden = true
    renameField.value = current.title || ''
    // The legend is hidden behind the overlay, so state both pad and keys.
    renameHint.textContent =
      'A or Enter saves · B or Esc cancels · leave it empty to restore the original name'
    revealThenFocus(
      () => { rename.hidden = false },
      () => { renameField.focus(); renameField.select() },
    )
    onTextField?.(renameField)
  }

  async function commitRename(): Promise<void> {
    const game = current
    if (!game) return
    const intent = renameIntent(game.title, renameField.value)
    endRename()
    if (intent.kind === 'none') return
    const title = intent.kind === 'set' ? intent.title : null
    try {
      await setCustomTitle(game.id, title)
      logInfo('detail', title ? `renamed ${game.id} to ${title}` : `cleared the name of ${game.id}`)
      toast(title ? `Renamed to ${title}.` : 'Original name restored.')
      onChanged()
    } catch (e) {
      toast(`Could not rename that. ${String(e)}`, 'error', 6000)
    }
  }

  renameField.addEventListener('keydown', (e) => {
    // The global key handler ignores focused fields, so catch these here.
    if (e.key === 'Enter') { e.preventDefault(); void commitRename() }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endRename() }
  })

  /** Whether the current game has a wordmark, so endRename can restore it. */
  let logoAvailable = false

  function addFact(label: string, value: string): void {
    if (!value) return
    const dt = el('dt', undefined, facts)
    dt.textContent = label
    const dd = el('dd', undefined, facts)
    dd.textContent = value
  }

  function close(): void {
    // Or a half-finished edit reappears over the next game opened.
    endRename()
    open = false
    root.hidden = true
  }

  return {
    get isOpen() { return open },

    open(game, meta, art, provenance) {
      const wasOpen = open
      // main.ts reopens to attach the artwork report, which rebuilds the
      // buttons; remember focus so it does not jump back to the first.
      const priorActionFocus = wasOpen
        ? ring().indexOf(document.activeElement as HTMLElement)
        : -1
      open = true
      root.hidden = false
      // Two frames: WebKit skips a transition started in the same frame as
      // `display` changes. Not on a reopen, which must not re-animate.
      if (!wasOpen) {
        root.classList.add('is-entering')
        requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('is-entering')))
      }
      scroll.scrollTop = 0

      if (art.hero) { bgImg.src = art.hero; bgImg.hidden = false } else { bgImg.hidden = true }

      // The wordmark replaces the typed title rather than sitting beside it.
      current = game
      endRename()
      const hasLogo = !!art.logo
      logoAvailable = hasLogo
      logo.hidden = !hasLogo
      title.hidden = hasLogo
      if (hasLogo && logo.getAttribute('src') !== art.logo) logo.src = art.logo!
      logo.onerror = () => {
        logoAvailable = false
        logo.hidden = true
        if (!renaming) title.hidden = false
      }
      title.textContent = game.title || `App ${game.providerId}`

      tags.textContent = ''
      for (const genre of meta?.genres ?? []) {
        const tag = el('span', 'tag', tags)
        tag.textContent = genre
      }

      corner.textContent = ''
      const hide = el('button', 'action action-quiet', corner)
      hide.textContent = game.hidden ? 'Unhide' : 'Hide this game'
      hide.onclick = () => {
        void setHidden(game.id, !game.hidden)
          .then(() => {
            toast(game.hidden
              ? `${game.title} is back in the library.`
              : `${game.title} hidden. Find it again under Show → Hidden.`, 'info', 6000)
            close()
            onChanged()
          })
          .catch((e) => toast(`Could not do that. ${String(e)}`, 'error'))
      }

      if (game.installed) {
        const remove = el('button', 'action action-quiet', corner)
        remove.textContent = 'Uninstall'
        // Two presses, like the machine actions in the main menu.
        let armed = false
        remove.onclick = () => {
          if (!armed) {
            armed = true
            remove.textContent = 'Uninstall — press again'
            remove.classList.add('is-armed')
            window.setTimeout(() => {
              armed = false
              remove.textContent = 'Uninstall'
              remove.classList.remove('is-armed')
            }, 4000)
            return
          }
          void uninstallGame(game.id)
            .then((what) => {
              logInfo('detail', `uninstall ${game.title}: ${what}`)
              toast(game.provider === 'steam'
                ? `Handed ${game.title} to Steam to uninstall.`
                : `${game.title} no longer has an executable.`, 'info', 6000)
              close()
              onChanged()
            })
            .catch((e) => toast(`Could not uninstall that. ${String(e)}`, 'error', 6000))
        }
      }

      actions.textContent = ''
      const manual = game.provider === 'manual'

      if (manual && !game.installed) {
        // No Play button that cannot work. Browsing comes first: whoever added
        // the game by hand usually knows where it is, and a guess may not.
        const set = el('button', 'action action-primary', actions)
        set.textContent = 'Choose file…'
        set.onclick = () => {
          void pickExecutable(game, onChanged).catch((e) =>
            toast(`Could not set that. ${String(e)}`, 'error'))
        }

        // Searches first in folders the user has chosen files from before.
        const find = el('button', 'action', actions)
        find.textContent = 'Look for it'
        find.onclick = () => void autoLocate(game, find, onChanged)
      } else {
        const play = el('button', 'action action-primary', actions)
        play.textContent = game.installed ? 'Play' : 'Install and play'
        play.onclick = onPlay
      }

      // Only starts a download Steam already has queued; hidden once it runs.
      if (game.provider === 'steam' && game.updateAvailable && !game.updating) {
        const update = el('button', 'action', actions)
        update.textContent = 'Update'
        update.onclick = () => {
          void updateGame(game.id)
            .then(() => {
              toast(`Handed ${game.title} to Steam to update.`, 'info', 6000)
              onChanged()
            })
            .catch((e) => toast(`Could not start that update. ${String(e)}`, 'error', 6000))
        }
      }

      if (game.provider === 'steam') {
        const store = el('button', 'action', actions)
        store.textContent = 'View in Steam Store'
        store.onclick = () => {
          void viewInStore(game.id)
            .then(() => toast(`Opened ${game.title} in the Steam store.`, 'info', 4000))
            .catch((e) => toast(`Could not open that. ${String(e)}`, 'error', 6000))
        }
      }

      // Any game: a Steam release can lack a cover on the CDN or be listed
      // under a different name.
      const artwork = el('button', 'action', actions)
      artwork.textContent = 'Find artwork'
      artwork.onclick = () => onFindArtwork(game)

      // Any game: store names often carry edition suffixes.
      const renameButton = el('button', 'action', actions)
      renameButton.textContent = 'Rename'
      renameButton.onclick = beginRename

      if (manual) {
        const change = el('button', 'action', actions)
        change.textContent = game.installed ? 'Change executable' : 'Remove'
        change.onclick = () => {
          const id = Number(game.id.split(':')[1])
          if (game.installed) {
            void pickExecutable(game, onChanged).catch((e) =>
              toast(`Could not set that. ${String(e)}`, 'error'))
          } else {
            void removeManualGame(id)
              .then(() => { toast(`Removed ${game.title}.`); onChanged() })
              .catch((e) => toast(`Could not remove that. ${String(e)}`, 'error'))
          }
        }
      }

      desc.textContent = meta?.description ?? ''
      desc.hidden = !meta?.description

      facts.textContent = ''
      addFact('Playtime', minutesLabel(game.playtimeMinutes))
      addFact('Released', meta?.releaseDate ?? '')
      addFact('Developer', (meta?.developers ?? []).join(', '))
      addFact('Publisher', (meta?.publishers ?? []).join(', '))
      addFact('Score', meta?.score ? `${meta.score} / 100` : '')
      addFact('Status', game.updating
        ? 'Updating…'
        : game.updateAvailable
          ? 'Update available'
          : game.installed ? 'Installed' : 'Not installed')
      addFact('Store', game.provider === 'steam' ? 'Steam' : 'Added by hand')
      addFact('Executable', game.installDir ?? '')
      addFact('Artwork', describeArtwork(provenance))

      // Focus a button so A has something to press, a frame later because
      // WebKit ignores focus() on an element revealed this tick.
      const actionButtons = ring()
      if (wasOpen) {
        if (priorActionFocus >= 0) {
          actionButtons[Math.min(priorActionFocus, actionButtons.length - 1)]?.focus()
        }
      } else {
        requestAnimationFrame(() => actionButtons[0]?.focus())
      }
    },

    close,

    handle(action) {
      if (!open) return false
      // B cancels the edit, not the whole view.
      if (renaming) {
        if (action === 'a') void commitRename()
        else if (action === 'b') endRename()
        return true
      }
      // Swallow everything, or the grid moves behind the overlay.
      if (action === 'b' || action === 'y') { close(); return true }
      if (action === 'up') { scroll.scrollBy({ top: -220, behavior: 'smooth' }); return true }
      if (action === 'down') { scroll.scrollBy({ top: 220, behavior: 'smooth' }); return true }
      const buttons = ring()
      if (action === 'a') {
        const active = document.activeElement
        // The first button if A beats the deferred initial focus.
        const target = active instanceof HTMLElement && buttons.includes(active) ? active : buttons[0]
        target?.click()
        return true
      }
      const current = buttons.indexOf(document.activeElement as HTMLElement)
      const next = nextActionFocus(action, current, buttons.length)
      if (next !== undefined) buttons[next]?.focus()
      return true
    },
  }
}
