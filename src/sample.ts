/**
 * A sample library of real Steam titles.
 *
 * Real appids on purpose, so `?mock=` exercises the actual artwork path --
 * cover, wide key art and transparent wordmark, straight off the CDN -- rather
 * than only proving the layout. It is also the only way to see the design
 * fully populated on a machine with two games installed.
 */
import type { Game } from './library'

const SAMPLE: Array<[string, string]> = [
  ['1245620', 'ELDEN RING'],
  ['1174180', 'Red Dead Redemption 2'],
  ['1086940', "Baldur's Gate 3"],
  ['1091500', 'Cyberpunk 2077'],
  ['292030', 'The Witcher 3: Wild Hunt'],
  ['1593500', 'God of War'],
  ['1817070', "Marvel's Spider-Man Remastered"],
  ['1888930', 'The Last of Us Part I'],
  ['2050650', 'Resident Evil 4'],
  ['990080', 'Hogwarts Legacy'],
  ['1145360', 'Hades'],
  ['1145350', 'Hades II'],
  ['367520', 'Hollow Knight'],
  ['413150', 'Stardew Valley'],
  ['105600', 'Terraria'],
  ['892970', 'Valheim'],
  ['1237970', 'Titanfall 2'],
  ['620', 'Portal 2'],
  ['570', 'Dota 2'],
  ['440', 'Team Fortress 2'],
  ['1462040', 'Final Fantasy VII Remake'],
  ['1517290', 'Battlefield 2042'],
  ['588650', 'Dead Cells'],
  ['648800', 'Raft'],
]

/** Browser-only stand-in for Steam's store search. See searchGames(). */
export function searchSample(term: string): Array<{ appId: string; name: string; cover: string }> {
  const q = term.trim().toLowerCase()
  return SAMPLE.filter(([, name]) => name.toLowerCase().includes(q))
    .slice(0, 12)
    .map(([appId, name]) => ({
      appId,
      name,
      cover: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`,
    }))
}

export function SAMPLE_LIBRARY(n: number): Game[] {
  const out: Game[] = []
  for (let i = 0; i < n; i++) {
    const [appId, title] = SAMPLE[i % SAMPLE.length]!
    const round = Math.floor(i / SAMPLE.length)
    out.push({
      id: `steam:${appId}${round ? `-${round}` : ''}`,
      provider: 'steam',
      providerId: appId,
      title: round ? `${title} (${round + 1})` : title,
      installed: i % 7 !== 0,
      installDir: null,
      sizeBytes: (8 + (i * 13) % 90) * 1_073_741_824,
      lastPlayed: i % 3 === 0 ? Math.floor(Date.now() / 1000) - i * 86_400 : null,
      playtimeMinutes: (i * 137) % 4000,
      favourite: i % 11 === 0,
      hidden: false,
      artAppId: null,
    })
  }
  return out
}
