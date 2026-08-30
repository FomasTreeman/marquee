import { describe, expect, it } from 'vitest'
import { KEYMAP, PAD_ACTIONS, type Action } from '../input'

/**
 * "Controller first, keyboard second" only holds if second still means fully.
 *
 * The failure this guards against is quiet and specific: a new pad binding
 * gets added, the keyboard route is left for later, and nobody notices because
 * the person who added it is testing with a controller in their hands. The
 * feature is simply unreachable for everyone else, with no error anywhere.
 */
describe('keyboard parity', () => {
  const bound = new Set<Action>(Object.values(KEYMAP))

  it('gives every pad action a keyboard route', () => {
    const missing = PAD_ACTIONS.filter((a) => !bound.has(a))
    expect(missing).toEqual([])
  })

  it('binds nothing to an action the app does not have', () => {
    // A typo in the map is otherwise a key that silently does nothing.
    const known = new Set<string>([...PAD_ACTIONS, 'perf', 'fullscreen'])
    const stray = Object.entries(KEYMAP).filter(([, a]) => !known.has(a))
    expect(stray).toEqual([])
  })
})

describe('the map itself', () => {
  it('uses event codes, not key values', () => {
    // KeyboardEvent.code is layout independent: 'KeyW' is the same physical
    // key on AZERTY, where event.key would be 'z'. Getting this wrong makes
    // navigation subtly wrong for anyone not on QWERTY.
    for (const code of Object.keys(KEYMAP)) {
      expect(code).toMatch(/^(Key[A-Z]|Arrow(Up|Down|Left|Right)|Digit\d|F\d\d?|Enter|Space|Escape|Backspace|Tab|Slash)$/)
    }
  })

  it('offers both a reachable and a conventional key for the common actions', () => {
    // Arrows and WASD both navigate; Enter and Space both confirm; Escape and
    // Backspace both go back. One-handed use should not need a specific hand.
    const routes = (a: Action) => Object.values(KEYMAP).filter((v) => v === a).length
    for (const a of ['up', 'down', 'left', 'right', 'a', 'b'] as Action[]) {
      expect(routes(a)).toBeGreaterThanOrEqual(2)
    }
  })
})
