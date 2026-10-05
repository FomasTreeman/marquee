/**
 * When to offer an update. The updater plugin fetches the manifest and checks
 * the signature; this module checks once per session, offers only on an idle
 * library screen, shows the notes, and remembers a refusal per version.
 * See docs/UPDATES.md for the release side.
 */
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { inApp } from './host'
import { logInfo, logWarn } from './log'
import { getSettings, setSetting } from './library'
import type { MenuItem } from './menu'

/** Remembers the last version the user said no to. */
const DECLINED = 'updateDeclined'

/** Wait for the library to settle so the check does not compete with artwork downloads. */
const CHECK_AFTER_MS = 20_000

export interface PendingUpdate {
  version: string
  notes: string
  /** Download, verify, install, restart. Resolves only if it fails. */
  install(onProgress?: (percent: number | undefined) => void): Promise<void>
}

/**
 * Ask whether there is a newer version. Returns undefined for "no" and for
 * any failure, which is logged but not shown, since the user did not ask.
 */
export async function checkForUpdate(): Promise<PendingUpdate | undefined> {
  if (!inApp) return undefined
  let update: Update | null = null
  try {
    update = await check()
  } catch (e) {
    logWarn('update', 'could not check for updates', e)
    return undefined
  }
  if (!update) {
    logInfo('update', 'up to date')
    return undefined
  }

  // A refused version stays refused.
  try {
    const declined = (await getSettings()).updateDeclined
    if (declined === update.version) {
      logInfo('update', `${update.version} is available; previously declined`)
      return undefined
    }
  } catch {
    // No stored preference is not a reason to skip the prompt.
  }

  logInfo('update', `${update.version} is available (running ${update.currentVersion})`)
  return {
    version: update.version,
    notes: (update.body ?? '').trim(),
    async install(onProgress) {
      const progress: Progress = { total: 0, got: 0 }
      await update!.downloadAndInstall((event) => {
        if (event.event === 'Started') progress.total = event.data.contentLength ?? 0
        else if (event.event === 'Progress') progress.got += event.data.chunkLength
        else if (event.event === 'Finished') progress.got = progress.total
        const percent = progressStep(progress)
        if (percent !== undefined || event.event === 'Started') onProgress?.(percent)
      })
      // Not reached on Windows, where the installer replaces the process.
      logInfo('update', `installed ${update!.version}; restarting`)
      await relaunch()
    },
  }
}

export interface Progress {
  total: number
  got: number
  /** The last percentage reported, so the next one is only spoken if it moved. */
  reported?: number
}

/**
 * The percentage to report, or undefined if the size is unknown or the figure
 * has not changed. Reporting every chunk filled the screen with identical toasts.
 */
export function progressStep(p: Progress): number | undefined {
  if (!p.total) return undefined
  const percent = Math.min(100, Math.round((p.got / p.total) * 100))
  if (percent === p.reported) return undefined
  p.reported = percent
  return percent
}

/** Remember a refusal, so this version is not offered again. */
export async function declineUpdate(version: string): Promise<void> {
  try {
    await setSetting(DECLINED, version)
  } catch (e) {
    // Worst case, the prompt reappears next launch.
    logWarn('update', 'could not record the declined version', e)
  }
}

/** Schedule the session's one check. `isIdle` is asked when the offer is made, not when scheduled. */
export function scheduleUpdateCheck(
  isIdle: () => boolean,
  offer: (update: PendingUpdate) => void,
  delayMs = CHECK_AFTER_MS,
): () => void {
  const timer = window.setTimeout(() => {
    void checkForUpdate().then((update) => {
      if (!update) return
      if (!isIdle()) {
        // One attempt per session; no retry.
        logInfo('update', `${update.version} is available; not offering over a busy screen`)
        return
      }
      offer(update)
    })
  }, delayMs)
  return () => window.clearTimeout(timer)
}

/** The menu rows for the update prompt. Data, so the shape can be tested. */
export function updateMenuItems(update: PendingUpdate): MenuItem[] {
  return [
    { id: 'install', label: 'Update and restart', detail: update.version },
    { id: 'later', label: 'Not now' },
  ]
}
