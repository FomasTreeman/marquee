import { describe, expect, it } from 'vitest'
import { renameIntent } from '../detail'

/**
 * Renaming is the one place the user overrides metadata by hand, so the rule
 * for when an override is written matters more than it looks. Storing a title
 * identical to the one already showing pins the name against everything the
 * metadata worker learns later, and it does it invisibly -- the game looks
 * unchanged the day you do it.
 */
describe('renameIntent', () => {
  it('writes an override for a real change', () => {
    expect(renameIntent('ELDEN RING', 'Elden Ring')).toEqual({ kind: 'set', title: 'Elden Ring' })
  })

  it('does nothing when the name is unchanged', () => {
    expect(renameIntent('Portal 2', 'Portal 2')).toEqual({ kind: 'none' })
  })

  it('ignores whitespace either side when deciding that', () => {
    // Opening the field and pressing save should never write anything, and a
    // stray space from an on-screen keyboard is not a change.
    expect(renameIntent('Portal 2', '  Portal 2  ')).toEqual({ kind: 'none' })
    expect(renameIntent(' Portal 2', 'Portal 2')).toEqual({ kind: 'none' })
  })

  it('trims what it does store', () => {
    expect(renameIntent('Portal', ' Portal 2 ')).toEqual({ kind: 'set', title: 'Portal 2' })
  })

  it('treats an empty field as "restore the original"', () => {
    // The only route back to the provider's own name. Storing '' instead would
    // leave a game with no title at all and no way to fix it.
    expect(renameIntent('My Name', '')).toEqual({ kind: 'clear' })
    expect(renameIntent('My Name', '   ')).toEqual({ kind: 'clear' })
  })

  it('clears rather than doing nothing when the game had no name either', () => {
    // A game with no title yet and an empty field still has to clear: there
    // may be an override behind the blank that the user is trying to remove.
    expect(renameIntent('', '')).toEqual({ kind: 'clear' })
  })

  it('is case sensitive, because capitalisation is the usual reason to rename', () => {
    expect(renameIntent('ELDEN RING', 'Elden Ring')).toEqual({ kind: 'set', title: 'Elden Ring' })
  })
})
