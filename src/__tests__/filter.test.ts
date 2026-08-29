import { describe, expect, it } from 'vitest'
import { apply, describe as describeFilter, matches } from '../filter'
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

  it('returns indices into the original library, in order', () => {
    const games = [game({ title: 'A' }), game({ title: 'B', favourite: true }), game({ title: 'C' })]
    expect(apply(games, 'all', '')).toEqual([0, 1, 2])
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
