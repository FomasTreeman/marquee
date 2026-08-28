/**
 * Marquee.
 *
 * Wires the shell, the library and the input stream together. Everything of
 * substance lives in its own module; this file is the assembly and should stay
 * short enough to read in one go.
 */
import { createGrid, type GridItem } from './grid'
import { createFrameMeter, installGrainTile } from './perf'
import { createShell, setHints } from './shell'
import { createBackdrop } from './backdrop'
import { hostInfo, pingMs, inApp } from './host'
import { createInput, padStatus, type Action } from './input'
import { scanLibrary, requestMeta, onMeta, steamArtwork, tintFor, type Game, type ScanResult } from './library'
import { installErrorHandlers, logInfo, logWarn, logError, renderFatal, logPath } from './log'
import { createHud } from './hud'
import { scheduleSelfCheck } from './selfcheck'

const params = new URLSearchParams(location.search)
/** ?mock=2000 forces a synthetic library, for measuring the grid at a scale no
 *  real library reaches. */
const MOCK = Number(params.get('mock') ?? 0)

/**
 * A sample library of real Steam titles.
 *
 * Real appids on purpose, so `?mock=` exercises the actual artwork path --
 * cover, wide key art and transparent logo, straight off the CDN -- rather
 * than only proving the layout. It is also the only way to see the design
 * fully populated on a machine with two games installed.
 */
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

function mockLibrary(n: number): Game[] {
  const out: Game[] = []
  for (let i = 0; i < n; i++) {
    const [appid, title] = SAMPLE[i % SAMPLE.length]!
    const round = Math.floor(i / SAMPLE.length)
    out.push({
      id: `steam:${appid}`,
      // Marked as steam so the artwork path is genuinely exercised.
      provider: 'steam',
      providerId: appid,
      title: round ? `${title} (${round + 1})` : title,
      installed: i % 7 !== 0,
      installDir: null,
      sizeBytes: (8 + (i * 13) % 90) * 1_073_741_824,
      lastPlayed: i % 3 === 0 ? Math.floor(Date.now() / 1000) - i * 86_400 : null,
      playtimeMinutes: (i * 137) % 4000,
    })
  }
  return out
}

function gib(bytes: number): string {
  if (bytes <= 0) return ''
  const g = bytes / 1_073_741_824
  return g >= 10 ? `${g.toFixed(0)} GB` : `${g.toFixed(1)} GB`
}

function playedLabel(unixSeconds: number | null): string {
  if (!unixSeconds) return 'Never played'
  const days = Math.floor((Date.now() / 1000 - unixSeconds) / 86_400)
  if (days <= 0) return 'Played today'
  if (days === 1) return 'Played yesterday'
  if (days < 30) return `Played ${days} days ago`
  const months = Math.floor(days / 30)
  return months < 12 ? `Played ${months} months ago` : `Played ${Math.floor(months / 12)} years ago`
}

const PROVIDER_NAMES: Record<string, string> = {
  steam: 'Steam',
  manual: 'Added by hand',
  mock: 'Sample',
}

function hoursLabel(minutes: number): string {
  if (minutes <= 0) return ''
  if (minutes < 60) return `${minutes} minutes played`
  return `${Math.round(minutes / 60)} hours played`
}

function heroFacts(game: Game): string[] {
  return [
    PROVIDER_NAMES[game.provider] ?? game.provider,
    game.installed ? gib(game.sizeBytes) : 'Not installed',
    hoursLabel(game.playtimeMinutes),
    playedLabel(game.lastPlayed),
  ].filter(Boolean)
}

/**
 * An empty library must explain itself.
 *
 * Pitch black with nothing on it is what this design looks like when it is
 * working perfectly, which makes it the worst possible way to report that
 * nothing was found.
 */
function renderEmpty(host: HTMLElement, scan: ScanResult): void {
  const failed = scan.providers.filter((p) => p.error)
  const box = document.createElement('div')
  box.className = 'empty'
  const title = document.createElement('b')
  const body = document.createElement('span')
  if (failed.length) {
    title.textContent = 'Could not read your library'
    body.textContent = failed.map((p) => `${p.provider}: ${p.error}`).join(' · ')
  } else if (!scan.providers.some((p) => p.detected)) {
    title.textContent = 'No stores found'
    body.textContent = 'Steam does not appear to be installed on this machine.'
  } else {
    title.textContent = 'No games installed'
    body.textContent = 'Steam is here, but nothing is installed through it yet.'
  }
  box.append(title, body)
  host.appendChild(box)
}

