/** A typed client over the Rust scan. Store formats stay on the Rust side
 *  (docs/PLAN.md §5). */
import { listen } from '@tauri-apps/api/event'
import { call, inApp } from './host'
import { logWarn } from './log'

export interface Game {
  id: string
  provider: string
  providerId: string
  /** Empty, not a placeholder, until the metadata worker fills it in. */
  title: string
  installed: boolean
  /** Steam has an update queued. Always false for a manual game. */
  updateAvailable: boolean
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
  /** False means the store is not installed, which is not an error. */
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
 * Ask for metadata, in priority order. Returns what is cached now; the rest
 * arrives through `onMeta`, slowly, as Steam rate-limits its store endpoint.
 */
export async function requestMeta(appIds: string[]): Promise<Meta[]> {
  if (!inApp) return []
  return call<Meta[]>('request_meta', { appIds })
}

export interface SearchHit {
  appId: string
  name: string
  /** A Steam hit brings metadata; a SteamGridDB one only artwork. */
  source: 'steam' | 'sgdb'
  /** The source's own thumbnail. The last resort; see `coverFor`. */
  thumbnail: string
}

/** The source-qualified artwork key for a search result. */
export function artKeyFor(hit: SearchHit): string {
  return `${hit.source}-${hit.appId}`
}

/** The value `set_art_source` wants. A SteamGridDB id keeps its prefix, or it
 *  is read as some other game's Steam appid. */
export function artSourceFor(hit: SearchHit): string {
  return hit.source === 'sgdb' ? `sgdb:${hit.appId}` : hit.appId
}

/** Built like a card's cover, so it gets placeholder detection rather than
 *  Steam's grey box. */
export function coverFor(hit: SearchHit): string | undefined {
  return steamArtwork(artKeyFor(hit)).cover
}

/** Search both catalogues for artwork to borrow, SteamGridDB first as it has
 *  what Steam lacks. */
export async function searchArtwork(term: string): Promise<SearchHit[]> {
  if (!inApp) return []
  return call<SearchHit[]>('search_artwork', { term })
}

/** Find a game by name in Steam's store, which needs no key and lists most PC
 *  games wherever they were bought. */
export async function searchGames(term: string): Promise<SearchHit[]> {
  // `pnpm dev` has no backend, so search the sample titles instead.
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
  sort: string
  /** Folder an up-to-date copy of the profile is kept in, if any. */
  profileFolder: string
  minimiseOnLaunch: boolean
  /** 'grain' or 'blur'; see resolveBackgroundStyle in src/perf.ts. */
  backgroundStyle: string
  /** The version an update prompt was last refused for. */
  updateDeclined: string
  /** Read live from the Windows registry, not stored. */
  startOnLogin: boolean
}

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

/** Windows only; see src-tauri/src/autostart.rs. */
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

/** Export everything the user authored. Artwork and metadata are a cache and
 *  are left out. */
export async function exportProfile(path: string): Promise<void> {
  return call<void>('export_profile', { path })
}

/** Merge a profile in. Nothing is deleted; imported values win on a conflict. */
export async function importProfile(path: string): Promise<ImportSummary> {
  return call<ImportSummary>('import_profile', { path })
}

/** A profile on this machine: the configured folder, then game folders. */
export async function findProfile(): Promise<string | null> {
  if (!inApp) return null
  return call<string | null>('find_profile')
}

/** Keep an up-to-date copy in this folder, rewritten on every change. */
export async function setProfileFolder(folder: string): Promise<void> {
  return call<void>('set_profile_folder', { folder })
}

/** Machine details as text for pasting into an issue. Never sent anywhere. */
export async function diagnosticReport(): Promise<string> {
  if (!inApp) return 'Not running in the app.'
  return call<string>('diagnostic_report')
}

/** Quit, minimise, restart or shut down. */
export async function systemAction(action: string): Promise<void> {
  if (!inApp) throw new Error('that needs the app, not a browser tab')
  return call<void>('system_action', { action })
}

/** Hide or unhide a game. Survives rescans. */
export async function setHidden(gameId: string, hidden: boolean): Promise<void> {
  return call<void>('set_hidden', { gameId, hidden })
}

/** Steam uninstalls its own games; a hand-added one just loses its path. */
export async function uninstallGame(id: string): Promise<string> {
  return call<string>('uninstall_game', { id })
}

/** Ask Steam to download a pending update; Marquee never fetches game files
 *  itself (docs/PLAN.md §1). */
export async function updateGame(id: string): Promise<string> {
  return call<string>('update_game', { id })
}

/** Open a game's store page in the Steam client. */
export async function viewInStore(id: string): Promise<string> {
  return call<string>('view_in_store', { id })
}

/** Toggle fullscreen, returning the new state. Remembered across launches. */
export async function toggleFullscreen(): Promise<boolean> {
  if (!inApp) {
    if (document.fullscreenElement) { await document.exitFullscreen(); return false }
    await document.documentElement.requestFullscreen()
    return true
  }
  return call<boolean>('toggle_fullscreen')
}

/** Also clears the artwork cache, so missing art is retried with the key. */
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

/** Point a game's artwork at another source, or null to undo. */
export async function setArtSource(gameId: string, appId: string | null): Promise<void> {
  return call<void>('set_art_source', { gameId, appId })
}

/** Rename a game, persistently. `null` restores the provider's title. */
export async function setCustomTitle(gameId: string, title: string | null): Promise<void> {
  return call<void>('set_custom_title', { gameId, title })
}

/** Suggest a game's executable from learned folders, then common install
 *  locations. The user confirms it. */
export async function findExecutable(title: string): Promise<string | null> {
  if (!inApp) return null
  return call<string | null>('find_executable', { title })
}

/** Returns the new value. */
export async function toggleFavourite(gameId: string): Promise<boolean> {
  return call<boolean>('toggle_favourite', { gameId })
}

/**
 * Start a game by id; Rust resolves it from its own library. Resolves to how
 * it was launched, or rejects with a readable reason.
 */
export async function launchGame(id: string): Promise<string> {
  if (!inApp) throw new Error('launching needs the app, not a browser tab')
  return call<string>('launch_game', { id })
}

/** A game that spawned and then died, which a successful spawn cannot reveal. */
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

/** In the app, artwork is served from the local cache via `art://` (see
 *  src-tauri/src/art.rs); a browser tab falls back to Steam's CDN. */
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
    // The CDN still works, but silently it would just look like slow art.
    logWarn('art', 'no local art protocol; falling back to the CDN', e)
    artBase = ''
  }
}

/** The artwork key, `steam-1091500` or `sgdb-8452`: a SteamGridDB entry may
 *  have no Steam appid. */
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
  // Only Steam keys have a CDN URL we can build.
  const appid = key.startsWith('steam-') ? key.slice(6) : ''
  if (!appid) return {}
  return {
    cover: `${CDN}/${appid}/library_600x900.jpg`,
    hero: `${CDN}/${appid}/library_hero.jpg`,
    logo: `${CDN}/${appid}/logo.png`,
  }
}

/** A stable tint per title, so a card without artwork does not look broken. */
export function tintFor(title: string): string {
  let h = 0
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) | 0
  return `hsl(${Math.abs(h) % 360} 22% 14%)`
}
