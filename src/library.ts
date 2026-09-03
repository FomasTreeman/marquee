/**
 * The library, as the interface sees it.
 *
 * A typed client over the Rust scan. Nothing here knows what a `.acf` file is;
 * that is the whole point of the provider boundary in docs/PLAN.md §5.
 */
import { listen } from '@tauri-apps/api/event'
import { call, inApp } from './host'
import { logWarn } from './log'

export interface Game {
  id: string
  provider: string
  providerId: string
  /** Empty until the metadata worker fills it in. Deliberately empty rather
   *  than a placeholder like "App 220", so the interface can show that a name
   *  is still arriving instead of showing something wrong. */
  title: string
  installed: boolean
  /** Steam has a newer version of this game queued. Always false for a
   *  manual game -- nothing here tracks its own version. */
  updateAvailable: boolean
  /** Steam is downloading or applying that update right now. */
  updating: boolean
  installDir: string | null
  sizeBytes: number
  lastPlayed: number | null
  playtimeMinutes: number
  favourite: boolean
  hidden: boolean
  /** Where artwork comes from, when not from providerId. User-set. */
  artAppId: string | null
}

export interface Meta {
  appId: string
  name: string
  description: string
  developers: string[]
  publishers: string[]
  releaseDate: string
  genres: string[]
  score: number | null
}

export interface ProviderResult {
  provider: string
  /** False means the store simply is not installed here, which is not an
   *  error and must not be shown as one. */
  detected: boolean
  error: string | null
  tookMs: number
}

export interface ScanResult {
  games: Game[]
  providers: ProviderResult[]
  tookMs: number
}

/**
 * Ask for metadata, in priority order.
 *
 * Returns whatever is already cached, immediately. The rest arrives through
 * `onMeta` as the background worker fetches it -- Steam's store endpoint
 * allows roughly 200 requests per five minutes, so a library of two hundred
 * games takes a few minutes on first run and is instant forever after.
 */
export async function requestMeta(appIds: string[]): Promise<Meta[]> {
  if (!inApp) return []
  return call<Meta[]>('request_meta', { appIds })
}

export interface SearchHit {
  appId: string
  name: string
  /** Which catalogue this came from. A Steam hit carries an appid that unlocks
   *  metadata; a SteamGridDB one carries artwork and nothing else. */
  source: 'steam' | 'sgdb'
  /** The source's own thumbnail. A last resort — see `coverFor`. */
  thumbnail: string
}

/** The source-qualified artwork key for a search result. */
export function artKeyFor(hit: SearchHit): string {
  return `${hit.source}-${hit.appId}`
}

/**
 * The value `set_art_source` wants for this hit.
 *
 * A SteamGridDB id has to keep its prefix or it is read as a Steam appid --
 * which is a different game that probably exists, so the mistake shows up as
 * the wrong artwork rather than as an error.
 */
export function artSourceFor(hit: SearchHit): string {
  return hit.source === 'sgdb' ? `sgdb:${hit.appId}` : hit.appId
}

/** A search result's cover, built the same way a card's is, so it goes through
 *  placeholder detection and the fallback chain rather than pointing at a raw
 *  CDN path that is a grey box for a lot of recent games. */
export function coverFor(hit: SearchHit): string | undefined {
  return steamArtwork(artKeyFor(hit)).cover
}

/**
 * Search for artwork to borrow, from both catalogues.
 *
 * Answers "whose artwork should this use", where `searchGames` answers "which
 * game is this". SteamGridDB leads, because it has what Steam is missing;
 * Steam follows, because a game listed there under a name you would not guess
 * is a real answer too.
 */
export async function searchArtwork(term: string): Promise<SearchHit[]> {
  if (!inApp) return []
  return call<SearchHit[]>('search_artwork', { term })
}

/**
 * Find a game by name.
 *
 * Steam's store search, which needs no key. That it is Steam's index does not
 * make this a Steam feature -- a Steam *store page* exists for most PC games
 * whoever sold them, so a GOG or Epic copy is identified here and then borrows
 * Steam's artwork by appid.
 */
export async function searchGames(term: string): Promise<SearchHit[]> {
  // `pnpm dev` has no backend. Rather than an overlay that can never show a
  // result, fall back to the sample titles so the flow is inspectable during
  // pure CSS work. Never reached in the app.
  if (!inApp) {
    const { searchSample } = await import('./sample')
    return searchSample(term)
  }
  return call<SearchHit[]>('search_games', { term })
}

/** Record a game the user picked from search. Returns its manual id. */
export async function addManualGame(title: string, steamAppId?: string): Promise<number> {
  return call<number>('add_manual_game', { title, steamAppId: steamAppId ?? null })
}

export async function setManualExecutable(id: number, executable: string | null): Promise<void> {
  return call<void>('set_manual_executable', { id, executable })
}

export async function removeManualGame(id: number): Promise<void> {
  return call<void>('remove_manual_game', { id })
}