async function main(): Promise<void> {
  const started = performance.now()
  installGrainTile()

  const root = document.getElementById('app')!
  const shell = createShell(root)
  const backdrop = createBackdrop(shell.backdropA, shell.backdropB)

  setHints(shell.hints, [
    ['A', 'Play'],
    ['Y', 'Details'],
    ['X', 'Favourite'],
    ['☰', 'Menu'],
  ])

  // A failed scan must not take the interface with it: the shell still comes
  // up, the reason is on screen and in the log. Priority #2, in practice.
  let scan: ScanResult = { games: [], providers: [], tookMs: 0 }
  if (!MOCK) {
    try {
      scan = await scanLibrary()
      logInfo('scan', `${scan.games.length} games in ${scan.tookMs} ms`)
      for (const p of scan.providers) if (p.error) logWarn('scan', `${p.provider}: ${p.error}`)
    } catch (e) {
      logError('scan', 'library scan failed', e)
      scan = { games: [], providers: [{ provider: 'scan', detected: true, error: String(e), tookMs: 0 }], tookMs: 0 }
    }
  }

  const games: Game[] = MOCK ? mockLibrary(MOCK) : scan.games
  const art = games.map((g) => (g.provider === 'steam' ? steamArtwork(g.providerId) : {}))

  const items: GridItem[] = games.map((g, i) => ({
    id: i,
    title: g.title,
    tint: tintFor(g.title),
    art: art[i]?.cover,
  }))

  shell.count.textContent = games.length
    ? `${games.length} ${games.length === 1 ? 'game' : 'games'}`
    : ''

  function refreshHero(index: number): void {
    const game = games[index]
    if (!game) return
    backdrop.show(art[index]?.hero)

    const logo = art[index]?.logo
    // The transparent wordmark is the design's preferred title. Fall back to
    // type only when there is no logo, rather than showing both.
    shell.heroLogo.hidden = !logo
    shell.heroTitle.hidden = !!logo
    if (logo && shell.heroLogo.getAttribute('src') !== logo) {
      shell.heroLogo.src = logo
      shell.heroLogo.onerror = () => {
        // Falling back to type is correct; doing it silently is not, because
        // it looks identical to a game that simply has no wordmark.
        logWarn('art', `hero logo failed for ${game.title}`, logo)
        shell.heroLogo.hidden = true
        shell.heroTitle.hidden = false
      }
    }
    shell.heroTitle.textContent = game.title || 'Loading…'

    shell.heroMeta.textContent = ''
    heroFacts(game).forEach((fact, n) => {
      if (n) {
        const dot = document.createElement('span')
        dot.className = 'dot'
        dot.textContent = '·'
        shell.heroMeta.appendChild(dot)
      }
      const span = document.createElement('span')
      span.textContent = fact
      shell.heroMeta.appendChild(span)
    })
  }

  const grid = createGrid(shell.gridViewport, refreshHero)

  if (!games.length) {
    renderEmpty(shell.gridViewport, scan)
  } else {
    // setItems announces the initial selection itself, so the hero and the
    // backdrop populate on load without nudging focus back and forth.
    grid.setItems(items)

    // Names arrive progressively. Artwork does not need them -- every cover,
    // wide art and wordmark is keyed by appid alone -- so the library looks
    // right immediately and fills in its text over the next few minutes.
    //
    // Requested in library order, which is most-recently-played first, so the
    // games actually on screen are named before anything below the fold.
    const byAppId = new Map<string, number>()
    games.forEach((g, i) => { if (g.provider === 'steam') byAppId.set(g.providerId, i) })

    const applyMeta = (appId: string, name: string) => {
      const index = byAppId.get(appId)
      if (index === undefined || !name) return
      const game = games[index]!
      if (game.title === name) return
      game.title = name
      grid.setTitle(index, name)
      if (index === grid.focused) refreshHero(index)
    }

    const unlisten = await onMeta((m) => applyMeta(m.appId, m.name))
    window.addEventListener('beforeunload', () => unlisten())

    const cached = await requestMeta([...byAppId.keys()])
    for (const m of cached) applyMeta(m.appId, m.name)
    logInfo('meta', `${cached.length}/${byAppId.size} names already cached`)
  }

  const NAV: Partial<Record<Action, [number, number]>> = {
    left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1],
  }
  const hud = createHud(grid, createFrameMeter())
  await createInput((e) => {
    hud.noteInput(e.latency)
    if (e.action === 'y' && !e.repeat) hud.toggle()
    const d = NAV[e.action]
    if (d) grid.move(d[0], d[1])
  })

  await hud.attach({
    host: await hostInfo(),
    ipc: await pingMs(),
    pad: await padStatus(),
    scan,
    total: games.length,
  })

  // Asserts the invariants that error handling cannot see -- artwork actually
  // painted on top, the focus ring not clipped, the shell laid out. Both real
  // bugs found so far were silent and would have failed one of these.
  if (import.meta.env.DEV || params.get('check') === '1') scheduleSelfCheck()

  logInfo('boot', `ready in ${(performance.now() - started).toFixed(0)} ms · ${games.length} games · shell=${inApp ? 'tauri' : 'browser'}`)
}

// Installed before anything else runs, so a failure inside main() still
// reaches the log and the screen. Without it, `void main()` swallows every
// rejection and a broken window is indistinguishable from a working one.
installErrorHandlers()
main().catch(async (e) => renderFatal(e, await logPath()))
