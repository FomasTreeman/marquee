/** Wires the shell, the library and the input stream together. */
import { createGrid } from './grid'
import { createFrameMeter, installGrainTile, applyBackgroundStyle } from './perf'
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
import { createInput, padStatus, wantsOsk, type Action, type Device } from './input'
import {
  scanLibrary, requestMeta, onMeta, onLaunchFailed, launchGame, toggleFavourite,
  getSettings, setSetting, toggleFullscreen, systemAction, findProfile, importProfile,
  addManualGame, setManualExecutable, setArtSource, artworkReport, artSourceFor,
  initArtwork, steamArtwork, artIdFor, tintFor,
  type Artwork, type Game, type Meta, type ScanResult,
} from './library'
import { installErrorHandlers, logInfo, logWarn, logError, renderFatal, logPath } from './log'
import { runSelfCheck, scheduleSelfCheck } from './selfcheck'
import { declineUpdate, scheduleUpdateCheck, updateMenuItems } from './update'
import { serialised } from './serial'
import {
  apply as applyFilter, describe as describeFilter, searchLabel,
  PRESETS, SORTS, type Preset, type Sort,
} from './filter'

const params = new URLSearchParams(location.search)
/** ?mock=40 forces a synthetic library of that size, for design and grid
 *  profiling. */
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
  // On the hero, not just the detail screen, so a large update is visible
  // before Play is pressed.
  const update = game.updating ? 'Updating…' : game.updateAvailable ? 'Update available' : ''
  return [
    game.favourite ? '★ Favourite' : '',
    store,
    state,
    update,
    hoursLabel(game.playtimeMinutes),
    playedLabel(game.lastPlayed),
  ].filter(Boolean)
}

