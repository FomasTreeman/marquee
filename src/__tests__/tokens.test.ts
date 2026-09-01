import { describe, expect, it } from 'vitest'
import tokens from '../../design/tokens.json'

/**
 * At 40px the ambient hero backdrop stopped reading as a softened image and
 * became a shapeless blob (issue #61) -- a value nobody would notice was
 * wrong until a user pointed at a screenshot. Cap it so a future bump back
 * up fails here instead of shipping silently.
 */
describe('backdrop ambient blur', () => {
  it('stays low enough to soften rather than obscure', () => {
    const px = Number(tokens.vars['--backdrop-ambient-blur'].replace('px', ''))
    expect(px).toBeLessThanOrEqual(24)
  })
})
