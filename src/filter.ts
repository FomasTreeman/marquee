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

/** Extra text a query may match, beyond the title.
 *
 *  Searching "roguelike" or "larian" is a natural thing to try and previously
 *  found nothing. Genres and studios come from metadata, so this only works for
 *  games whose metadata has arrived — which is why it supplements the title
 *  match rather than replacing it. */
export interface Searchable {
  genres?: string[]
  developers?: string[]
  publishers?: string[]
}

export function matches(
  game: Game,
  preset: Preset,
  query: string,
  extra?: Searchable,
): boolean {
  switch (preset) {
    case 'favourites': if (!game.favourite) return false; break
    case 'installed': if (!game.installed) return false; break
    case 'unplayed': if (game.playtimeMinutes > 0 || game.lastPlayed) return false; break
    case 'all': break
  }
  const q = normalise(query)
  if (!q) return true
  if (normalise(game.title).includes(q)) return true
  // Genre and studio, when metadata has arrived for this game.
  const others = [
    ...(extra?.genres ?? []),
    ...(extra?.developers ?? []),
    ...(extra?.publishers ?? []),
  ]
  return others.some((t) => normalise(t).includes(q))
}

/**
 * Sort orders.
 *
 * `recent` is the default and is deliberately not alphabetical: titles arrive
 * progressively from the metadata worker on a first run, so an alphabetical
 * library would reshuffle itself under the cursor for minutes. See the note on
 * `sortKey` for how `name` copes with that.
 */
export type Sort = 'recent' | 'played' | 'name' | 'size'

export const SORTS: Array<{ id: Sort; label: string }> = [
  { id: 'recent', label: 'Recently played' },
  { id: 'played', label: 'Most played' },
  { id: 'name', label: 'Name' },
  { id: 'size', label: 'Size' },
]

/** Sort "The Witcher 3" under W. Lowercase, so case never splits the list. */
export function sortKey(title: string): string {
  const t = title.trim()
  for (const article of ['The ', 'A ', 'An ']) {
    if (t.startsWith(article)) return t.slice(article.length).toLowerCase()
  }
  return t.toLowerCase()
}

export function compare(a: Game, b: Game, sort: Sort): number {
  // Favourites first in every order. Someone who marked a game wants it near
  // the front whichever way the library is arranged.
  if (a.favourite !== b.favourite) return a.favourite ? -1 : 1

  switch (sort) {
    case 'played':
      if (a.playtimeMinutes !== b.playtimeMinutes) return b.playtimeMinutes - a.playtimeMinutes
      break
    case 'name': {
      // A game whose name has not arrived sorts last rather than under the
      // empty string, where it would sit above everything and jump when the
      // name lands.
      const an = a.title ? sortKey(a.title) : '\uffff'
      const bn = b.title ? sortKey(b.title) : '\uffff'
      if (an !== bn) return an < bn ? -1 : 1
      break
    }
    case 'size':
      if (a.sizeBytes !== b.sizeBytes) return b.sizeBytes - a.sizeBytes
      break
    case 'recent':
      if ((a.lastPlayed ?? 0) !== (b.lastPlayed ?? 0)) return (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0)
      if (a.playtimeMinutes !== b.playtimeMinutes) return b.playtimeMinutes - a.playtimeMinutes
      break
  }
  // Every order ends the same way, so it is total: two games that tie on the
  // chosen key must not swap places between renders.
  if (a.installed !== b.installed) return a.installed ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function apply(
  games: Game[],
  preset: Preset,
  query: string,
  sort: Sort = 'recent',
  extra?: (game: Game) => Searchable | undefined,
): number[] {
  const out: number[] = []
  for (let i = 0; i < games.length; i++) {
    if (matches(games[i]!, preset, query, extra?.(games[i]!))) out.push(i)
  }
  // Indices, sorted by the games behind them, so the caller keeps a stable
  // mapping back into the library.
  out.sort((x, y) => compare(games[x]!, games[y]!, sort))
  return out
}

export function describe(
  preset: Preset,
  query: string,
  shown: number,
  total: number,
  sort: Sort = 'recent',
): string {
  const label = PRESETS.find((p) => p.id === preset)?.label ?? 'All'
  const order = sort === 'recent' ? '' : ` · ${SORTS.find((s) => s.id === sort)?.label}`
  if (query.trim()) return `“${query.trim()}” · ${shown} of ${total}${order}`
  if (preset === 'all') return `${total} ${total === 1 ? 'game' : 'games'}${order}`
  return `${label} · ${shown}${order}`
}
