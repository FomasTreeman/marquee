import { describe, expect, it } from 'vitest'
import { artIdFor, coverFor, steamArtwork, tintFor } from '../library'

/** A wrong artwork key looks the same as a game with no artwork. */
describe('artIdFor', () => {
  it('qualifies a plain Steam game by its provider id', () => {
    expect(artIdFor({ providerId: '1091500', artAppId: null })).toBe('steam-1091500')
  })

  it('lets an override borrow another Steam game s artwork', () => {
    expect(artIdFor({ providerId: '1091500', artAppId: '440' })).toBe('steam-440')
  })

  it('keeps a SteamGridDB override in its own namespace', () => {
    // Without the prefix, sgdb:8452 would become steam-8452, a different game.
    expect(artIdFor({ providerId: '1091500', artAppId: 'sgdb:8452' })).toBe('sgdb-8452')
  })

  it('has no key for a game with no numeric id', () => {
    expect(artIdFor({ providerId: 'manual-3', artAppId: null })).toBeUndefined()
    expect(artIdFor({ providerId: '440', artAppId: 'sgdb:' })).toBeUndefined()
    expect(artIdFor({ providerId: '440', artAppId: 'sgdb:abc' })).toBeUndefined()
  })
})

describe('steamArtwork without a backend', () => {
  // A plain browser tab has no art:// handler, so it uses the CDN.
  it('builds all three CDN paths for a Steam key', () => {
    const a = steamArtwork('steam-620')
    expect(a.cover).toContain('/620/library_600x900.jpg')
    expect(a.hero).toContain('/620/library_hero.jpg')
    expect(a.logo).toContain('/620/logo.png')
  })

  it('offers nothing for a SteamGridDB key', () => {
    expect(steamArtwork('sgdb-8452')).toEqual({})
  })

  it('offers nothing for a key with no source prefix', () => {
    expect(steamArtwork('620')).toEqual({})
  })

  it('routes a search hit through the same path as a card', () => {
    // No `as never`: a cast here once hid a shape change from the type checker.
    expect(coverFor({ appId: '620', name: 'Portal 2', source: 'steam', thumbnail: '' }))
      .toBe(steamArtwork('steam-620').cover)
  })
})

describe('tintFor', () => {
  it('is stable for a title', () => {
    expect(tintFor('Hollow Knight')).toBe(tintFor('Hollow Knight'))
  })

  it('separates titles that differ at all', () => {
    expect(tintFor('Portal')).not.toBe(tintFor('Portal 2'))
  })

  it('stays a legible card background for any title', () => {
    // Fixed saturation and lightness keep the white title readable.
    for (const t of ['', 'A', 'ZZZZZZZZZZ', 'Ōkami', '你好', '🎮 Game']) {
      const m = /^hsl\((\d+) 22% 14%\)$/.exec(tintFor(t))
      expect(m, `no match for ${JSON.stringify(t)}`).not.toBeNull()
      expect(Number(m![1])).toBeLessThan(360)
    }
  })
})
