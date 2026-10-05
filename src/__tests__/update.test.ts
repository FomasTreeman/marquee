import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { progressStep, scheduleUpdateCheck, updateMenuItems, type PendingUpdate } from '../update'

/** Tests the offer policy; the plugin's signature checks are not re-tested. */

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

describe('the offer itself', () => {
  const items = updateMenuItems(update)

  it('always offers a way to say no', () => {
    expect(items.map((i) => i.id)).toContain('later')
    expect(items.find((i) => i.id === 'later')?.disabled).toBeUndefined()
  })

  it('names the version being offered', () => {
    expect(items.find((i) => i.id === 'install')?.detail).toBe('0.2.0')
  })

  it('does not make you confirm twice', () => {
    // Installing is reversible, unlike shutdown.
    for (const i of items) expect(i.confirm).toBeUndefined()
  })

  it('has no duplicate ids', () => {
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length)
  })

  it('offers exactly two choices', () => {
    expect(items).toHaveLength(2)
  })
})

describe('reporting download progress', () => {
  it('says nothing for a chunk that does not move the percentage', () => {
    const p = { total: 1000, got: 0 }
    expect(progressStep(p)).toBe(0)
    p.got = 4
    expect(progressStep(p)).toBeUndefined()
    p.got = 5
    expect(progressStep(p)).toBe(1)
  })

  it('says nothing at all when the size is unknown', () => {
    expect(progressStep({ total: 0, got: 500 })).toBeUndefined()
  })

  it('never reads past a hundred, however the chunks add up', () => {
    expect(progressStep({ total: 10, got: 12 })).toBe(100)
  })
})
