import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFrameMeter, resolveBackgroundStyle } from '../perf'

/**
 * The background style is read from a saved setting string, and the whole
 * point of this project's silence rule is that a value nobody expected must
 * not resolve to a background with neither grain nor blur -- a blank window
 * that looks fine in a screenshot and isn't.
 */
describe('resolveBackgroundStyle', () => {
  it('recognises blur', () => {
    expect(resolveBackgroundStyle('blur')).toBe('blur')
  })

  it('falls back to grain for anything else', () => {
    expect(resolveBackgroundStyle('grain')).toBe('grain')
    expect(resolveBackgroundStyle('')).toBe('grain')
    expect(resolveBackgroundStyle('smoke')).toBe('grain')
  })
})

/**
 * The meter is a development instrument, and it was running a callback every
 * frame in every release build from the moment the app started. It must cost
 * nothing until somebody opens the readout.
 */
describe('the frame meter', () => {
  let frame: ((now: number) => void) | undefined
  let requests = 0
  let cancelled = 0
  beforeEach(() => {
    requests = 0
    cancelled = 0
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => { frame = cb; requests += 1; return requests })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { cancelled = id })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('asks for no frames until started', () => {
    createFrameMeter()
    expect(requests).toBe(0)
  })

  it('measures while started and asks for nothing once stopped', () => {
    const meter = createFrameMeter()
    meter.start()
    for (let t = 0; t < 20; t += 1) frame?.(t * 16.7)
    expect(meter.read().hz).toBe(60)
    meter.stop()
    expect(cancelled).toBe(requests)
  })

  it('does not count the wait before the first frame as a frame', () => {
    const meter = createFrameMeter()
    meter.start()
    frame?.(5000)
    for (let t = 1; t < 20; t += 1) frame?.(5000 + t * 16.7)
    expect(meter.read().dropped).toBe(0)
  })
})
