import { describe, expect, it } from 'vitest'
import { settingsScrollDelta } from '../settings'

/**
 * The settings overlay swallows every action while open (so closing it never
 * lands the grid selection somewhere unexpected), which meant `up`/`down` were
 * being caught and dropped rather than scrolling anything -- the left stick
 * did nothing on this screen. See src/settings.ts's `handle`.
 */
describe('settingsScrollDelta', () => {
  it('scrolls up on the up action', () => {
    expect(settingsScrollDelta('up')).toBe(-220)
  })

  it('scrolls down on the down action', () => {
    expect(settingsScrollDelta('down')).toBe(220)
  })

  it('leaves actions that are not a scroll alone', () => {
    expect(settingsScrollDelta('left')).toBeUndefined()
    expect(settingsScrollDelta('right')).toBeUndefined()
    expect(settingsScrollDelta('a')).toBeUndefined()
    expect(settingsScrollDelta('b')).toBeUndefined()
  })
})
