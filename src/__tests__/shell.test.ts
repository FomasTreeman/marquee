import { describe, expect, it, vi } from 'vitest'
import { legendFor, searchIconBBox, SEARCH_ICON, type LegendActions } from '../shell'
import type { Device } from '../input'

const DEVICES: Device[] = ['pad', 'keyboard', 'mouse']

function spies(): LegendActions {
  return {
    play: vi.fn(), details: vi.fn(), favourite: vi.fn(), sort: vi.fn(),
    search: vi.fn(), menu: vi.fn(), add: vi.fn(),
  }
}

/** The legend follows the last device used, so a missing row hides an action entirely. */
describe('legendFor', () => {
  it('offers Details on every device', () => {
    for (const d of DEVICES) {
      expect(legendFor(d, spies()).map((h) => h.label), d).toContain('Details')
    }
  })

  it('offers every core action on every device', () => {
    for (const d of DEVICES) {
      const labels = legendFor(d, spies()).map((h) => h.label)
      for (const need of ['Play', 'Details', 'Favourite', 'Sort', 'Search', 'Menu', 'Add']) {
        expect(labels, `${d} is missing ${need}`).toContain(need)
      }
    }
  })

  it('never shows a placeholder where a key should be', () => {
    // A dash in the key slot reads as "no binding" rather than "click this".
    for (const d of DEVICES) {
      for (const hint of legendFor(d, spies())) {
        if (hint.key !== undefined) {
          expect(hint.key, `${d}/${hint.label}`).not.toMatch(/^[—–\-_\s]+$/)
          expect(hint.key, `${d}/${hint.label}`).not.toBe('')
        }
      }
    }
  })

  it('makes every keyless entry pressable', () => {
    for (const d of DEVICES) {
      for (const hint of legendFor(d, spies())) {
        if (!hint.key) expect(hint.onClick, `${d}/${hint.label}`).toBeTypeOf('function')
      }
    }
  })

  it('wires each label to its own action', () => {
    for (const d of DEVICES) {
      const on = spies()
      const byLabel = new Map(legendFor(d, on).map((h) => [h.label, h.onClick]))
      byLabel.get('Details')?.()
      expect(on.details, d).toHaveBeenCalledTimes(1)
      expect(on.play, d).not.toHaveBeenCalled()
      byLabel.get('Sort')?.()
      expect(on.sort, d).toHaveBeenCalledTimes(1)
      expect(on.search, d).not.toHaveBeenCalled()
    }
  })

  it('gives the pad no keyless entries', () => {
    for (const hint of legendFor('pad', spies())) expect(hint.key).toBeTruthy()
  })
})

/** A magnifying glass is asymmetric, so a centred viewBox still drew the ink low (#87). */
describe('search icon', () => {
  it('centres its ink within the viewBox, not just its box', () => {
    const box = searchIconBBox()
    const mid = SEARCH_ICON.viewBox / 2
    expect((box.minX + box.maxX) / 2).toBeCloseTo(mid, 6)
    expect((box.minY + box.maxY) / 2).toBeCloseTo(mid, 6)
  })

  it('would not pass with the textbook (unshifted) magnifying-glass coordinates', () => {
    // Proves the test above bites: the usual icon-set coordinates read low.
    const strokeWidth = 2
    const half = strokeWidth / 2
    const circle = { cx: 11, cy: 11, r: 7 }
    const handle = { x1: 21, y1: 21, x2: 16.65, y2: 16.65 }
    const xs = [circle.cx - circle.r - half, circle.cx + circle.r + half, handle.x1 - half, handle.x1 + half, handle.x2 - half, handle.x2 + half]
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    expect((minX + maxX) / 2).not.toBeCloseTo(12, 6)
  })
})
