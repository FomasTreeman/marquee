import { describe, expect, it, vi } from 'vitest'
import { legendFor, type LegendActions } from '../shell'
import type { Device } from '../input'

const DEVICES: Device[] = ['pad', 'keyboard', 'mouse']

function spies(): LegendActions {
  return {
    play: vi.fn(), details: vi.fn(), favourite: vi.fn(), sort: vi.fn(),
    search: vi.fn(), menu: vi.fn(), add: vi.fn(),
  }
}

/**
 * The legend is not decoration: it is the only place the app says what you can
 * press. An action missing from one device's row is an action that device
 * cannot discover, and because the legend follows whatever was last touched,
 * it is also invisible from the others.
 *
 * That is not hypothetical. The mouse row had no Details and no Favourite, so
 * the details screen had no mouse route at all -- and moving the mouse hid the
 * keyboard's "Y Details" before anyone could read it.
 */
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
    // The mouse row used to print an em dash for five actions, which reads as
    // "this has no binding" rather than "click this".
    for (const d of DEVICES) {
      for (const hint of legendFor(d, spies())) {
        // An absent key is the correct way to say "no keystroke"; a key made
        // only of dashes is the wrong way, and is what shipped.
        if (hint.key !== undefined) {
          expect(hint.key, `${d}/${hint.label}`).not.toMatch(/^[—–\-_\s]+$/)
          expect(hint.key, `${d}/${hint.label}`).not.toBe('')
        }
      }
    }
  })

  it('makes every keyless entry pressable', () => {
    // A pill with no key and no handler is a button that does nothing, which
    // is worse than the dash it replaced.
    for (const d of DEVICES) {
      for (const hint of legendFor(d, spies())) {
        if (!hint.key) expect(hint.onClick, `${d}/${hint.label}`).toBeTypeOf('function')
      }
    }
  })

  it('wires each label to its own action', () => {
    // Copy-paste in a table like this produces two rows calling one handler,
    // and the symptom is a button that opens the wrong screen.
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
    // Every pad row names a physical button. A pill you can only click is
    // useless to someone holding a controller on a sofa.
    for (const hint of legendFor('pad', spies())) expect(hint.key).toBeTruthy()
  })
})