/** Explains an empty library, which would otherwise look like a blank screen. */
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

  // Before any artwork URL is built: the form differs between app and browser.
  await initArtwork()

  const shell = createShell(document.getElementById('app')!)
  const backdrop = createBackdrop(shell.backdropA, shell.backdropB)

  // Rebuilt wholesale by reloadLibrary(), so an added game takes the same path
  // as every other.
  let games: Game[] = []
  let art: Artwork[] = []
  let scan: ScanResult = { games: [], providers: [], tookMs: 0 }
  const meta = new Map<string, Meta>()

  // Indices into `games` in grid order, so updates have one place to write.
  let view: number[] = []
  let preset: Preset = 'all'
  let query = ''
  let sort: Sort = 'recent'

  const gameAt = (viewIndex: number): Game | undefined => games[view[viewIndex] ?? -1]
  const artAt = (viewIndex: number): Artwork => art[view[viewIndex] ?? -1] ?? {}

  /** Cleared on each selection, so holding a direction cannot leave the hero
   *  stuck mid-fade. */
  let heroSettle: number | undefined

  function refreshHero(viewIndex: number): void {
    const game = gameAt(viewIndex)
    if (!game) return

    // Removed shortly rather than after the transition, so fast navigation
    // does not queue a fade per keypress.
    shell.hero.classList.add('is-changing')
    window.clearTimeout(heroSettle)
    heroSettle = window.setTimeout(() => shell.hero.classList.remove('is-changing'), 60)
    const a = artAt(viewIndex)
    backdrop.show(a.hero)

    // Wordmark or typed title, never both.
    const logo = a.logo
    shell.heroLogo.hidden = !logo
    shell.heroTitle.hidden = !!logo
    if (logo && shell.heroLogo.getAttribute('src') !== logo) {
      shell.heroLogo.src = logo
      shell.heroLogo.onerror = () => {
        // Logged, as the fallback looks identical to a game with no wordmark.
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

  /** Shared by every device; a per-device copy once left the mouse without one. */
  function openDetails(index: number): void {
    const game = gameAt(index)
    if (!game) return
    detail.open(game, meta.get(game.providerId), artAt(index))
    // Fetched on open, not cached: the manifest is written when artwork
    // resolves, which may be after the card was drawn.
    void artworkReport([game.providerId])
      .then((r) => {
        if (r[0] && detail.isOpen) detail.open(game, meta.get(game.providerId), artAt(index), r[0])
      })
      .catch(() => { /* a missing report is a fact that says "not yet" */ })
    checkNow('detail')
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
    // With nothing to play, A adds a game, so a pad is not stuck here.
    const prompt = document.createElement('span')
    prompt.className = 'empty-prompt'
    prompt.textContent = 'Press A to add a game by name'
    box.append(b, span, prompt)
    shell.gridViewport.appendChild(box)
  }

  /** Move to the next or previous tab, wrapping round at either end. */
  function choosePreset(step: number): void {
    const at = PRESETS.findIndex((p) => p.id === preset)
    const next = PRESETS[(at + step + PRESETS.length) % PRESETS.length]
    if (!next) return
    selectPreset(next.id)
  }

  function selectPreset(id: Preset): void {
    preset = id
    // A search belongs to its tab, so changing tab clears it.
    query = ''
    shell.query.hidden = true
    shell.query.value = ''
    grid.focus(0)
    applyView()
  }

  function paintPresets(): void {
    // Icon only, as the query already shows in the field and the count; the
    // label is for screen readers.
    shell.searchButton.setAttribute('aria-label', searchLabel(query))
    shell.searchButton.dataset['active'] = query.trim() ? '1' : '0'

    shell.presets.textContent = ''
    for (const p of PRESETS) {
      const pill = document.createElement('span')
      pill.className = 'preset'
      pill.dataset['active'] = p.id === preset ? '1' : '0'
      // Dimmed rather than hidden, so the other pills do not shift.
      pill.dataset['empty'] = applyFilter(games, p.id, '').length ? '0' : '1'
      pill.textContent = p.label
      pill.onclick = () => selectPreset(p.id)
      shell.presets.appendChild(pill)
    }
  }

  /** Rebuild the grid from preset and query, keeping the cursor's game if it
   *  survives the filter. */
  function applyView(): void {
    const keepId = gameAt(grid.focused)?.id
    // Metadata feeds the search, so genres and developers match too.
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
  const reloadLibrary = serialised(async (): Promise<void> => {
    try {
      scan = MOCK ? { games: [], providers: [], tookMs: 0 } : await scanLibrary()
      for (const p of scan.providers) if (p.error) logWarn('scan', `${p.provider}: ${p.error}`)
    } catch (e) {
      logError('scan', 'library scan failed', e)
      scan = { games: [], providers: [{ provider: 'scan', detected: true, error: String(e), tookMs: 0 }], tookMs: 0 }
    }

    // Imported on demand to keep the mock library out of the shipped bundle.
    if (MOCK) {
      const { SAMPLE_LIBRARY } = await import('./sample')
      games = SAMPLE_LIBRARY(MOCK)
    } else {
      games = scan.games
    }
    // Follows the user's artwork override, if any.
    art = games.map((g) => { const key = artIdFor(g); return key ? steamArtwork(key) : {} })
    games.forEach((g) => { const m = meta.get(g.providerId); if (m && !g.title) g.title = m.name })

    applyView()
    if (!games.length) return

    // Artwork is keyed by appid, so it shows before names arrive. Requested in
    // library order so on-screen games are named first.
    const appIds = games.filter((g) => g.providerId.match(/^\d+$/)).map((g) => g.providerId)
    const ready = await requestMeta(appIds)
    for (const m of ready) applyMeta(m)
    logInfo('meta', `${ready.length}/${appIds.length} names already cached`)
  })

  function applyMeta(m: Meta): void {
    meta.set(m.appId, m)
    if (!m.name) return
    games.forEach((g, gameIndex) => {
      if (g.providerId !== m.appId || g.title === m.name) return
      g.title = m.name
      const viewIndex = view.indexOf(gameIndex)
      if (viewIndex < 0) return
      grid.setTitle(viewIndex, m.name)
      if (viewIndex === grid.focused) refreshHero(viewIndex)
    })
    resortLater()
  }

  const unlistenMeta = await onMeta(applyMeta)
  // The only way a failure after spawning reaches the user.
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

  // Guards against a double-tapped A asking Steam to start a game twice.
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
      // A closed Steam is started first, which takes a few seconds.
      const cold = how.includes('starting Steam')
      toast(
        cold ? `Starting Steam, then ${label}. This takes a few seconds.` : `Starting ${label}`,
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
      // An unfavourited game must leave the Favourites view.
      if (preset === 'favourites') applyView()
      else { paintPresets(); refreshHero(index) }
      toast(game.favourite ? `Favourited ${game.title}` : `Removed ${game.title} from favourites`)
    } catch (e) {
      toast(`Could not save that. ${String(e)}`, 'error')
    }
  }

  const osk = createOsk()

  /** The device in hand, updated live by the same signal as the legend. */
  let heldDevice: Device = 'keyboard'

  const menu = createMenu()

  /** The legend table lives in shell.ts as data, so its coverage is tested. */
  function refreshHints(device: Device): void {
    heldDevice = device
    setHints(
      shell.hints,
      legendFor(device, {
        play: () => void play_(grid.focused),
        details: () => openDetails(grid.focused),
        favourite: () => void favourite(grid.focused),
        sort: openSort,
        search: openSearch,
        menu: openMainMenu,
        add: openAdd,
      }),
    )
  }

  /** Sort has its own menu; presets need none, as the tabs are always visible. */
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

  function openMainMenu(): void {
    menu.open({
      title: 'Marquee',
      items: mainMenuItems(games.length),
      async onChoose(id) {
        if (id === 'settings') {
          settings.open()
          if (wantsOsk(heldDevice)) osk.attach(settings.field)
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

  /** Debounced, or a name sort reshuffles the grid on every metadata event. */
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
    // Without the on-screen keyboard a pad cannot type here.
    if (wantsOsk(heldDevice)) osk.attach(shell.query)
  }

  shell.searchButton.onclick = openSearch

  shell.query.addEventListener('input', () => {
    query = shell.query.value
    grid.focus(0)
    applyView()
  })
  shell.query.addEventListener('blur', () => {
    osk.close()
    // A populated search stays visible; an empty one is clutter.
    if (!query.trim()) shell.query.hidden = true
  })
  shell.query.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { query = ''; shell.query.value = ''; shell.query.blur(); applyView() }
    if (e.key === 'Enter') shell.query.blur()
  })

  const picker = createPicker(() => osk.close())

  /** Re-run the self-check when an overlay opens, as boot only sees it closed. */
  const checkNow = (context: string) => {
    if (import.meta.env.DEV || params.get('check') === '1') scheduleSelfCheck(600, context)
  }

  function openAdd(): void {
    picker.open({
      heading: 'Add a game',
      sub: 'Type its name — or browse for it, and the name is worked out for you.',
      // Browsing gives the path; the search still identifies the game, since
      // artwork and metadata are keyed by game, not path.
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
          // A SteamGridDB id is not a Steam appid; passing it as one would
          // attach some other game's metadata. Its artwork is set separately.
          const steamAppId = hit.source === 'steam' ? hit.appId : undefined
          const id = await addManualGame(hit.name, steamAppId)
          if (hit.source === 'sgdb') await setArtSource(`manual:${id}`, artSourceFor(hit))
          if (file) await setManualExecutable(id, file)
          logInfo('add', `added ${hit.name} (${hit.source}:${hit.appId})${file ? ` at ${file}` : ''}`)
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
    if (wantsOsk(heldDevice)) osk.attach(picker.field)
    checkNow('add')
  }

  /** Re-match any game's artwork, as Steam's CDN can lack a cover. */
  function openArtwork(game: Game): void {
    if (!steamGridDbKey) {
      // Steam alone would just match the game to its own appid, changing nothing.
      toast(
        'Finding artwork needs a SteamGridDB key — it is the source that has ' +
          'the art Steam is missing. Add one in Settings (Select).',
        'error',
        9000,
      )
      settings.open()
      if (wantsOsk(heldDevice)) osk.attach(settings.field)
      return
    }
    picker.open({
      heading: 'Find artwork',
      source: 'artwork',
      sub: `Pick the entry to take artwork from — SteamGridDB first, then Steam. ${game.title || 'This game'} will use its cover, key art and wordmark.`,
      initial: game.title,
      async onPick(hit) {
        try {
          await setArtSource(game.id, artSourceFor(hit))
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
    if (wantsOsk(heldDevice)) osk.attach(picker.field)
    checkNow('artwork')
  }

  let steamGridDbKey = ''
  let savedSort = 'recent'
  async function refreshSettings(): Promise<void> {
    try {
      const s = await getSettings()
      steamGridDbKey = s.steamgriddbKey
      savedSort = s.sort || 'recent'
      applyBackgroundStyle(s.backgroundStyle)
    } catch (e) {
      // Logged, as a silent revert to defaults looks like forgetting.
      logWarn('settings', 'could not read settings; using defaults', e)
      steamGridDbKey = ''
      applyBackgroundStyle('grain')
    }
  }
  await refreshSettings()
  sort = SORTS.find((s) => s.id === savedSort)?.id ?? 'recent'

  const settings = createSettings(() => {
    void refreshSettings()
    // Rebuilds every <img> so cleared artwork is fetched again.
    void reloadLibrary()
  }, () => osk.close())

  const detail = createDetail({
    onPlay: () => void play_(grid.focused),
    onChanged: () => void reloadLibrary(),
    onFindArtwork: openArtwork,
    // A closure because heldDevice changes after this is wired up.
    onTextField: (field) => { if (wantsOsk(heldDevice)) osk.attach(field) },
    onTextFieldClosed: () => osk.close(),
  })

  // Steam records playtime itself, so a rescan on return picks it up.
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
  // A first guess; refreshHints() corrects it on real input.
  const pad = await padStatus()
  heldDevice = pad.connected > 0 ? 'pad' : 'keyboard'

  await createInput((e) => {
    hud.noteInput(e.latency)

    // Overlays swallow input, innermost first, so the selection behind them
    // does not move.
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
        if (!view.length) openAdd()
        else void play_(grid.focused)
        return
      }
      if (e.action === 'x') { void favourite(grid.focused); return }
      if (e.action === 'menu') { openMainMenu(); return }
      if (e.action === 'add') { openAdd(); return }
      if (e.action === 'search') { openSearch(); return }
      if (e.action === 'y') { openDetails(grid.focused); return }
      if (e.action === 'sort') { openSort(); return }
    }
    // Shoulders change tab, as on a console. They once scrolled the grid, which
    // duplicated the sticks; do not bring that back.
    if (e.action === 'lb' || e.action === 'rb') {
      choosePreset(e.action === 'rb' ? 1 : -1)
      return
    }

    const d = NAV[e.action]
    if (d) grid.move(d[0], d[1])
  }, refreshHints)

  // The legend must show before the first key is pressed. Assume a pad only
  // when one is connected.
  refreshHints(heldDevice)

  await hud.attach({
    host: await hostInfo(),
    ipc: await pingMs(),
    pad,
    scan,
    total: games.length,
  })

  // Development only: lets a console, a driven browser or the self-check open
  // overlays and read state without real input.
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
        openAdd,
        openArtwork,
        settings,
        play: play_,
        favourite,
        reloadLibrary,
        selfCheck: runSelfCheck,
      },
    })
  }

  // A reinstall can lose the database but leave a profile beside the games.
  // Offered, never imported without asking.
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

  // Say when missing artwork needs a SteamGridDB key, or it looks like a bug.
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

  // Checks what error handling cannot see: painted artwork, unclipped focus
  // ring, layout, hero. See docs/DEBUGGING.md.
  if (import.meta.env.DEV || params.get('check') === '1') scheduleSelfCheck()

  /**
   * Offer an update once, only if no overlay is open when the answer arrives.
   * A busy screen drops the offer for this session rather than retrying.
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
          const progress = toast('Downloading…', 'info', 30_000)
          try {
            await update.install((percent) => {
              if (percent !== undefined) progress.update(`Downloading… ${percent}%`)
            })
          } catch (e) {
            // Includes a failed signature check.
            toast(`Update failed. ${String(e)}`, 'error', 8000)
            logWarn('update', 'install failed', e)
          }
        },
      })
    },
  )

  logInfo('boot', `ready in ${(performance.now() - started).toFixed(0)} ms · ${games.length} games · shell=${inApp ? 'tauri' : 'browser'}`)
}

// First, so a failure in main() reaches the log and the screen.
installErrorHandlers()
main().catch(async (e) => renderFatal(e, await logPath()))
