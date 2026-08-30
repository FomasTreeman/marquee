/**
 * Over-the-air updates: the policy half.
 *
 * The plugin does the dangerous half. `check()` fetches the manifest, and
 * `downloadAndInstall()` verifies the bundle's signature against the public
 * key compiled into the binary before anything touches the installer. A
 * compromised host serves something that will not install rather than
 * something that runs. None of that is re-implemented here.
 *
 * What is here is *when to ask*, and that is the part a launcher gets wrong.
 * Two rules, both learned from launchers that are irritating to live with:
 *
 *   1. **Never interrupt.** A launcher lives on a television and its whole job
 *      is the four seconds between deciding to play something and the game
 *      starting. An update prompt in that gap -- or worse, over a running
 *      game -- is the single most annoying thing this class of app does. So
 *      the check happens once, after the library is up and idle, and the
 *      prompt only ever appears on the library screen with nothing else open.
 *
 *   2. **Say what changed, and take no for an answer.** A binary that silently
 *      replaces itself is indistinguishable from malware from the user's side,
 *      and Marquee already asks for a lot of trust by launching executables.
 *      The notes are shown, "Later" is real, and a refusal is remembered for
 *      that version so the same prompt does not reappear every launch.
 *
 * See docs/UPDATES.md for the release side: keys, manifest, CI.
 */
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { inApp } from './host'
import { logInfo, logWarn } from './log'
import { getSettings, setSetting } from './library'
import type { MenuItem } from './menu'

/** Remembers the last version the user said no to. */
const DECLINED = 'updateDeclined'

/**
 * Long enough that the library is drawn, scanned and settled first.
 *
 * An update check is the least urgent thing the app does. It competes for the
 * network with artwork resolution, which is the thing the user is actually
 * looking at, so it waits its turn.
 */
const CHECK_AFTER_MS = 20_000

export interface PendingUpdate {
  version: string
  notes: string
  /** Download, verify, install, restart. Resolves only if it fails. */
  install(onProgress?: (percent: number | undefined) => void): Promise<void>
}

/**
 * Ask whether there is a newer version.
 *
 * Returns undefined for every "no", including every failure: being offline,
 * a rate-limited host, a malformed manifest. An update check that cannot
 * happen is not an error the user needs to see -- they did not ask for it.
 */
export async function checkForUpdate(): Promise<PendingUpdate | undefined> {
  if (!inApp) return undefined
  let update: Update | null = null
  try {
    update = await check()
  } catch (e) {
    // Logged, not shown. Worth knowing when reading a log; not worth a toast.
    logWarn('update', 'could not check for updates', e)
    return undefined
  }
  if (!update) {
    logInfo('update', 'up to date')
    return undefined
  }

  // A version the user has already refused stays refused. Asking again every
  // launch is how people learn to dismiss prompts without reading them, which
  // is precisely what makes the important one dangerous.
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
      let total = 0
      let got = 0
      await update!.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? 0
          onProgress?.(total ? 0 : undefined)
        } else if (event.event === 'Progress') {
          got += event.data.chunkLength
          onProgress?.(total ? Math.round((got / total) * 100) : undefined)
        } else if (event.event === 'Finished') {
          onProgress?.(100)
        }
      })
      // Only reached if the installer did not take over the process. On
      // Windows the passive installer replaces us, so this never returns.
      logInfo('update', `installed ${update!.version}; restarting`)
      await relaunch()
    },
  }
}

/** Remember a refusal, so this version is not offered again. */
export async function declineUpdate(version: string): Promise<void> {
  try {
    await setSetting(DECLINED, version)
  } catch (e) {
    // Worst case the prompt reappears next launch. Not worth telling anyone.
    logWarn('update', 'could not record the declined version', e)
  }
}

/**
 * Schedule the one check of the session.
 *
 * `isIdle` is asked at the moment the answer is offered, not when it is
 * scheduled -- twenty seconds is plenty of time to have opened a menu or
 * started a game.
 */
export function scheduleUpdateCheck(
  isIdle: () => boolean,
  offer: (update: PendingUpdate) => void,
  delayMs = CHECK_AFTER_MS,
): () => void {
  const timer = window.setTimeout(() => {
    void checkForUpdate().then((update) => {
      if (!update) return
      if (!isIdle()) {
        // Not deferred and retried: one attempt per session. A launcher that
        // keeps trying to interrupt you is worse than one that waits until
        // tomorrow.
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
