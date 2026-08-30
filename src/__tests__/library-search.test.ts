import { describe, expect, it } from 'vitest'
import { artKeyFor, artSourceFor, coverFor, type SearchHit } from '../library'

const steam = (id: string): SearchHit =>
  ({ appId: id, name: 'x', source: 'steam', thumbnail: '' })
const sgdb = (id: string): SearchHit =>
  ({ appId: id, name: 'x', source: 'sgdb', thumbnail: '' })

/**
 * A search result carries an id from one of two catalogues, and the number
 * alone does not say which. Losing that distinction is silent in the worst
 * way: SteamGridDB id 8452 read as a Steam appid is a completely different
 * game that probably exists, so the symptom is the wrong artwork on a card
 * rather than an error anybody can act on.
 */
describe('what a search hit means', () => {
  it('qualifies the artwork key by catalogue', () => {
    expect(artKeyFor(steam('620'))).toBe('steam-620')
    expect(artKeyFor(sgdb('8452'))).toBe('sgdb-8452')
  })

  it('keeps the prefix a SteamGridDB id needs when stored', () => {
    expect(artSourceFor(sgdb('8452'))).toBe('sgdb:8452')
  })

  it('leaves a Steam appid bare, because that is what the store expects', () => {
    expect(artSourceFor(steam('620'))).toBe('620')
  })

  it('never produces the same key for the two catalogues', () => {
    // The id spaces overlap: both are small integers. If these ever collided,
    // one game would silently serve the other's cached artwork.
    expect(artKeyFor(steam('8452'))).not.toBe(artKeyFor(sgdb('8452')))
    expect(artSourceFor(steam('8452'))).not.toBe(artSourceFor(sgdb('8452')))
  })

  it('builds a CDN cover for a Steam hit', () => {
    expect(coverFor(steam('620'))).toContain('/620/library_600x900.jpg')
  })

  it('offers no CDN cover for a SteamGridDB hit', () => {
    // There is no public URL we can construct for one. Guessing would produce
    // a 404 the grid would report as a broken cover.
    expect(coverFor(sgdb('8452'))).toBeUndefined()
  })
})
