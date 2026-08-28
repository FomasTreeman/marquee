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
