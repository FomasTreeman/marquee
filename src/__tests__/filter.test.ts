import { describe, expect, it } from 'vitest'
import { apply, compare, describe as describeFilter, matches, searchLabel, sortKey } from '../filter'
import type { Game } from '../library'

function game(over: Partial<Game> = {}): Game {
  return {
    id: 'steam:1', provider: 'steam', providerId: '1', title: 'A Game',
    installed: true, installDir: null, sizeBytes: 0,
    lastPlayed: null, playtimeMinutes: 0, favourite: false, hidden: false,
    artAppId: null,
    ...over,
  }
}

describe('library filtering', () => {
  /** Typing an apostrophe on a pad is not something anyone should have to do. */
  it('ignores case and punctuation when matching', () => {
    const g = game({ title: "Baldur's Gate 3" })
    expect(matches(g, 'all', 'baldurs gate')).toBe(true)
    expect(matches(g, 'all', 'BALDURSGATE3')).toBe(true)
    expect(matches(game({ title: 'Red Dead Redemption 2' }), 'all', 'reddead')).toBe(true)
  })

  it('treats an empty query as matching everything', () => {
    expect(matches(game(), 'all', '')).toBe(true)
    expect(matches(game(), 'all', '   ')).toBe(true)
  })

  it('applies each preset', () => {
    expect(matches(game({ favourite: false }), 'favourites', '')).toBe(false)
    expect(matches(game({ favourite: true }), 'favourites', '')).toBe(true)
    expect(matches(game({ installed: false }), 'installed', '')).toBe(false)
    expect(matches(game({ playtimeMinutes: 10 }), 'unplayed', '')).toBe(false)
    expect(matches(game({ lastPlayed: 1 }), 'unplayed', '')).toBe(false)
    expect(matches(game(), 'unplayed', '')).toBe(true)
  })

  /** Preset and query compose; neither overrides the other. */
  it('requires both the preset and the query to match', () => {
    const g = game({ title: 'Hades', favourite: true })
    expect(matches(g, 'favourites', 'hades')).toBe(true)
    expect(matches(g, 'favourites', 'portal')).toBe(false)
    expect(matches(game({ title: 'Hades' }), 'favourites', 'hades')).toBe(false)
  })

  /** Indices into the *original* library, so a metadata update or a favourite
   *  toggle has one place to write whatever the view is showing. Sorted, not in
   *  library order — favourites lead in every arrangement. */
  it('returns indices into the original library', () => {
    const games = [game({ title: 'A' }), game({ title: 'B', favourite: true }), game({ title: 'C' })]
    const all = apply(games, 'all', '')
    expect([...all].sort()).toEqual([0, 1, 2])
    expect(all[0]).toBe(1)
    expect(games[all[0]!]!.favourite).toBe(true)

    expect(apply(games, 'favourites', '')).toEqual([1])
    expect(apply(games, 'all', 'zzz')).toEqual([])
  })

  it('describes what is being shown', () => {
    expect(describeFilter('all', '', 3, 3)).toBe('3 games')
    expect(describeFilter('all', '', 1, 1)).toBe('1 game')
    expect(describeFilter('favourites', '', 2, 9)).toBe('Favourites · 2')
    expect(describeFilter('all', 'hade', 1, 9)).toContain('1 of 9')
  })
})

