/**
 * The game detail view.
 *
 * Everything at once, on one scroll: art, description, facts, actions. A
 * launcher's detail page is read from across a room, so it favours a few large
 * things over many small ones, and it never hides anything behind a tab.
 *
 * Opened with Y, closed with B. It takes over input entirely while open --
 * navigation must not reach the grid underneath, or closing it lands the
 * cursor somewhere the user did not leave it.
 */
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import {
  setManualExecutable, removeManualGame, findExecutable, setHidden, uninstallGame,
  setCustomTitle, updateGame,
  type ArtworkManifest, type Game, type Meta, type Artwork,
} from './library'
import { toast } from './toast'
import { logInfo } from './log'
import { inApp } from './host'

export interface DetailView {
  readonly isOpen: boolean
  open(game: Game, meta: Meta | undefined, art: Artwork, provenance?: ArtworkManifest): void
  close(): void
  /** Returns true if the action was consumed. */
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

const SOURCE_NAMES: Record<string, string> = {
  steam: 'Steam',
  steamgriddb: 'SteamGridDB',
  composed: 'made from key art',
  none: 'missing',
}

function describeArtwork(m: ArtworkManifest | undefined): string {
  if (!m) return 'not resolved yet'
  if (m.steamComplete) return 'Steam — complete'
  // Named per field, because "partly Steam" is not actionable and "no
  // wordmark" is.
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
 * Point a hand-added game at its executable.
 *
 * Deliberately separate from adding, and reached from here rather than from
 * the add flow: a game is complete once it is identified, and locating it on
 * disk is a different question the user may not want to answer yet.
 */
async function pickExecutable(game: Game, onChanged: () => void): Promise<void> {
  if (!inApp) return
  const id = Number(game.id.split(':')[1])
  if (!Number.isFinite(id)) return
  const picked = await openFileDialog({
    multiple: false,
    directory: false,
    title: `Where is ${game.title}?`,
    // Windows is the only platform where filtering helps; elsewhere an
    // executable has no reliable extension, so anything goes.
    filters: [{ name: 'Programs', extensions: ['exe', 'app', 'sh', 'bat', 'cmd', 'AppImage', '*'] }],
  })
  if (typeof picked !== 'string') return
  await setManualExecutable(id, picked)
  logInfo('detail', `${game.title} executable set to ${picked}`)
  toast(`${game.title} is ready to play.`)
  onChanged()
}

/**
 * What committing a rename should actually do.
 *
 * Three outcomes, and the difference matters: writing a title identical to the
 * one already showing would store an override that pins the name against
 * future metadata, and an empty field has to clear the override rather than
 * store an empty string -- that is the only route back to the provider's own
 * name, so it cannot be a separate button nobody finds.
 *
 * Pure so the rule can be tested; the field and the toast around it cannot be.
 */
export function renameIntent(
  showing: string,
  typed: string,
): { kind: 'none' } | { kind: 'clear' } | { kind: 'set'; title: string } {
  const next = typed.trim()
  if (!next) return { kind: 'clear' }
  if (next === (showing ?? '').trim()) return { kind: 'none' }
  return { kind: 'set', title: next }
}

/**
 * Reveal the rename field, then focus it a frame later.
 *
 * WebKit will not honour `.focus()` on an element that is still
 * `display: none` at the moment the call runs, and clearing `hidden` does not
 * repaint until the next frame -- so focusing in the same tick as revealing
 * silently does nothing. picker.ts and settings.ts already learned this and
 * defer with `requestAnimationFrame`; rename skipped it, so the field opened
 * looking focused while a physical keyboard typed into nothing.
 *
 * Pure so the ordering can be tested; a real frame cannot be.
 */
export function revealThenFocus(
  reveal: () => void,
  focus: () => void,
  schedule: (cb: () => void) => number = requestAnimationFrame,
): void {
  reveal()
  schedule(focus)
}

/**
 * Which action button `left`/`right` should move to next, wrapping at either
 * end. `up`/`down` are already spoken for here -- they scroll the
 * description -- so unlike settings.ts's `nextSettingsFocus` this one only
 * answers to the other pair, and there is no disabled state to skip: every
 * button in the row is always clickable.
 *
 * Pure so it is checkable without a DOM, per this project's no-jsdom
 * convention. Before this, `handle()` sent every `a` straight to `onPlay()`
 * and left `left`/`right` unhandled -- swallowed along with everything else
 * while the view is open -- so there was no route to Find artwork or Rename,
 * and no way to move between them, at all.
 */
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
  /** Offer the on-screen keyboard for a field, if a pad is what is being held.
   *  The detail view does not own the keyboard -- main.ts does, because the
   *  input chain has to consume for it before anything else. */
  onTextField?(field: HTMLInputElement): void
  /** The rename field it was offered for is going away -- close it too, or it
   *  is left on screen with nothing left to type into (issue #18). */
  onTextFieldClosed?(): void
}

/**
 * Look for the executable in the usual places, and offer what it finds.
 *
 * A suggestion the user confirms, never a silent decision: guessing wrong and
 * launching the wrong program is worse than asking. The scan can take a couple
 * of seconds, so the button says what it is doing.
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

  // Top right, away from the primary actions: these are the two things nobody
  // should reach for by accident. Away, not unreachable: `left`/`right` run
  // on past the end of the action row into here, because a pad had no route
  // to Hide or Uninstall at all until it did -- they were mouse-only for as
  // long as the row was the only thing the pad could move along.
  const corner = el('div', 'detail-corner', root)

  const logo = el('img', 'detail-logo', body)
  logo.alt = ''
  const title = el('h1', 'detail-title', body)

  /**
   * Renaming, in place.
   *
   * Sits where the title is rather than in a dialog, because the thing being
   * edited is the thing on screen and a launcher has enough overlays. Empty
   * commits as "no custom title", which restores whatever the provider calls
   * it -- that is the only way back, so it must not be a separate button.
   */
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

