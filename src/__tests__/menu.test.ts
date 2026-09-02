import { describe, expect, it } from 'vitest'
import { ENDS_THE_SESSION, mainMenuItems } from '../menu'

/**
 * The Start-button menu is the only place in Marquee that can turn the machine
 * off. A missing `confirm` there is not a cosmetic bug: it is someone losing
 * whatever they had open because a stick drifted one row.
 */
describe('the main menu', () => {
  const items = mainMenuItems(215)

  it('confirms everything that ends the session', () => {
    for (const id of ENDS_THE_SESSION) {
      const item = items.find((i) => i.id === id)
      expect(item, `${id} is missing from the menu`).toBeDefined()
      expect(item!.confirm, `${id} acts on one press`).toBeTruthy()
    }
  })

  it('does not make you confirm the harmless ones', () => {
    // Confirming everything trains people to press twice without reading,
    // which is how the confirm on shutdown stops working.
    for (const id of ['settings', 'rescan', 'minimise', 'quit']) {
      expect(items.find((i) => i.id === id)?.confirm).toBeUndefined()
    }
  })

  it('sends only ids the Rust side can parse', () => {
    // Mirrors Action::parse in src-tauri/src/system.rs. A typo here is a menu
    // row that does nothing but toast an error nobody reads.
    const handledInTheFrontend = ['settings', 'rescan']
    const parsedByRust = ['minimise', 'minimize', 'quit', 'restart', 'shutdown']
    for (const i of items) {
      expect([...handledInTheFrontend, ...parsedByRust]).toContain(i.id)
    }
  })

  it('has no duplicate ids', () => {
    // Two rows with one id means the second is unreachable: the dispatch takes
    // the first branch that matches.
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length)
  })

  it('shows the library size on the row that changes it', () => {
    expect(mainMenuItems(215).find((i) => i.id === 'rescan')?.detail).toBe('215 games')
    expect(mainMenuItems(0).find((i) => i.id === 'rescan')?.detail).toBe('0 games')
  })
})
