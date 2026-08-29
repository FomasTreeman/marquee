/**
 * Library filtering.
 *
 * With two hundred games the grid stops being browsable and starts needing a
 * way in. Two of them, deliberately different in kind:
 *
 *   * **Presets**, on the shoulder buttons. Zero-effort, always one press
 *     away, and the only one that works with a thumb on a sofa.
 *   * **A query**, for when you know the name. Needs a keyboard, so it is the
 *     secondary path rather than the primary one.
 *
 * Filtering is pure and synchronous. It never touches the backend: the library
 * is already in memory, and a round trip per keystroke would be slower and
 * could fail.
 */
import type { Game } from './library'

export type Preset = 'all' | 'favourites' | 'installed' | 'unplayed'

export const PRESETS: Array<{ id: Preset; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'favourites', label: 'Favourites' },
  { id: 'installed', label: 'Installed' },
  { id: 'unplayed', label: 'Never played' },
]

/** Case- and punctuation-insensitive, so "baldurs gate" finds "Baldur's Gate 3"
 *  and "reddead" finds "Red Dead Redemption 2". Typing an apostrophe on a pad
 *  is not something anyone should have to do. */
function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export function matches(game: Game, preset: Preset, query: string): boolean {
  switch (preset) {
    case 'favourites': if (!game.favourite) return false; break
    case 'installed': if (!game.installed) return false; break
    case 'unplayed': if (game.playtimeMinutes > 0 || game.lastPlayed) return false; break
    case 'all': break
  }
  if (!query.trim()) return true
  return normalise(game.title).includes(normalise(query))
}

export function apply(games: Game[], preset: Preset, query: string): number[] {
  const out: number[] = []
  for (let i = 0; i < games.length; i++) {
    if (matches(games[i]!, preset, query)) out.push(i)
  }
  return out
}

export function describe(preset: Preset, query: string, shown: number, total: number): string {
  const label = PRESETS.find((p) => p.id === preset)?.label ?? 'All'
  if (query.trim()) return `“${query.trim()}” · ${shown} of ${total}`
  if (preset === 'all') return `${total} ${total === 1 ? 'game' : 'games'}`
  return `${label} · ${shown}`
}
