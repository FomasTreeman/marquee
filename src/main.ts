/**
 * Marquee.
 *
 * Wires the shell, the library and the input stream together. Everything of
 * substance lives in its own module; this file is the assembly and should stay
 * short enough to read in one go.
 */
import { createGrid } from './grid'
import { createFrameMeter, installGrainTile } from './perf'
import { createShell, legendFor, setHints } from './shell'
import { createBackdrop } from './backdrop'
import { createDetail } from './detail'
import { createPicker } from './picker'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import { createHud } from './hud'
import { createOsk } from './osk'
import { createMenu, mainMenuItems } from './menu'
import { createSettings } from './settings'
import { toast } from './toast'
import { hostInfo, pingMs, inApp } from './host'
import { createInput, padStatus, type Action, type Device } from './input'
import {
  scanLibrary, requestMeta, onMeta, onLaunchFailed, launchGame, toggleFavourite,
  getSettings, setSetting, toggleFullscreen, systemAction, findProfile, importProfile,
  addManualGame, setManualExecutable, setArtSource, artworkReport,
  initArtwork, steamArtwork, artIdFor, tintFor,
  type Artwork, type Game, type Meta, type ScanResult,
} from './library'
import { installErrorHandlers, logInfo, logWarn, logError, renderFatal, logPath } from './log'
import { scheduleSelfCheck } from './selfcheck'
import { declineUpdate, scheduleUpdateCheck, updateMenuItems } from './update'
import {
  apply as applyFilter, describe as describeFilter,
  PRESETS, SORTS, type Preset, type Sort,
} from './filter'

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
  // Long-pressing a face button is the console convention for fullscreen, but
  // it needs a hold timer and a pad to test it on. F11 is the keyboard one and
  // it works everywhere today.

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
  let sort: Sort = 'recent'

  const gameAt = (viewIndex: number): Game | undefined => games[view[viewIndex] ?? -1]
  const artAt = (viewIndex: number): Artwork => art[view[viewIndex] ?? -1] ?? {}

  /** Cleared on the next selection, so holding a direction does not leave the
   *  hero stuck mid-fade. */
  let heroSettle: number | undefined

  function refreshHero(viewIndex: number): void {
    const game = gameAt(viewIndex)
    if (!game) return

    // Out, swap, in. The class is removed on the next frame rather than after
    // the transition, so navigating quickly re-triggers cleanly instead of
    // queueing a fade per keypress.
    shell.hero.classList.add('is-changing')
    window.clearTimeout(heroSettle)
    heroSettle = window.setTimeout(() => shell.hero.classList.remove('is-changing'), 60)
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

  /**
   * Open the details screen for a card.
   *
   * Hoisted and shared rather than defined per device, because it was
   * previously only reachable from the legend closure -- which is how the
   * mouse ended up with no route to it at all.
   */
  function openDetails(index: number): void {
    const game = gameAt(index)
    if (game) detail.open(game, meta.get(game.providerId), artAt(index))
  }

  const grid = createGrid(
    shell.gridViewport,
    refreshHero,
    (index) => void play_(index),
    openDetails,
  )

  function showEmpty(): void {
    const [title, body] = emptyMessage(scan)
    const box = document.createElement('div')
    box.className = 'empty'
    const b = document.createElement('b')
    b.textContent = title
    const span = document.createElement('span')
    span.textContent = body
    // First run has no games to select and therefore nothing for A to do, so
    // the prompt says what A does instead. A screen that can only be left with
    // a mouse is not a screen for a television.
    const prompt = document.createElement('span')
    prompt.className = 'empty-prompt'
    prompt.textContent = 'Press A to add a game by name'
    box.append(b, span, prompt)
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
      // Clickable, because a mouse user has no stick to press and the pills
      // already look like controls.
      pill.onclick = () => {
        preset = p.id
        query = ''
        shell.query.hidden = true
        shell.query.value = ''
        grid.focus(0)
        applyView()
      }
      shell.presets.appendChild(pill)
    }
  }

  /** Rebuild the grid from the current preset and query, keeping the cursor on
   *  the same game where it survives the filter. */
  function applyView(): void {
    const keepId = gameAt(grid.focused)?.id
    // Metadata feeds the search, so "roguelike" or "larian" finds something
    // once a game's details have arrived.
    view = applyFilter(games, preset, query, sort, (g) => meta.get(g.providerId))
    paintPresets()
    shell.count.textContent = describeFilter(preset, query, view.length, games.length, sort)

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

    // Loaded on demand so the mock library -- a hundred-odd real appids and
    // titles -- is not carried in the bundle every user downloads. It is a
    // development affordance; `?mock=` is the only thing that reaches it.
    if (MOCK) {
      const { SAMPLE_LIBRARY } = await import('./sample')
      games = SAMPLE_LIBRARY(MOCK)
    } else {
      games = scan.games
    }
    // Artwork follows the user's override where there is one, so a game whose
    // own appid has no cover can borrow another's.
    art = games.map((g) => { const key = artIdFor(g); return key ? steamArtwork(key) : {} })
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
    // A name landing can change where its game belongs.
    resortLater()
  }

  const unlistenMeta = await onMeta(applyMeta)
  // A launch that fails after spawning has no other way to reach the user:
  // the button worked, the toast said "starting", and then nothing happened.
  const unlistenFailed = await onLaunchFailed(({ title, detail }) => {
    toast(
      `${title || 'That game'} ${detail}. Its executable may have moved, or need ` +
        'files that are no longer there.',
      'error',
      9000,
    )
  })
  window.addEventListener('beforeunload', () => { unlistenMeta(); unlistenFailed() })

  await reloadLibrary()

  // --- actions ----------------------------------------------------------

  // Guarded against repeats: A is the button most likely to be double-tapped,
  // and asking Steam to start the same game twice in 200 ms is a good way to
  // get two windows or none.
  let launching = false
  async function play_(index: number): Promise<void> {
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
      // Steam is started silently first when it is closed, which takes a few
      // seconds. Saying so beats a toast that implies the game is coming now.
      const cold = how.includes('starting Steam')
      toast(
        cold
          ? `Starting Steam, then ${label}. This takes a few seconds.`
          : game.provider === 'steam'
            ? `Starting ${label}`
            : `Starting ${label}`,
        'info',
        cold ? 9000 : 4000,
      )
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

  const osk = createOsk()

  /**
   * Change the order, and remember it.
   *
   * Re-sorting is debounced when names are still arriving: sorting by name on a
   * first run would otherwise reshuffle the grid under the cursor once per
   * metadata event, which is intolerable on a pad.
   */
  const menu = createMenu()

  /** Rebuild the legend for whatever is now being held. The table itself is
   *  in shell.ts, as data, so "every action reaches every device" is tested. */
  function refreshHints(device: Device): void {
    setHints(
      shell.hints,
      legendFor(device, {
        play: () => void play_(grid.focused),
        details: () => openDetails(grid.focused),
        favourite: () => void favourite(grid.focused),
        sort: openSort,
        filter: openFilter,
        search: openSearch,
        menu: openMainMenu,
        add: openAdd,
      }),
    )
  }


  /**
   * Sort and filter are separate menus on separate sticks, because they are
   * separate questions. Cycling a hidden value with a shoulder button meant
   * neither was discoverable and the two were easy to confuse.
   */
  function openSort(): void {
    menu.open({
      title: 'Sort by',
      items: SORTS.map((s) => ({ id: s.id, label: s.label, selected: s.id === sort })),
      onChoose(id) {
        sort = id as Sort
        void setSetting('sort', sort).catch(() => { /* an unsaved preference is not a toast */ })
        grid.focus(0)
        applyView()
      },
    })
    checkNow('sort')
  }

  function openFilter(): void {
    menu.open({
      title: 'Show',
      anchor: 'right',
      items: [
        // Search belongs here, not on a button of its own. It is a way of
        // narrowing the library, which is what this menu is for, and it gives
        // search a controller route without inventing a binding for it —
        // which is how PS5 and Xbox both handle it.
        {
          id: 'search',
          label: query.trim() ? `Search — “${query.trim()}”` : 'Search…',
          detail: query.trim() ? 'change' : '',
        },
        ...PRESETS.map((p) => ({
          id: p.id,
          label: p.label,
          selected: p.id === preset,
          // The count answers "is this worth opening" before it is opened, and
          // dims a preset that would show an empty grid.
          detail: String(applyFilter(games, p.id, '', sort).length),
          disabled: applyFilter(games, p.id, '', sort).length ? undefined : 'none',
        })),
      ],
      onChoose(id) {
        if (id === 'search') { openSearch(); return }
        preset = id as Preset
        query = ''
        shell.query.hidden = true
        shell.query.value = ''
        grid.focus(0)
        applyView()
      },
    })
    checkNow('filter')
  }

  function openMainMenu(): void {
    menu.open({
      title: 'Marquee',
      items: mainMenuItems(games.length),
      async onChoose(id) {
        if (id === 'settings') {
          settings.open()
          if (padConnected) osk.attach(settings.field)
          return
        }
        if (id === 'rescan') {
          toast('Updating library…', 'info', 2000)
          await reloadLibrary()
          toast(`${games.length} games.`)
          return
        }
        try {
          await systemAction(id)
        } catch (e) {
          toast(String(e), 'error', 6000)
        }
      },
    })
    checkNow('menu')
  }

  let resortPending: number | undefined
  function resortLater(): void {
    if (sort !== 'name') return
    window.clearTimeout(resortPending)
    resortPending = window.setTimeout(() => applyView(), 900)
  }

  function openSearch(): void {
    shell.query.hidden = false
    shell.query.focus()
    shell.query.select()
    // The on-screen keyboard is what makes search reachable at all from a pad.
    // Without it this opens a field nobody can type into.
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

  const picker = createPicker()

  /**
   * Re-run the invariants after a surface appears.
   *
   * Checking only at boot means every overlay is checked in the one state it
   * is never in: closed. These are exactly the surfaces where something can be
   * silently unreachable, so they are checked when they open.
   */
  const checkNow = (context: string) => {
    if (import.meta.env.DEV || params.get('check') === '1') scheduleSelfCheck(600, context)
  }

  function openAdd(): void {
    picker.open({
      heading: 'Add a game',
      sub: 'Type its name — or browse for it, and the name is worked out for you.',
      // Browsing answers "where is it"; the search still answers "what is it",
      // because artwork and metadata are keyed by the game rather than by a
      // path. Doing both in one pass means a hand-added game arrives complete
      // and playable instead of needing a second visit to set its executable.
      browse: {
        label: 'Browse for a file…',
        async choose() {
          if (!inApp) return null
          const picked = await openFileDialog({
            multiple: false,
            directory: false,
            title: 'Where is the game?',
            filters: [{ name: 'Programs', extensions: ['exe', 'app', 'sh', 'bat', 'cmd', 'AppImage', '*'] }],
          })
          return typeof picked === 'string' ? picked : null
        },
      },
      async onPick(hit, file) {
        try {
          const id = await addManualGame(hit.name, hit.appId)
          if (file) await setManualExecutable(id, file)
          logInfo('add', `added ${hit.name} (appid ${hit.appId})${file ? ` at ${file}` : ''}`)
          toast(
            file
              ? `Added ${hit.name}, ready to play.`
              : `Added ${hit.name}. Press Y to set its executable.`,
            'info',
            5000,
          )
          await reloadLibrary()
          return true
        } catch (e) {
          toast(`Could not add ${hit.name}. ${String(e)}`, 'error', 6000)
          return false
        }
      },
    })
    if (padConnected) osk.attach(picker.field)
    checkNow('add')
  }

  /**
   * Re-match a game's artwork.
   *
   * Reachable for any game, not just hand-added ones: a Steam release can have
   * no cover on the CDN, or be listed there under a different name, and until
   * now there was no way back from that.
   */
  function openArtwork(game: Game): void {
    if (!steamGridDbKey) {
      // Searching Steam here is what made the previous attempts do nothing:
      // the obvious match is the game itself, and re-pointing a game at its own
      // appid changes exactly nothing.
      toast(
        'Finding artwork needs a SteamGridDB key — it is the source that has ' +
          'the art Steam is missing. Add one in Settings (Select).',
        'error',
        9000,
      )
      settings.open()
      if (padConnected) osk.attach(settings.field)
      return
    }
    picker.open({
      heading: 'Find artwork',
      source: 'artwork',
      sub: `Pick the SteamGridDB entry to take artwork from. ${game.title || 'This game'} will use its cover, key art and wordmark.`,
      initial: game.title,
      async onPick(hit) {
        try {
          await setArtSource(game.id, hit.appId)
          logInfo('art', `${game.id} artwork -> ${hit.name} (${hit.appId})`)
          toast(`Using artwork from ${hit.name}.`)
          await reloadLibrary()
          return true
        } catch (e) {
          toast(`Could not set that. ${String(e)}`, 'error')
          return false
        }
      },
    })
    if (padConnected) osk.attach(picker.field)
    checkNow('artwork')
  }

  // Whether the second artwork source is available at all. Read once at start
  // and refreshed when settings change.
  let steamGridDbKey = ''
  let savedSort = 'recent'
  async function refreshSettings(): Promise<void> {
    try {
      const s = await getSettings()
      steamGridDbKey = s.steamgriddbKey
      savedSort = s.sort || 'recent'
    } catch (e) {
      // Losing settings means the saved sort and the SteamGridDB key both
      // quietly revert, which reads as "it forgot" rather than as a failure.
      logWarn('settings', 'could not read settings; using defaults', e)
      steamGridDbKey = ''
    }
  }
  await refreshSettings()
  sort = (SORTS.find((s) => s.id === savedSort)?.id ?? 'recent') as Sort

  const settings = createSettings(() => {
    void refreshSettings()
    // Artwork was cleared, so every <img> must be asked again. Reloading the
    // library rebuilds them all with the same URLs, which the webview will now
    // re-request because the cache behind them is empty.
    void reloadLibrary()
  })

  const detail = createDetail({
    onPlay: () => void play_(grid.focused),
    onChanged: () => void reloadLibrary(),
    onFindArtwork: openArtwork,
    // Only when a pad is what is being held -- putting a keyboard on screen
    // for someone who has one in front of them is in the way, not helpful.
    // A closure rather than a conditional hook because padConnected is read
    // later in startup than this.
    onTextField: (field) => { if (padConnected) osk.attach(field) },
  })

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
    if (menu.handle(e.action)) return
    if (settings.handle(e.action)) return
    if (picker.handle(e.action)) return
    if (detail.handle(e.action)) return

    if (!e.repeat) {
      if (e.action === 'perf') { hud.toggle(); return }
      if (e.action === 'fullscreen') {
        void toggleFullscreen().catch((err) => toast(`Could not switch. ${String(err)}`, 'error'))
        return
      }
      if (e.action === 'a') {
        // Nothing to play on an empty library, so A does the only useful thing.
        if (!view.length) openAdd()
        else void play_(grid.focused)
        return
      }
      if (e.action === 'x') { void favourite(grid.focused); return }
      if (e.action === 'menu') { openMainMenu(); return }
      if (e.action === 'add') { openAdd(); return }
      if (e.action === 'filter') { openFilter(); return }
      if (e.action === 'search') { openSearch(); return }
      if (e.action === 'y') {
        const game = gameAt(grid.focused)
        if (game) {
          detail.open(game, meta.get(game.providerId), artAt(grid.focused))
          // The manifest is written when artwork resolves, which may be after
          // the card was drawn, so it is fetched on open rather than cached.
          void artworkReport([game.providerId])
            .then((r) => {
              if (r[0] && detail.isOpen) {
                detail.open(game, meta.get(game.providerId), artAt(grid.focused), r[0])
              }
            })
            .catch(() => { /* a missing report is a fact that says "not yet" */ })
          checkNow('detail')
        }
        return
      }
      if (e.action === 'sort') { openSort(); return }
    }
    // Shoulder buttons page through a long library. They repeat, so they are
    // handled outside the no-repeat block.
    if (e.action === 'lb' || e.action === 'rb') {
      grid.move(0, e.action === 'rb' ? 3 : -3)
      return
    }

    const d = NAV[e.action]
    if (d) grid.move(d[0], d[1])
  }, refreshHints)

  // Something has to be on screen before the first key is pressed. A pad is
  // assumed only when one is actually connected.
  refreshHints(padConnected ? 'pad' : 'keyboard')

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
        picker,
        detail,
        menu,
        openMainMenu,
        openSort,
        openFilter,
        openAdd,
        openArtwork,
        settings,
        play: play_,
        favourite,
        reloadLibrary,
        selfCheck: () => import('./selfcheck').then((m) => m.runSelfCheck()),
      },
    })
  }

  // --- a profile left behind by a previous install ----------------------
  //
  // A fresh Windows install wipes %APPDATA% and takes the database with it,
  // but the games are usually on another drive — and so, if a copy was kept
  // beside them, is the profile. Offered rather than applied: importing over
  // someone's library without asking is not a decision to make for them.
  if (games.length && !games.some((g) => g.favourite || g.hidden || g.provider === 'manual')) {
    void findProfile()
      .then(async (found) => {
        if (!found) return
        logInfo('profile', `found a profile at ${found}`)
        menu.open({
          title: 'Found a profile',
          items: [
            { id: 'import', label: 'Restore it', detail: found.split(/[/\\]/).pop() ?? '' },
            { id: 'ignore', label: 'Start fresh' },
          ],
          async onChoose(id) {
            if (id !== 'import') return
            try {
              const summary = await importProfile(found)
              toast(
                `Restored ${summary.games} game settings and ${summary.manual} hand-added games.`,
                'info',
                7000,
              )
              await reloadLibrary()
            } catch (e) {
              toast(`Could not restore that. ${String(e)}`, 'error', 8000)
            }
          },
        })
      })
      .catch(() => { /* no profile is the normal case, not an error */ })
  }

  // If artwork is missing and the source that would fix it is switched off,
  // say so. Silence here is what made a missing key look like a broken app:
  // the second source had never been consulted, and nothing on screen said so.
  if (!steamGridDbKey && games.length) {
    void artworkReport(games.map((g) => g.providerId).filter((id) => /^\d+$/.test(id)))
      .then((report) => {
        const gaps = report.filter((r) => r.cover === 'none' || r.logo === 'none').length
        if (!gaps) return
        logInfo('art', `${gaps} game(s) missing artwork and no SteamGridDB key set`)
        toast(
          `${gaps} game${gaps === 1 ? ' is' : 's are'} missing artwork Steam does not have. ` +
            'A free SteamGridDB key fills them in — Settings, on Select.',
          'info',
          10_000,
        )
      })
      .catch(() => { /* a report we cannot read is not worth a message */ })
  }

  // Asserts the invariants error handling cannot see -- artwork actually
  // painted on top, the focus ring not clipped, the shell laid out, the hero
  // populated. Every silent bug found so far would have failed one of these.
  if (import.meta.env.DEV || params.get('check') === '1') scheduleSelfCheck()

  /**
   * Offer an update, once, on a quiet screen.
   *
   * "Idle" means the library is showing with nothing over it. The check fires
   * twenty seconds in, and by then the user may well have opened a menu or
   * started a game -- so it is asked at the moment the answer arrives, not
   * when the timer was set. If the screen is busy the offer is dropped for
   * this session rather than retried: a launcher that keeps trying to
   * interrupt you is worse than one that waits until tomorrow.
   */
  scheduleUpdateCheck(
    () => !menu.isOpen && !settings.isOpen && !detail.isOpen && !picker.isOpen && !osk.isOpen,
    (update) => {
      menu.open({
        title: `Marquee ${update.version} is available`,
        items: updateMenuItems(update),
        async onChoose(id) {
          if (id !== 'install') {
            await declineUpdate(update.version)
            toast('Left as it is. It will be offered again next release.')
            return
          }
          toast('Downloading…', 'info', 30_000)
          try {
            await update.install((percent) => {
              if (percent !== undefined) toast(`Downloading… ${percent}%`, 'info', 30_000)
            })
          } catch (e) {
            // The signature check failing lands here too, which is the whole
            // point of it -- a bad bundle is an error, not an install.
            toast(`Update failed. ${String(e)}`, 'error', 8000)
            logWarn('update', 'install failed', e)
          }
        },
      })
    },
  )

  logInfo('boot', `ready in ${(performance.now() - started).toFixed(0)} ms · ${games.length} games · shell=${inApp ? 'tauri' : 'browser'}`)
}

// Installed before anything else runs, so a failure inside main() still
// reaches the log and the screen. Without it, an unhandled rejection leaves a
// window that renders nothing with no error anywhere.
installErrorHandlers()
main().catch(async (e) => renderFatal(e, await logPath()))