  /** Everything a pad can land on, in the order `right` visits it: the action
   *  row, then the corner. */
  function ring(): HTMLElement[] {
    return [...actions.children, ...corner.children] as HTMLElement[]
  }

  function endRename(): void {
    if (renaming) onTextFieldClosed?.()
    renaming = false
    rename.hidden = true
    renameField.blur()
    // Put the heading back exactly as open() left it: a wordmark hides the
    // typed title, and forgetting that leaves both showing at once.
    logo.hidden = !logoAvailable
    title.hidden = logoAvailable
  }

  function beginRename(): void {
    if (!current) return
    renaming = true
    // Both are hidden while editing, whichever was showing -- the field is
    // standing in for the heading, not sitting next to it.
    logo.hidden = true
    title.hidden = true
    renameField.value = current.title || ''
    // Both vocabularies, because the legend is not on screen behind an
    // overlay and this is the only place the bindings are stated.
    renameHint.textContent =
      'A or Enter saves · B or Esc cancels · leave it empty to restore the original name'
    revealThenFocus(
      () => { rename.hidden = false },
      () => { renameField.focus(); renameField.select() },
    )
    // A pad needs somewhere to type. main.ts owns the on-screen keyboard
    // because the input chain must consume for it before anything else.
    onTextField?.(renameField)
  }

  async function commitRename(): Promise<void> {
    const game = current
    if (!game) return
    const intent = renameIntent(game.title ?? '', renameField.value)
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
    // The global key handler steps aside while a field has focus, so Enter and
    // Escape have to be caught here or neither would do anything.
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
    // Discard any half-finished edit rather than leaving the field primed to
    // reappear over the next game that is opened.
    endRename()
    open = false
    root.hidden = true
  }

