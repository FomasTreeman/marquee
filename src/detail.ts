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
import { setManualExecutable, removeManualGame, type Game, type Meta, type Artwork } from './library'
import { toast } from './toast'
import { logInfo } from './log'
import { inApp } from './host'

export interface DetailView {
  readonly isOpen: boolean
  open(game: Game, meta: Meta | undefined, art: Artwork): void
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

export function createDetail(onPlay: () => void, onChanged: () => void = () => {}): DetailView {
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

    open(game, meta, art) {
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
        const set = el('button', 'action action-primary', actions)
        set.textContent = 'Set executable'
        set.onclick = () => {
          void pickExecutable(game, onChanged).catch((e) =>
            toast(`Could not set that. ${String(e)}`, 'error'))
        }
      } else {
        const play = el('button', 'action action-primary', actions)
        play.textContent = game.installed ? 'Play' : 'Install and play'
        play.onclick = onPlay
      }

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
