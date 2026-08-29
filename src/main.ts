/**
 * Marquee.
 *
 * Wires the shell, the library and the input stream together. Everything of
 * substance lives in its own module; this file is the assembly and should stay
 * short enough to read in one go.
 */
import { createGrid } from './grid'
import { createFrameMeter, installGrainTile } from './perf'
import { createShell, setHints } from './shell'
import { createBackdrop } from './backdrop'
import { createDetail } from './detail'
import { createAdd } from './add'
import { createHud } from './hud'
import { createOsk } from './osk'
import { toast } from './toast'
import { hostInfo, pingMs, inApp } from './host'
import { createInput, padStatus, type Action } from './input'
import {
  scanLibrary, requestMeta, onMeta, launchGame, toggleFavourite,
  initArtwork, steamArtwork, tintFor,
  type Artwork, type Game, type Meta, type ScanResult,
} from './library'
import { installErrorHandlers, logInfo, logWarn, logError, renderFatal, logPath } from './log'
import { scheduleSelfCheck } from './selfcheck'
import { apply as applyFilter, describe as describeFilter, PRESETS, type Preset } from './filter'
import { SAMPLE_LIBRARY } from './sample'

const params = new URLSearchParams(location.search)
/** ?mock=40 forces a synthetic library, for looking at the design on a machine
 *  without one and for measuring the grid at a scale no real library reaches. */
const MOCK = Number(params.get('mock') ?? 0)

// --- formatting ---------------------------------------------------------

function gib(bytes: number): string {
  if (bytes <= 0) return ''
  const g = bytes / 1_073_741_824
  return g >= 10 ? `${g.toFixed(0)} GB` : `${g.toFixed(1)} GB`
}