export interface Settings {
  steamgriddbKey: string
  /** Sort order, remembered across launches. */
  sort: string
  /** Folder an up-to-date copy of the profile is kept in, if any. */
  profileFolder: string
  /** Whether to get out of a launching game's way. */
  minimiseOnLaunch: boolean
  /** 'grain' or 'blur'. See resolveBackgroundStyle in src/perf.ts, which is
   *  also what turns a blank or unrecognised value into 'grain'. */
  backgroundStyle: string
  /** The version an update prompt was last refused for. See src/update.ts. */
  updateDeclined: string
  /** Whether Marquee is registered in Windows' own startup list. Read live
   *  from the registry, not a stored preference -- see src-tauri/src/autostart.rs. */
  startOnLogin: boolean
}

/** Store any single setting. */
export async function setSetting(key: string, value: string): Promise<void> {
  if (!inApp) return
  return call<void>('set_setting', { key, value })
}

export async function getSettings(): Promise<Settings> {
  if (!inApp) {
    return {
      steamgriddbKey: '', sort: 'recent', profileFolder: '',
      minimiseOnLaunch: true, backgroundStyle: 'grain', updateDeclined: '',
      startOnLogin: false,
    }
  }
  return call<Settings>('get_settings')
}

/** Windows only -- see src-tauri/src/autostart.rs for why. */
export async function setAutostart(enabled: boolean): Promise<void> {
  if (!inApp) return
  return call<void>('set_autostart', { enabled })
}

export interface ImportSummary {
  settings: number
  games: number
  manual: number
  roots: number
}

/**
 * Everything the user authored, as a file.
 *
 * Favourites, hidden games, hand-added games and where they live, artwork
 * corrections, learned folders, settings. Kilobytes. Artwork and metadata are
 * deliberately excluded — they are a cache and rebuild themselves.
 */
export async function exportProfile(path: string): Promise<void> {
  return call<void>('export_profile', { path })
}

/** Merge a profile in. Nothing is deleted; imported values win on a conflict. */
export async function importProfile(path: string): Promise<ImportSummary> {
  return call<ImportSummary>('import_profile', { path })
}

/** A profile already on this machine, if there is one — the configured folder,
 *  then the folders games are known to live in. */
export async function findProfile(): Promise<string | null> {
  if (!inApp) return null
  return call<string | null>('find_profile')
}

/** Keep an up-to-date copy in this folder, rewritten on every change. */
export async function setProfileFolder(folder: string): Promise<void> {
  return call<void>('set_profile_folder', { folder })
}

/**
 * Everything worth knowing about this machine, as one block of text.
 *
 * For pasting into an issue. Nothing here leaves the machine on its own.
 */
export async function diagnosticReport(): Promise<string> {
  if (!inApp) return 'Not running in the app.'
  return call<string>('diagnostic_report')
}

/** Quit, minimise, restart or shut down. The last two end the whole session,
 *  so the interface arms them with a second press first. */
export async function systemAction(action: string): Promise<void> {
  if (!inApp) throw new Error('that needs the app, not a browser tab')
  return call<void>('system_action', { action })
}

/** Hide a game from the library, or bring it back. Survives every rescan. */
export async function setHidden(gameId: string, hidden: boolean): Promise<void> {
  return call<void>('set_hidden', { gameId, hidden })
}

/** Hand a Steam game to Steam to uninstall; for a hand-added one, forget where
 *  it lives. Returns a description of what happened. */
export async function uninstallGame(id: string): Promise<string> {
  return call<string>('uninstall_game', { id })
}

/** Ask Steam to download a pending update. Marquee never fetches anything
 *  itself, docs/PLAN.md §1 -- this only hands the appid to the client that
 *  already owns the files. Returns the URI it was handed. */
export async function updateGame(id: string): Promise<string> {
  return call<string>('update_game', { id })
}

/** Open a Steam game's store page inside the Steam client. Returns the URI it
 *  was handed. */
export async function viewInStore(id: string): Promise<string> {
  return call<string>('view_in_store', { id })
}

/** Toggle fullscreen, returning the new state. Remembered across launches. */
export async function toggleFullscreen(): Promise<boolean> {
  if (!inApp) {
    // A browser tab has its own fullscreen and no window to remember.
    if (document.fullscreenElement) { await document.exitFullscreen(); return false }
    await document.documentElement.requestFullscreen()
    return true
  }
  return call<boolean>('toggle_fullscreen')
}

/** Saving also clears the artwork cache, so games that previously found
 *  nothing are re-resolved against the new source. */
export async function setSteamGridDbKey(key: string): Promise<void> {
  return call<void>('set_steamgriddb_key', { key })
}

/** Where each of a game's assets came from, as the pipeline recorded it. */
export interface ArtworkManifest {
  appId: string
  cover: 'steam' | 'steamgriddb' | 'composed' | 'none'
  hero: 'steam' | 'steamgriddb' | 'composed' | 'none'
  logo: 'steam' | 'steamgriddb' | 'composed' | 'none'
  steamComplete: boolean
}

export async function artworkReport(appIds: string[]): Promise<ArtworkManifest[]> {
  if (!inApp) return []
  return call<ArtworkManifest[]>('artwork_report', { appIds })
}

