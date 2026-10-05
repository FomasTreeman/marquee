/**
 * Library filtering by preset (shoulder buttons) and by query. Pure and
 * synchronous: the library is already in memory, so no backend round trip.
 */
import type { Game } from './library'

export type Preset = 'all' | 'favourites' | 'installed' | 'unplayed' | 'hidden'

export const PRESETS: Array<{ id: Preset; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'favourites', label: 'Favourites' },
  { id: 'installed', label: 'Installed' },
  { id: 'unplayed', label: 'Never played' },
  // The only route back to a hidden game.
  { id: 'hidden', label: 'Hidden' },
]

/** Case- and punctuation-insensitive, so "baldurs gate" finds "Baldur's Gate 3". */
function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** Genres and studios a query may match besides the title, once metadata has arrived. */
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
  // Hidden games appear only under the hidden preset.
  if (preset === 'hidden') {
    if (!game.hidden) return false
  } else if (game.hidden) {
    return false
  }
  switch (preset) {
    case 'favourites': if (!game.favourite) return false; break
    case 'installed': if (!game.installed) return false; break
    case 'unplayed': if (game.playtimeMinutes > 0 || game.lastPlayed) return false; break
    case 'all': case 'hidden': break
  }
  const q = normalise(query)
  if (!q) return true
  if (normalise(game.title).includes(q)) return true
  const others = [
    ...(extra?.genres ?? []),
    ...(extra?.developers ?? []),
    ...(extra?.publishers ?? []),
  ]
  return others.some((t) => normalise(t).includes(q))
}

/**
 * Sort orders. The default is `recent`, not `name`, because titles arrive
 * gradually on a first run and an alphabetical grid would reshuffle under the cursor.
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
  // Favourites first in every order.
  if (a.favourite !== b.favourite) return a.favourite ? -1 : 1

  switch (sort) {
    case 'played':
      if (a.playtimeMinutes !== b.playtimeMinutes) return b.playtimeMinutes - a.playtimeMinutes
      break
    case 'name': {
      // Untitled games sort last, so they do not jump from the top when the
      // name arrives.
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
  // Tie-break so the order is total and ties never swap between renders.
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
  // Return indices so the caller keeps a mapping back into the library.
  out.sort((x, y) => compare(games[x]!, games[y]!, sort))
  return out
}

/** Accessible name for the search button: the active query, or "Search".
 *  Not shown visibly, as the field already shows the query. */
export function searchLabel(query: string): string {
  const q = query.trim()
  return q ? `“${q}”` : 'Search'
}

export function describe(
  preset: Preset,
  query: string,
  shown: number,
  total: number,
  sort: Sort = 'recent',
): string {
  const label = PRESETS.find((p) => p.id === preset)?.label ?? 'All'
  // An unknown sort saved by another version reads as the default, not "undefined".
  const known = SORTS.find((s) => s.id === sort)
  const order = !known || known.id === 'recent' ? '' : ` · ${known.label}`
  if (query.trim()) return `“${query.trim()}” · ${shown} of ${total}${order}`
  if (preset === 'all') return `${total} ${total === 1 ? 'game' : 'games'}${order}`
  return `${label} · ${shown}${order}`
}