describe('sorting', () => {
  const g = (over: Partial<Game>) => game(over)

  it('puts favourites first in every order', () => {
    for (const sort of ['recent', 'played', 'name', 'size'] as const) {
      const plain = g({ id: 'a', title: 'AAA', playtimeMinutes: 999, sizeBytes: 999, lastPlayed: 999 })
      const fav = g({ id: 'b', title: 'ZZZ', favourite: true })
      expect(compare(fav, plain, sort), sort).toBeLessThan(0)
    }
  })

  it('orders by recency, then playtime', () => {
    const older = g({ id: 'a', lastPlayed: 100 })
    const newer = g({ id: 'b', lastPlayed: 200 })
    expect(compare(newer, older, 'recent')).toBeLessThan(0)

    const more = g({ id: 'c', playtimeMinutes: 90 })
    const less = g({ id: 'd', playtimeMinutes: 10 })
    expect(compare(more, less, 'recent')).toBeLessThan(0)
    expect(compare(more, less, 'played')).toBeLessThan(0)
  })

  it('sorts "The Witcher 3" under W', () => {
    expect(sortKey('The Witcher 3')).toBe('witcher 3')
    expect(sortKey('A Plague Tale')).toBe('plague tale')
    expect(sortKey('An Odd One')).toBe('odd one')
    expect(sortKey('Hades')).toBe('hades')
  })

  /**
   * Names arrive progressively from the metadata worker. A game whose name has
   * not landed must not sort above everything and then jump when it does.
   */
  it('sorts unnamed games last rather than first', () => {
    const named = g({ id: 'a', title: 'Zzz Last Alphabetically' })
    const unnamed = g({ id: 'b', title: '' })
    expect(compare(named, unnamed, 'name')).toBeLessThan(0)
  })

  /**
   * Two games tying on the chosen key must land in the same order regardless
   * of how they arrived, or the grid reshuffles between renders for no reason.
   *
   * Compared by id rather than by index: the indices point into two different
   * arrays, so comparing those would prove nothing.
   */
  it('is a total order, so nothing shuffles on re-sort', () => {
    const games = [
      g({ id: 'steam:1', title: 'Same', playtimeMinutes: 5 }),
      g({ id: 'steam:2', title: 'Same', playtimeMinutes: 5 }),
      g({ id: 'steam:3', title: 'Same', playtimeMinutes: 5 }),
    ]
    const order = (list: Game[], sort: Parameters<typeof apply>[3]) =>
      apply(list, 'all', '', sort).map((i) => list[i]!.id)

    for (const sort of ['recent', 'played', 'name', 'size'] as const) {
      expect(order([...games].reverse(), sort), sort).toEqual(order(games, sort))
      expect(order(games, sort), sort).toEqual(['steam:1', 'steam:2', 'steam:3'])
    }
  })

  it('sorts the filtered view, not the whole library', () => {
    const games = [
      g({ id: 'a', title: 'B', favourite: false, lastPlayed: 1 }),
      g({ id: 'b', title: 'A', favourite: true, lastPlayed: 2 }),
      g({ id: 'c', title: 'C', favourite: false, lastPlayed: 3 }),
    ]
    expect(apply(games, 'all', '', 'recent')).toEqual([1, 2, 0])
    expect(apply(games, 'favourites', '', 'recent')).toEqual([1])
  })
})

describe('searching beyond the title', () => {
  /** Searching "roguelike" or "larian" is a natural thing to try. */
  it('matches genre, developer and publisher when metadata has arrived', () => {
    const g = game({ title: "Baldur's Gate 3" })
    const meta = { genres: ['RPG', 'Turn-Based'], developers: ['Larian Studios'], publishers: [] }
    expect(matches(g, 'all', 'larian', meta)).toBe(true)
    expect(matches(g, 'all', 'turnbased', meta)).toBe(true)
    expect(matches(g, 'all', 'shooter', meta)).toBe(false)
  })

  /** Metadata arrives progressively, so a title match must never depend on it. */
  it('still matches the title with no metadata at all', () => {
    expect(matches(game({ title: 'Hades' }), 'all', 'hades', undefined)).toBe(true)
    expect(matches(game({ title: 'Hades' }), 'all', 'hades', {})).toBe(true)
  })
})

/**
 * The accessible name of the permanent search entry in the top bar -- see
 * shell.ts. It has to name the query rather than just say "Search" once one
 * exists, so a screen reader hears what is active even though the button no
 * longer prints it sighted.
 */
describe('searchLabel', () => {
  it('invites a query when there is none', () => {
    expect(searchLabel('')).toBe('Search')
    expect(searchLabel('   ')).toBe('Search')
  })

  it('shows the query once one is typed', () => {
    expect(searchLabel('halo')).toBe('“halo”')
  })

  it('trims the query rather than showing trailing whitespace', () => {
    expect(searchLabel('  hades  ')).toBe('“hades”')
  })
})