/**
 * Point a game's artwork at a different Steam appid, or null to undo.
 *
 * The appid a game *is* is not always the appid whose artwork it should
 * borrow, and no amount of renaming fixes that.
 */
export async function setArtSource(gameId: string, appId: string | null): Promise<void> {
  return call<void>('set_art_source', { gameId, appId })
}

/** Rename a game, persistently. `null` restores the provider's title. */
export async function setCustomTitle(gameId: string, title: string | null): Promise<void> {
  return call<void>('set_custom_title', { gameId, title })
}

/**
 * Look for a game's executable.
 *
 * Searches the folders previous choices have taught it about first, then a
 * short list of conventional install locations. A suggestion, not a decision:
 * the user confirms whatever comes back, because launching the wrong program
 * is worse than asking.
 */
export async function findExecutable(title: string): Promise<string | null> {
  if (!inApp) return null
  return call<string | null>('find_executable', { title })
}

/** Toggle, returning the new value. User data, and no scanner can clear it. */
export async function toggleFavourite(gameId: string): Promise<boolean> {
  return call<boolean>('toggle_favourite', { gameId })
}

/**
 * Start a game.
 *
 * Resolves to a description of what happened -- the steam:// URI or the
 * executable path -- so the interface can say "handing off to Steam" rather
 * than showing a generic spinner. Rejects with a human-readable reason.
 *
 * The game is resolved from the library Rust already holds. The interface is
 * never the authority on what a game is.
 */
export async function launchGame(id: string): Promise<string> {
  if (!inApp) throw new Error('launching needs the app, not a browser tab')
  return call<string>('launch_game', { id })
}

/**
 * A game that spawned and then died.
 *
 * Reported after the fact because `spawn` succeeding says nothing about
 * whether the program ran — a missing runtime or a wrong working directory
 * looks identical to a successful launch until the process is gone.
 */
export async function onLaunchFailed(
  cb: (info: { title: string; detail: string }) => void,
): Promise<() => void> {
  if (!inApp) return () => {}
  return listen<{ title: string; detail: string }>('launch-failed', (e) => cb(e.payload))
}

export async function onMeta(cb: (meta: Meta) => void): Promise<() => void> {
  if (!inApp) return () => {}
  return listen<Meta>('meta', (e) => cb(e.payload))
}

export async function scanLibrary(): Promise<ScanResult> {
  if (!inApp) return { games: [], providers: [], tookMs: 0 }
  return call<ScanResult>('scan_library')
}

/**
 * Artwork.
 *
 * In the app these are `art://` URLs served from our own cache: fetched once,
 * resized on ingest, and thereafter available with no network at all. See
 * src-tauri/src/art.rs.
 *
 * In a browser tab there is no protocol handler, so they fall back to Steam's
 * CDN directly. Same three assets either way — cover, wide key art, and the
 * transparent wordmark the whole design is built around.
 */
const CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps'

export interface Artwork {
  cover?: string
  hero?: string
  logo?: string
}

/** Set once at startup; empty means "no backend, go straight to the CDN". */
let artBase = ''

export async function initArtwork(): Promise<void> {
  if (!inApp) return
  try {
    artBase = await call<string>('art_url_base')
  } catch (e) {
    // Survivable: the CDN still works, it just costs the network every launch
    // instead of reading the cache. Silent, though, it looks like slow art.
    logWarn('art', 'no local art protocol; falling back to the CDN', e)
    artBase = ''
  }
}

/**
 * The source-qualified key a game's artwork is looked up under.
 *
 * `steam-1091500` or `sgdb-8452`. Qualified because a game can borrow artwork
 * from a SteamGridDB entry that has no Steam appid at all — which is the whole
 * point when the missing artwork is Steam's.
 */
export function artIdFor(game: Pick<Game, 'providerId' | 'artAppId'>): string | undefined {
  const override = game.artAppId
  if (override?.startsWith('sgdb:')) {
    const id = override.slice(5)
    return /^\d+$/.test(id) ? `sgdb-${id}` : undefined
  }
  const id = override ?? game.providerId
  return /^\d+$/.test(id) ? `steam-${id}` : undefined
}

export function steamArtwork(key: string): Artwork {
  if (artBase) {
    return {
      cover: `${artBase}${key}/cover`,
      hero: `${artBase}${key}/hero`,
      logo: `${artBase}${key}/logo`,
    }
  }
  // No protocol handler in a plain browser tab, so straight to the CDN. Only
  // Steam keys can be served that way; a SteamGridDB one has no public URL we
  // can construct.
  const appid = key.startsWith('steam-') ? key.slice(6) : ''
  if (!appid) return {}
  return {
    cover: `${CDN}/${appid}/library_600x900.jpg`,
    hero: `${CDN}/${appid}/library_hero.jpg`,
    logo: `${CDN}/${appid}/logo.png`,
  }
}

/** Deterministic tint from the title, so a game with no artwork still looks
 *  designed rather than broken. */
export function tintFor(title: string): string {
  let h = 0
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) | 0
  return `hsl(${Math.abs(h) % 360} 22% 14%)`
}