function hoursLabel(minutes: number): string {
  if (minutes <= 0) return ''
  if (minutes < 60) return `${minutes} minutes played`
  return `${Math.round(minutes / 60)} hours played`
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

function heroFacts(game: Game): string[] {
  const store = game.provider === 'steam' ? 'Steam' : 'Added by hand'
  const state = game.provider === 'manual' && !game.installed
    ? 'No executable set'
    : game.installed ? gib(game.sizeBytes) || 'Installed' : 'Not installed'
  return [
    game.favourite ? '★ Favourite' : '',
    store,
    state,
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
function emptyMessage(scan: ScanResult): [string, string] {
  const failed = scan.providers.filter((p) => p.error)
  if (failed.length) {
    return ['Could not read your library', failed.map((p) => `${p.provider}: ${p.error}`).join(' · ')]
  }
  if (!scan.providers.some((p) => p.detected && p.provider === 'steam')) {
    return ['No stores found', 'Steam does not appear to be installed. Press ☰ to add a game by name.']
  }
  return ['No games yet', 'Steam is here but nothing has been played or installed. Press ☰ to add a game by name.']
}

// --- assembly -----------------------------------------------------------

async function main(): Promise<void> {
  const started = performance.now()
  installGrainTile()

  // Before anything asks for an artwork URL: the answer differs between the
  // app and a browser tab, and getting it late would mean two kinds of URL in
  // one library.
  await initArtwork()

  const shell = createShell(document.getElementById('app')!)
  const backdrop = createBackdrop(shell.backdropA, shell.backdropB)
  setHints(shell.hints, [
    ['A', 'Play'], ['Y', 'Details'], ['X', 'Favourite'],
    ['LB/RB', 'Filter'], ['/', 'Search'], ['☰', 'Add a game'],
  ])

  // Library state. Rebuilt wholesale by reloadLibrary(), so adding a game
  // arrives through exactly the same path as every other one rather than a
  // second code path that could disagree with the first.
  let games: Game[] = []
  let art: Artwork[] = []
  let scan: ScanResult = { games: [], providers: [], tookMs: 0 }
  const meta = new Map<string, Meta>()

  // What the grid is currently showing: indices into `games`, in grid order.
  // Keeping the filtered view as indices rather than a second array of games
  // means a metadata update or a favourite toggle has exactly one place to
  // write, whatever is on screen.
  let view: number[] = []
  let preset: Preset = 'all'
  let query = ''

  const gameAt = (viewIndex: number): Game | undefined => games[view[viewIndex] ?? -1]
  const artAt = (viewIndex: number): Artwork => art[view[viewIndex] ?? -1] ?? {}

  function refreshHero(viewIndex: number): void {
    const game = gameAt(viewIndex)
    if (!game) return
    const a = artAt(viewIndex)
    backdrop.show(a.hero)

    // The transparent wordmark is the design's preferred title. Type is the
    // fallback rather than an addition, so never both.
    const logo = a.logo
    shell.heroLogo.hidden = !logo
    shell.heroTitle.hidden = !!logo
    if (logo && shell.heroLogo.getAttribute('src') !== logo) {
      shell.heroLogo.src = logo
      shell.heroLogo.onerror = () => {
        // Falling back to type is correct; doing it silently is not, because it
        // looks identical to a game that simply has no wordmark.
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

  function showEmpty(): void {
    const [title, body] = emptyMessage(scan)
    const box = document.createElement('div')
    box.className = 'empty'
    const b = document.createElement('b')
    b.textContent = title
    const span = document.createElement('span')
    span.textContent = body
    box.append(b, span)
    shell.gridViewport.appendChild(box)
  }

  function paintPresets(): void {
    shell.presets.textContent = ''
    for (const p of PRESETS) {
      const pill = document.createElement('span')
      pill.className = 'preset'
      pill.dataset['active'] = p.id === preset ? '1' : '0'
      // A preset that would show nothing is dimmed rather than hidden --
      // hiding it would shift every other pill as the library changes.
      pill.dataset['empty'] = applyFilter(games, p.id, '').length ? '0' : '1'
      pill.textContent = p.label
      shell.presets.appendChild(pill)
    }
  }

  /** Rebuild the grid from the current preset and query, keeping the cursor on
   *  the same game where it survives the filter. */
  function applyView(): void {
    const keepId = gameAt(grid.focused)?.id
    view = applyFilter(games, preset, query)
    paintPresets()
    shell.count.textContent = describeFilter(preset, query, view.length, games.length)

    shell.gridViewport.querySelector('.empty')?.remove()
    if (!view.length) {
      grid.setItems([])
      if (!games.length) { showEmpty(); return }
      const box = document.createElement('div')
      box.className = 'empty'
      const b = document.createElement('b')
      b.textContent = 'Nothing matches'
      const span = document.createElement('span')
      span.textContent = query.trim()
        ? `No game here is called “${query.trim()}”.`
        : 'This filter has no games in it.'
      box.append(b, span)
      shell.gridViewport.appendChild(box)
      return
    }

    grid.setItems(view.map((g, i) => ({
      id: i,
      title: games[g]!.title,
      tint: tintFor(games[g]!.title || games[g]!.providerId),
      art: art[g]?.cover,
    })))

    const restored = keepId ? view.findIndex((g) => games[g]!.id === keepId) : -1
    if (restored > 0) grid.focus(restored)
  }

  /** Rescan and rebuild everything, keeping the cursor on the same game. */
  async function reloadLibrary(): Promise<void> {
    try {
      scan = MOCK ? { games: [], providers: [], tookMs: 0 } : await scanLibrary()
      for (const p of scan.providers) if (p.error) logWarn('scan', `${p.provider}: ${p.error}`)
    } catch (e) {
      logError('scan', 'library scan failed', e)
      scan = { games: [], providers: [{ provider: 'scan', detected: true, error: String(e), tookMs: 0 }], tookMs: 0 }
    }

    games = MOCK ? SAMPLE_LIBRARY(MOCK) : scan.games
    art = games.map((g) => (g.providerId.match(/^\d+$/) ? steamArtwork(g.providerId) : {}))
    // A title already known beats waiting for the worker to re-announce it.
    games.forEach((g) => { const m = meta.get(g.providerId); if (m && !g.title) g.title = m.name })

    applyView()
    if (!games.length) return

    // Artwork needs no names -- every asset is keyed by appid alone -- so the
    // library looks right immediately and fills in its text afterwards.
    // Requested in library order, which is most-recently-played first, so what
    // is on screen is named before anything below the fold.
    const appIds = games.filter((g) => g.providerId.match(/^\d+$/)).map((g) => g.providerId)
    const ready = await requestMeta(appIds)
    for (const m of ready) applyMeta(m)
    logInfo('meta', `${ready.length}/${appIds.length} names already cached`)
  }

  function applyMeta(m: Meta): void {
    meta.set(m.appId, m)
    if (!m.name) return
    games.forEach((g, gameIndex) => {
      if (g.providerId !== m.appId || g.title === m.name) return
      g.title = m.name
      // Only the grid position, if this game is currently shown at all.
      const viewIndex = view.indexOf(gameIndex)
      if (viewIndex < 0) return
      grid.setTitle(viewIndex, m.name)
      if (viewIndex === grid.focused) refreshHero(viewIndex)
    })
  }

  const unlistenMeta = await onMeta(applyMeta)
  window.addEventListener('beforeunload', () => unlistenMeta())

  await reloadLibrary()

  // --- actions ----------------------------------------------------------

  // Guarded against repeats: A is the button most likely to be double-tapped,
  // and asking Steam to start the same game twice in 200 ms is a good way to
  // get two windows or none.
  let launching = false
  async function play(index: number): Promise<void> {
    const game = gameAt(index)
    if (!game || launching) return
    if (game.provider === 'manual' && !game.installed) {
      toast(`${game.title} has no executable yet. Press Y to set one.`, 'error', 6000)
      return
    }
    launching = true
    const label = game.title || `App ${game.providerId}`
    try {
      const how = await launchGame(game.id)
      logInfo('run', `launched ${label} via ${how}`)
      toast(game.provider === 'steam' ? `Starting ${label} — handing off to Steam` : `Starting ${label}`)
    } catch (e) {
      toast(`Could not start ${label}. ${String(e)}`, 'error', 7000)
    } finally {
      window.setTimeout(() => { launching = false }, 1500)
    }
  }

  async function favourite(index: number): Promise<void> {
    const game = gameAt(index)
    if (!game) return
    try {
      game.favourite = await toggleFavourite(game.id)
      // A game unfavourited while the Favourites preset is showing must leave
      // the grid, or the filter is a lie.
      if (preset === 'favourites') applyView()
      else { paintPresets(); refreshHero(index) }
      toast(game.favourite ? `Favourited ${game.title}` : `Removed ${game.title} from favourites`)
    } catch (e) {
      toast(`Could not save that. ${String(e)}`, 'error')
    }
  }

  function cyclePreset(direction: number): void {
    const at = PRESETS.findIndex((p) => p.id === preset)
    const next = PRESETS[(at + direction + PRESETS.length) % PRESETS.length]!
    preset = next.id
    query = ''
    shell.query.hidden = true
    shell.query.value = ''
    grid.focus(0)
    applyView()
  }

  const osk = createOsk()

  function openSearch(): void {
    shell.query.hidden = false
    shell.query.focus()
    shell.query.select()
    // Only when there is a pad. On a desk the physical keyboard is faster and
    // an on-screen one is just a panel covering the results.
    if (padConnected) osk.attach(shell.query)
  }

  shell.query.addEventListener('input', () => {
    query = shell.query.value
    grid.focus(0)
    applyView()
  })
  shell.query.addEventListener('blur', () => {
    osk.close()
    // An empty search box left on screen is clutter; a populated one is state
    // the user can see, so it stays.
    if (!query.trim()) shell.query.hidden = true
  })
  shell.query.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { query = ''; shell.query.value = ''; shell.query.blur(); applyView() }
    if (e.key === 'Enter') shell.query.blur()
  })

  const detail = createDetail(() => void play(grid.focused), () => void reloadLibrary())
  const add = createAdd(() => void reloadLibrary())

  // Steam writes playtime into localconfig itself, so returning to the window
  // after playing is exactly when a rescan is worth doing -- it picks up the
  // real figure from Steam's own records with no process watching at all.
  let lastRefresh = Date.now()
  window.addEventListener('focus', () => {
    if (Date.now() - lastRefresh < 30_000) return
    lastRefresh = Date.now()
    void reloadLibrary().catch((e) => logWarn('scan', 'refresh after focus failed', e))
  })

  // --- input ------------------------------------------------------------

  const NAV: Partial<Record<Action, [number, number]>> = {
    left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1],
  }
  const hud = createHud(grid, createFrameMeter())
  // Whether to offer the on-screen keyboard at all. Read once at startup; a
  // pad plugged in later is handled by the status the input layer reports.
  const pad = await padStatus()
  const padConnected = pad.connected > 0

  await createInput((e) => {
    hud.noteInput(e.latency)

    // Overlays take input entirely while open, innermost first. Letting
    // navigation fall through would move the selection behind them, so closing
    // one would land the cursor somewhere the user never put it.
    //
    // The keyboard is innermost of all: while it is up, the pad is typing.
    if (osk.handle(e.action)) return
    if (add.handle(e.action)) return
    if (detail.handle(e.action)) return

    if (!e.repeat) {
      if (e.action === 'perf') { hud.toggle(); return }
      if (e.action === 'a') { void play(grid.focused); return }
      if (e.action === 'x') { void favourite(grid.focused); return }
      if (e.action === 'menu' || e.action === 'mainmenu') {
        add.open()
        if (padConnected) osk.attach(add.field)
        return
      }
      if (e.action === 'y') {
        const game = gameAt(grid.focused)
        if (game) detail.open(game, meta.get(game.providerId), artAt(grid.focused))
        return
      }
      if (e.action === 'search') { openSearch(); return }
      if (e.action === 'lb' || e.action === 'rb') { cyclePreset(e.action === 'rb' ? 1 : -1); return }
    }

    // Shoulder buttons repeat, so preset cycling is handled before this and
    // must not fall through to navigation.
    if (e.action === 'lb' || e.action === 'rb') { cyclePreset(e.action === 'rb' ? 1 : -1); return }

    const d = NAV[e.action]
    if (d) grid.move(d[0], d[1])
  })

  await hud.attach({
    host: await hostInfo(),
    ipc: await pingMs(),
    pad,
    scan,
    total: games.length,
  })

  // A handle on the running interface, for development only.
  //
  // Overlays and selection are otherwise reachable only through real input,
  // which makes them awkward to inspect from a console or a driven browser --
  // and an overlay nobody can open is an overlay nobody can check. Also lets
  // the self-check reach state it would otherwise have to infer from the DOM.
  if (import.meta.env.DEV) {
    Object.assign(window as unknown as Record<string, unknown>, {
      __marquee: {
        get games() { return games },
        get focused() { return grid.focused },
        get scan() { return scan },
        meta,
        grid,
        add,
        detail,
        play,
        favourite,
        reloadLibrary,
        selfCheck: () => import('./selfcheck').then((m) => m.runSelfCheck()),
      },
    })
  }

  // Asserts the invariants error handling cannot see -- artwork actually
  // painted on top, the focus ring not clipped, the shell laid out, the hero
  // populated. Every silent bug found so far would have failed one of these.
  if (import.meta.env.DEV || params.get('check') === '1') scheduleSelfCheck()

  logInfo('boot', `ready in ${(performance.now() - started).toFixed(0)} ms · ${games.length} games · shell=${inApp ? 'tauri' : 'browser'}`)
}

// Installed before anything else runs, so a failure inside main() still
// reaches the log and the screen. Without it, an unhandled rejection leaves a
// window that renders nothing with no error anywhere.
installErrorHandlers()
main().catch(async (e) => renderFatal(e, await logPath()))
