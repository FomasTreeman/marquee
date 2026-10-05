import { describe, expect, it } from 'vitest'
import tokens from '../../design/tokens.json'

/** At 40px the hero backdrop became a shapeless blob (issue #61). */
describe('backdrop ambient blur', () => {
  it('stays low enough to soften rather than obscure', () => {
    const px = Number(tokens.vars['--backdrop-ambient-blur'].replace('px', ''))
    expect(px).toBeLessThanOrEqual(24)
  })
})
