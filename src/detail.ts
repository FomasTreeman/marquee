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
  setManualExecutable, removeManualGame, findExecutable,
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

export interface DetailHooks {
  onPlay(): void
  onChanged(): void
  /** Re-match this game's artwork against the store search. */
  onFindArtwork(game: Game): void
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
  const { onPlay, onChanged, onFindArtwork } = hooks
  const root = el('div', 'detail', document.body)
  root.hidden = true

  const bg = el('div', 'detail-bg', root)
  const bgImg = el('img', undefined, bg)
  bgImg.alt = ''
  el('div', 'detail-scrim', bg)

  const scroll = el('div', 'detail-scroll', root)
  const body = el('div', 'detail-body', scroll)

  const logo = el('img', 'detail-logo', body)
  logo.alt = ''
  const title = el('h1', 'detail-title', body)
  const tags = el('div', 'detail-tags', body)
  const actions = el('div', 'detail-actions', body)
  const desc = el('p', 'detail-desc', body)
  const facts = el('dl', 'detail-facts', body)

  let open = false

  function addFact(label: string, value: string): void {
    if (!value) return
    const dt = el('dt', undefined, facts)
    dt.textContent = label
    const dd = el('dd', undefined, facts)
    dd.textContent = value
  }

  return {
    get isOpen() { return open },

    open(game, meta, art, provenance) {
      open = true
      root.hidden = false
      scroll.scrollTop = 0

      if (art.hero) { bgImg.src = art.hero; bgImg.hidden = false } else { bgImg.hidden = true }

      // Same rule as the hero: the wordmark is the preferred title, and type
      // is the fallback rather than an addition.
      const hasLogo = !!art.logo
      logo.hidden = !hasLogo
      title.hidden = hasLogo
      if (hasLogo && logo.getAttribute('src') !== art.logo) logo.src = art.logo!
      logo.onerror = () => { logo.hidden = true; title.hidden = false }
      title.textContent = game.title || `App ${game.providerId}`

      tags.textContent = ''
      for (const genre of meta?.genres ?? []) {
        const tag = el('span', 'tag', tags)
        tag.textContent = genre
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

      // Artwork can be re-matched for any game, not just hand-added ones: a
      // Steam release can have no cover on the CDN, or be listed there under a
      // different name, and until now there was no way back from that.
      const artwork = el('button', 'action', actions)
      artwork.textContent = 'Find artwork'
      artwork.onclick = () => onFindArtwork(game)

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
      addFact('Status', game.installed ? 'Installed' : 'Not installed')
      addFact('Store', game.provider === 'steam' ? 'Steam' : 'Added by hand')
      addFact('Executable', game.installDir ?? '')
      // Where the artwork came from, stated rather than left to be guessed
      // from the screen. "Is it working" should be answerable without
      // squinting at a card.
      addFact('Artwork', describeArtwork(provenance))
    },

    close() {
      open = false
      root.hidden = true
    },

    handle(action) {
      if (!open) return false
      // Everything is swallowed while open, not just the actions understood.
      // Letting `left`/`right` fall through would move the grid selection
      // behind the overlay, so closing would land somewhere unexpected.
      if (action === 'b' || action === 'y') this.close()
      else if (action === 'a') onPlay()
      else if (action === 'up') scroll.scrollBy({ top: -220, behavior: 'smooth' })
      else if (action === 'down') scroll.scrollBy({ top: 220, behavior: 'smooth' })
      return true
    },
  }
}
