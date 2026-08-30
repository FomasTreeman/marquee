import { describe, expect, it } from 'vitest'
import { artIdFor, coverFor, steamArtwork, tintFor } from '../library'

/**
 * The artwork key is the single point where a game and its pictures are joined,
 * and getting it wrong has no symptom beyond a card with no cover -- which is
 * also what a game with genuinely no artwork looks like. That ambiguity has
 * already cost this project once: "Find artwork" re-pointed three games at
 * their own appid, a no-op, and it read as the artwork simply not existing.
 */
describe('artIdFor', () => {
  it('qualifies a plain Steam game by its provider id', () => {
    expect(artIdFor({ providerId: '1091500', artAppId: null })).toBe('steam-1091500')
  })

  it('lets an override borrow another Steam game s artwork', () => {
    expect(artIdFor({ providerId: '1091500', artAppId: '440' })).toBe('steam-440')
  })

  it('keeps a SteamGridDB override in its own namespace', () => {
    // The bug this prevents: dropping the prefix turns sgdb:8452 into
    // steam-8452, a completely different game that probably exists.
    expect(artIdFor({ providerId: '1091500', artAppId: 'sgdb:8452' })).toBe('sgdb-8452')
  })

  it('has no key for a game with no numeric id', () => {
    // Manually added games have ids like "manual-3". Returning a key anyway
    // would point the whole pipeline at artwork that cannot exist.
    expect(artIdFor({ providerId: 'manual-3', artAppId: null })).toBeUndefined()
    expect(artIdFor({ providerId: '440', artAppId: 'sgdb:' })).toBeUndefined()
    expect(artIdFor({ providerId: '440', artAppId: 'sgdb:abc' })).toBeUndefined()
  })
})

describe('steamArtwork without a backend', () => {
  // A plain browser tab has no art:// handler, so it falls back to the CDN.
  it('builds all three CDN paths for a Steam key', () => {
    const a = steamArtwork('steam-620')
    expect(a.cover).toContain('/620/library_600x900.jpg')
    expect(a.hero).toContain('/620/library_hero.jpg')
    expect(a.logo).toContain('/620/logo.png')
  })

  it('offers nothing for a SteamGridDB key', () => {
    // There is no URL we can construct for one, and guessing would produce a
    // 404 that the grid would report as a broken cover.
    expect(steamArtwork('sgdb-8452')).toEqual({})
  })

  it('offers nothing for a key with no source prefix', () => {
    expect(steamArtwork('620')).toEqual({})
  })

  it('routes a search hit through the same path as a card', () => {
    expect(coverFor({ appId: '620', name: 'Portal 2' } as never))
      .toBe(steamArtwork('steam-620').cover)
  })
})

describe('tintFor', () => {
  it('is stable for a title', () => {
    // The tint is the whole visual identity of a game with no artwork. If it
    // moved between launches the library would look like it was reshuffling.
    expect(tintFor('Hollow Knight')).toBe(tintFor('Hollow Knight'))
  })

  it('separates titles that differ at all', () => {
    expect(tintFor('Portal')).not.toBe(tintFor('Portal 2'))
  })

  it('stays a legible card background for any title', () => {
    // Fixed saturation and lightness: a tint bright enough to swallow the
    // white title text would be unreadable, and only on some games.
    for (const t of ['', 'A', 'ZZZZZZZZZZ', 'Ōkami', '你好', '🎮 Game']) {
      const m = /^hsl\((\d+) 22% 14%\)$/.exec(tintFor(t))
      expect(m, `no match for ${JSON.stringify(t)}`).not.toBeNull()
      expect(Number(m![1])).toBeLessThan(360)
    }
  })
})
