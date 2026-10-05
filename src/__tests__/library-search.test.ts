import { describe, expect, it } from 'vitest'
import { artKeyFor, artSourceFor, coverFor, type SearchHit } from '../library'

const steam = (id: string): SearchHit =>
  ({ appId: id, name: 'x', source: 'steam', thumbnail: '' })
const sgdb = (id: string): SearchHit =>
  ({ appId: id, name: 'x', source: 'sgdb', thumbnail: '' })

/** Steam and SteamGridDB ids overlap, so mixing them up shows another game's artwork. */
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
    expect(artKeyFor(steam('8452'))).not.toBe(artKeyFor(sgdb('8452')))
    expect(artSourceFor(steam('8452'))).not.toBe(artSourceFor(sgdb('8452')))
  })

  it('builds a CDN cover for a Steam hit', () => {
    expect(coverFor(steam('620'))).toContain('/620/library_600x900.jpg')
  })

  it('offers no CDN cover for a SteamGridDB hit', () => {
    expect(coverFor(sgdb('8452'))).toBeUndefined()
  })
})
