import { describe, expect, it } from 'vitest'
import { nameFromPath } from '../picker'

/**
 * The seed of the whole add-by-browsing flow. It only has to be close -- the
 * user confirms the match against real search results -- but "close" still
 * means surviving the shapes games are actually distributed in.
 */
describe('nameFromPath', () => {
  it('prefers the game folder over the executable name', () => {
    expect(nameFromPath('E:\\Games\\Elden Ring\\Game\\eldenring.exe')).toBe('Elden Ring')
    expect(nameFromPath('/Volumes/Big/Games/Baldurs Gate 3/bin/bg3.exe')).toBe('Baldurs Gate 3')
  })

  it('walks up past every structural directory an engine creates', () => {
    expect(nameFromPath('C:\\Games\\Cyberpunk 2077\\bin\\x64\\Cyberpunk2077.exe'))
      .toBe('Cyberpunk 2077')
    expect(nameFromPath('D:\\G\\Ghostrunner\\Binaries\\Win64\\Ghostrunner-Win64-Shipping.exe'))
      .toBe('Ghostrunner')
  })

  /** Release folders separate words with dots; search engines do not. */
  it('turns release-style separators into spaces', () => {
    expect(nameFromPath('D:\\Torrents\\Hollow.Knight\\hollow_knight.exe')).toBe('Hollow Knight')
    expect(nameFromPath('/mnt/d/Dead_Cells/game.sh')).toBe('Dead Cells')
  })

  it('unwraps a macOS bundle', () => {
    expect(nameFromPath('/Applications/Hollow Knight.app/Contents/MacOS/hk')).toBe('Hollow Knight')
  })

  it('falls back to the file name when there is no folder to use', () => {
    expect(nameFromPath('/hades.exe')).toBe('hades')
    expect(nameFromPath('')).toBe('')
  })
})
