import { describe, expect, it } from 'vitest'
import { nextSettingsFocus } from '../settings'

/**
 * The settings overlay swallows every action while open (so closing it never
 * lands the grid selection somewhere unexpected), and up/down used to just
 * scroll the panel by a fixed pixel amount -- so the left stick moved the
 * view, but nothing was ever actually focused, and A always did the one
 * thing it had always done (saved the SteamGridDB key) no matter where you
 * had scrolled to. See src/settings.ts's `handle`.
 */
describe('nextSettingsFocus', () => {
  const noneDisabled = () => false

  it('moves down from nothing focused to the first control', () => {
    expect(nextSettingsFocus('down', -1, 5, noneDisabled)).toBe(0)
  })

  it('moves up from nothing focused to the last control', () => {
    expect(nextSettingsFocus('up', -1, 5, noneDisabled)).toBe(4)
  })

  it('wraps past either end', () => {
    expect(nextSettingsFocus('down', 4, 5, noneDisabled)).toBe(0)
    expect(nextSettingsFocus('up', 0, 5, noneDisabled)).toBe(4)
  })

  it('skips a control that cannot take focus', () => {
    // Index 1 is "Check for updates" mid-check, say.
    const disabled = (i: number) => i === 1
    expect(nextSettingsFocus('down', 0, 3, disabled)).toBe(2)
  })

  it('leaves focus alone when every control is disabled', () => {
    expect(nextSettingsFocus('down', 0, 3, () => true)).toBeUndefined()
  })

  it('leaves actions that are not a move alone', () => {
    expect(nextSettingsFocus('left', 0, 5, noneDisabled)).toBeUndefined()
    expect(nextSettingsFocus('right', 0, 5, noneDisabled)).toBeUndefined()
    expect(nextSettingsFocus('a', 0, 5, noneDisabled)).toBeUndefined()
    expect(nextSettingsFocus('b', 0, 5, noneDisabled)).toBeUndefined()
  })

  it('has nothing to land on in an empty list', () => {
    expect(nextSettingsFocus('down', -1, 0, noneDisabled)).toBeUndefined()
  })
})
