/**
 * The library, as the interface sees it.
 *
 * A typed client over the Rust scan. Nothing here knows what a `.acf` file is;
 * that is the whole point of the provider boundary in docs/PLAN.md §5.
 */
import { listen } from '@tauri-apps/api/event'
import { call, inApp } from './host'

export interface Game {
  id: string
  provider: string
  providerId: string
  /** Empty until the metadata worker fills it in. Deliberately empty rather
   *  than a placeholder like "App 220", so the interface can show that a name
   *  is still arriving instead of showing something wrong. */
  title: string
  installed: boolean
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
export interface SearchHit {
  appId: string
  name: string
  /** Steam's own thumbnail. A last resort — see `coverFor`. */
  thumbnail: string
}

/** A search result's cover, built the same way a card's is, so it goes through
 *  placeholder detection and the fallback chain rather than pointing at a raw
 *  CDN path that is a grey box for a lot of recent games. */
export function coverFor(hit: SearchHit): string | undefined {
  return steamArtwork(`steam-${hit.appId}`).cover
}

/** A SteamGridDB entry, as offered by the artwork picker. */
export interface ArtworkEntry {
  id: string
  name: string
  cover: string
}

/**
 * Search SteamGridDB by name.
 *
 * Distinct from `searchGames`, which searches the Steam store. That answers
 * "which game is this"; this answers "whose artwork should this use", and they
 * are different questions — searching Steam could only ever re-point a game at
 * another Steam appid, which is no help when the missing artwork is Steam's.
 *
 * Rejects with a readable reason when no key is configured.
 */
export async function searchArtwork(term: string): Promise<ArtworkEntry[]> {
  if (!inApp) return []
  return call<ArtworkEntry[]>('search_artwork', { term })
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

/**
 * Point a game's artwork at a different Steam appid, or null to undo.
 *
 * The appid a game *is* is not always the appid whose artwork it should
 * borrow, and no amount of renaming fixes that.
 */
export interface Settings {
  steamgriddbKey: string
}

export async function getSettings(): Promise<Settings> {
  if (!inApp) return { steamgriddbKey: '' }
  return call<Settings>('get_settings')
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

export async function setArtSource(gameId: string, appId: string | null): Promise<void> {
  return call<void>('set_art_source', { gameId, appId })
}

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

export async function launchGame(id: string): Promise<string> {
  if (!inApp) throw new Error('launching needs the app, not a browser tab')
  return call<string>('launch_game', { id })
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
  } catch {
    // A missing protocol handler is survivable: the CDN still works, it just
    // costs the network every launch.
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
