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
  cover: string
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
 * Steam's public artwork CDN.
 *
 * No key, no auth — see docs/PLAN.md §6. `logo.png` is the transparent
 * wordmark the whole design is built around.
 *
 * These point straight at the CDN for now. The on-disk cache with ingest
 * resizing that §4 requires comes next; going direct first gets real art on
 * screen and proves the URLs, which is the part that could have been wrong.
 */
const CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps'

export interface Artwork {
  cover?: string
  hero?: string
  logo?: string
}

export function steamArtwork(appid: string): Artwork {
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
