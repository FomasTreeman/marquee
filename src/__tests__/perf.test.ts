import { describe, expect, it } from 'vitest'
import { resolveBackgroundStyle } from '../perf'

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