  return {
    get isOpen() { return open },

    open(game, meta, art, provenance) {
      const wasOpen = open
      // The artwork report arrives after the view is already open (main.ts
      // reopens to attach it once it resolves), and actions.textContent = ''
      // below rebuilds every button -- so without this, whichever button the
      // user had already moved to would silently lose focus back to the
      // first one the moment the report landed.
      const priorActionFocus = wasOpen
        ? ring().indexOf(document.activeElement as HTMLElement)
        : -1
      open = true
      root.hidden = false
      // Two frames, not one: the first makes the element displayed, and a
      // transition started in the same frame as `display` changing does not
      // run in WebKit. Skipped when already open -- reopening to attach the
      // artwork report must not re-animate.
      if (!wasOpen) {
        root.classList.add('is-entering')
        requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('is-entering')))
      }
      scroll.scrollTop = 0

      if (art.hero) { bgImg.src = art.hero; bgImg.hidden = false } else { bgImg.hidden = true }

      // Same rule as the hero: the wordmark is the preferred title, and type
      // is the fallback rather than an addition.
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
        // Two presses. The first arms it, the second commits -- the same shape
        // as the machine actions in the main menu, and for the same reason.
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
        // A hand-added game with nowhere to launch from says exactly that,
        // rather than offering a Play button that cannot work.
        //
        // Browsing is the primary action, not the fallback. Someone who added
        // a game by hand almost always knows exactly where it is, and a
        // library kept in a custom folder on whichever drive had room is not
        // somewhere a guess at Program Files is going to reach.
        const set = el('button', 'action action-primary', actions)
        set.textContent = 'Choose file…'
        set.onclick = () => {
          void pickExecutable(game, onChanged).catch((e) =>
            toast(`Could not set that. ${String(e)}`, 'error'))
        }

        // Secondary, and it earns its place over time: every file chosen by
        // hand teaches the app where games live, so this searches those places
        // first rather than guessing.
        const find = el('button', 'action', actions)
        find.textContent = 'Look for it'
        find.onclick = () => void autoLocate(game, find, onChanged)
      } else {
        const play = el('button', 'action action-primary', actions)
        play.textContent = game.installed ? 'Play' : 'Install and play'
        play.onclick = onPlay
      }

      // Steam already knows an update is queued -- that is what
      // `updateAvailable` means -- so this only starts the download, rather
      // than being how the state is discovered. Hidden while Steam is already
      // fetching it: there is nothing left to trigger.
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

      // Artwork can be re-matched for any game, not just hand-added ones: a
      // Steam release can have no cover on the CDN, or be listed there under a
      // different name, and until now there was no way back from that.
      const artwork = el('button', 'action', actions)
      artwork.textContent = 'Find artwork'
      artwork.onclick = () => onFindArtwork(game)

      // Any game, not just hand-added ones: Steam's name for a game is often
      // not the one you would look for it under, and a store name with an
      // edition suffix reads badly under a card.
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
      // Where the artwork came from, stated rather than left to be guessed
      // from the screen. "Is it working" should be answerable without
      // squinting at a card.
      addFact('Artwork', describeArtwork(provenance))

      // Land the pad somewhere on the row, or A has nothing to activate.
      // Deferred a frame: root.hidden went false earlier in this same tick,
      // and WebKit will not honour focus() on an element revealed in the same
      // tick as the call -- revealThenFocus above and settings.ts's open()
      // hit the same thing and defer for it too.
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
      // While renaming, the field is the innermost thing on screen. B must
      // cancel the edit rather than close the whole view, or a pad user who
      // changes their mind loses the screen as well as the edit.
      if (renaming) {
        if (action === 'a') void commitRename()
        else if (action === 'b') endRename()
        return true
      }
      // Everything is swallowed while open, not just the actions understood.
      // Letting `left`/`right` fall through would move the grid selection
      // behind the overlay, so closing would land somewhere unexpected.
      if (action === 'b' || action === 'y') { close(); return true }
      if (action === 'up') { scroll.scrollBy({ top: -220, behavior: 'smooth' }); return true }
      if (action === 'down') { scroll.scrollBy({ top: 220, behavior: 'smooth' }); return true }
      const buttons = ring()
      if (action === 'a') {
        const active = document.activeElement
        // Whichever button has focus; the first one if a race with the
        // deferred initial focus above somehow lands here before it runs.
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
