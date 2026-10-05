import { describe, expect, it } from 'vitest'
import { KEYMAP, PAD_ACTIONS, wantsOsk, type Action } from '../input'

describe('keyboard parity', () => {
  const bound = new Set<Action>(Object.values(KEYMAP))

  it('gives every pad action a keyboard route', () => {
    const missing = PAD_ACTIONS.filter((a) => !bound.has(a))
    expect(missing).toEqual([])
  })

  it('binds nothing to an action the app does not have', () => {
    const known = new Set<string>([...PAD_ACTIONS, 'perf', 'fullscreen'])
    const stray = Object.entries(KEYMAP).filter(([, a]) => !known.has(a))
    expect(stray).toEqual([])
  })
})

describe('the map itself', () => {
  it('uses event codes, not key values', () => {
    // `code` is layout independent, so WASD stays put on AZERTY.
    for (const code of Object.keys(KEYMAP)) {
      expect(code).toMatch(/^(Key[A-Z]|Arrow(Up|Down|Left|Right)|Digit\d|F\d\d?|Enter|Space|Escape|Backspace|Tab|Slash)$/)
    }
  })

  it('offers both a reachable and a conventional key for the common actions', () => {
    const routes = (a: Action) => Object.values(KEYMAP).filter((v) => v === a).length
    for (const a of ['up', 'down', 'left', 'right', 'a', 'b'] as Action[]) {
      expect(routes(a)).toBeGreaterThanOrEqual(2)
    }
  })
})

describe('offering the on-screen keyboard', () => {
  it('is wanted while a pad is what is being held', () => {
    expect(wantsOsk('pad')).toBe(true)
  })

  it('is not wanted once a real keyboard is picked up', () => {
    expect(wantsOsk('keyboard')).toBe(false)
  })

  it('is not wanted while a mouse is what is being held', () => {
    expect(wantsOsk('mouse')).toBe(false)
  })
})
