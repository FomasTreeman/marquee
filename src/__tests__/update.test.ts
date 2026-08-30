import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scheduleUpdateCheck, updateMenuItems, type PendingUpdate } from '../update'

/**
 * The plugin verifies signatures; none of that is re-tested here. What is
 * tested is the policy, because the policy is the part that decides whether
 * this app is pleasant to live with -- and "never interrupt" is a rule that
 * quietly stops holding the moment someone reorders a callback.
 */

const update: PendingUpdate = { version: '0.2.0', notes: 'Faster.', install: async () => {} }

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('window', globalThis) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('when the offer is made', () => {
  it('waits rather than asking during startup', async () => {
    const offer = vi.fn()
    scheduleUpdateCheck(() => true, offer, 20_000)
    vi.advanceTimersByTime(19_000)
    await Promise.resolve()
    expect(offer).not.toHaveBeenCalled()
  })

  it('cancels cleanly if the app closes first', async () => {
    const offer = vi.fn()
    const cancel = scheduleUpdateCheck(() => true, offer, 20_000)
    cancel()
    vi.advanceTimersByTime(60_000)
    await Promise.resolve()
    expect(offer).not.toHaveBeenCalled()
  })
})

/**
 * The menu is how the offer is made, so it has to obey the same rules as every
 * other menu: reachable on a pad, and refusable.
 */
describe('the offer itself', () => {
  const items = updateMenuItems(update)

  it('always offers a way to say no', () => {
    // An update prompt with only one button is a demand, and this app launches
    // executables -- it does not get to demand things.
    expect(items.map((i) => i.id)).toContain('later')
    expect(items.find((i) => i.id === 'later')?.disabled).toBeUndefined()
  })

  it('names the version being offered', () => {
    // "An update is available" tells you nothing about what you are agreeing
    // to. The version is the minimum.
    expect(items.find((i) => i.id === 'install')?.detail).toBe('0.2.0')
  })

  it('does not make you confirm twice', () => {
    // Installing is reversible -- the previous version is still downloadable
    // -- so it does not earn the two-press treatment that shutdown gets.
    for (const i of items) expect(i.confirm).toBeUndefined()
  })

  it('has no duplicate ids', () => {
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length)
  })

  it('offers exactly two choices', () => {
    // A menu on a television is read from across a room. Two rows is the
    // whole vocabulary this question needs.
    expect(items).toHaveLength(2)
  })
})
