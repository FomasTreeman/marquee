/**
 * One abstract action stream from pad and keyboard; nothing downstream
 * branches on which. The pad arrives from Rust (src-tauri/src/input.rs says
 * why), with the webview's Gamepad API as a fallback.
 */
import { listen } from '@tauri-apps/api/event'
import { call, inApp } from './host'
import { createWebPad, type WebPad } from './webpad'
import { logInfo, logWarn } from './log'

export type Action =
  | 'up' | 'down' | 'left' | 'right'
  | 'a' | 'b' | 'x' | 'y'
  | 'lb' | 'rb'
  | 'menu'
  /** Add a game -- Select/Back on a pad. */
  | 'add'
  /** Keyboard only: the HUD is a development tool. */
  | 'perf'
  /** Open the library search field — right stick click. */
  | 'search'
  | 'fullscreen'
  /** Open the sort menu — left stick click. */
  | 'sort'

/** What the person is actually holding. */
export type Device = 'pad' | 'keyboard' | 'mouse'

/**
 * Whether to offer the on-screen keyboard. Follows the device being held, not
 * whether a pad is connected, so a keyboard user is not shown one.
 */
export function wantsOsk(device: Device): boolean {
  return device === 'pad'
}

export interface ActionEvent {
  action: Action
  /** From auto-repeat rather than a fresh press. */
  repeat: boolean
  /** Delivery latency in ms, or null when it cannot be measured (keyboard,
   *  or running as a plain browser tab). */
  latency: number | null
  /** Where it came from; the legend follows this. */
  device: Device
}

/** Xbox layout, PlayStation in brackets.
 *    A [X]  confirm     B [O]  back
 *    X [□]  quick       Y [△]  details
 */
export const KEYMAP: Record<string, Action> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
  Enter: 'a', Space: 'a',
  Escape: 'b', Backspace: 'b',
  KeyX: 'x', KeyY: 'y',
  KeyQ: 'lb', KeyE: 'rb',
  Tab: 'menu', KeyM: 'menu',
  KeyN: 'add',
  KeyP: 'perf',
  Slash: 'search', KeyF: 'search',
  F11: 'fullscreen',
  KeyO: 'sort',
}

/** Every action a controller can produce, so a test can check each has a key. */
export const PAD_ACTIONS: readonly Action[] = [
  'up', 'down', 'left', 'right',
  'a', 'b', 'x', 'y',
  'lb', 'rb',
  'menu', 'add',
  'search', 'sort',
]

interface RustInputEvent { action: Action; repeat: boolean; t: number }

/**
 * Align the Rust monotonic clock with `performance.now()`. Each sample is off
 * by about half a round trip, so the fastest of several is used.
 */
async function syncClock(samples = 12): Promise<number> {
  let best = Infinity
  let offset = 0
  for (let i = 0; i < samples; i++) {
    const before = performance.now()
    const rust = await call<number>('clock_sync')
    const after = performance.now()
    const rtt = after - before
    if (rtt < best) {
      best = rtt
      // Assume Rust read its clock at the midpoint of the round trip.
      offset = (before + after) / 2 - rust
    }
  }
  return offset
}

export interface PadStatus {
  supported: boolean
  connected: number
  /** The platform API in play: Windows.Gaming.Input, IOKit or evdev. */
  backend: string
  /** One line per device the backend enumerated. */
  devices: string[]
  /** Why there is no input, when there is a reason worth repeating. */
  failure: string | null
  /** Controls being ignored for reporting faster than a hand can move them. */
  silenced: string[]
}

export async function padStatus(): Promise<PadStatus> {
  if (!inApp) {
    return {
      supported: false, connected: 0, backend: 'browser',
      devices: [], failure: null, silenced: [],
    }
  }
  return call<PadStatus>('pad_status')
}

export async function createInput(
  dispatch: (e: ActionEvent) => void,
  /** Called when the person switches between pad, keyboard and mouse. */
  onDeviceChange?: (device: Device) => void,
): Promise<() => void> {
  const disposers: Array<() => void> = []

  // The mouse produces no actions, but the legend needs to know it is in use.
  let device: Device | undefined
  const note = (next: Device) => {
    if (device === next) return
    device = next
    onDeviceChange?.(next)
  }
  const onPointer = () => note('mouse')
  window.addEventListener('pointermove', onPointer, { passive: true })
  window.addEventListener('pointerdown', onPointer, { passive: true })
  disposers.push(() => {
    window.removeEventListener('pointermove', onPointer)
    window.removeEventListener('pointerdown', onPointer)
  })

  const onKey = (e: KeyboardEvent) => {
    // A focused text field gets the keys, or WASD and Space never reach it.
    // Escape still passes so the field can be left.
    const target = e.target as HTMLElement | null
    const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    if (typing && e.code !== 'Escape') return

    const action = KEYMAP[e.code]
    if (!action) return
    e.preventDefault()
    note('keyboard')
    dispatch({ action, repeat: e.repeat, latency: null, device: 'keyboard' })
    tap(action, 'keyboard')
  }
  window.addEventListener('keydown', onKey)
  disposers.push(() => window.removeEventListener('keydown', onKey))

  // Only a delivered press proves the Rust path works; a thread that
  // enumerated a pad and then died still reports one.
  let nativeDelivered = false

  if (inApp) {
    const offset = await syncClock()
    const unlisten = await listen<RustInputEvent>('input', (ev) => {
      const p = ev.payload
      // Recorded first so the webview stands down on its next frame.
      const wasFirst = !nativeDelivered
      nativeDelivered = true

      // Only one path dispatches. While the webview drives it has already
      // handled this press, and a doubled A launches a game twice.
      if (webPad?.armed()) {
        if (wasFirst) {
          logInfo('input', 'the native path delivered; handing the pad back to it')
        }
        return
      }
      dispatch({
        action: p.action,
        repeat: p.repeat,
        latency: performance.now() - (p.t + offset),
        device: 'pad',
      })
      tap(p.action, 'pad')
      note('pad')
    })
    disposers.push(unlisten)
  }

  // Whichever path sees more hardware drives, alone. Native is preferred, but
  // the webview reads APIs gilrs does not, and once saw an Xbox pad it missed.
  let nativePads = (await padStatus()).connected

  // gilrs has reported a pad and never sent a button, so the count alone is
  // not enough.
  const nativeHandlesEverything = () =>
    nativeDelivered && nativePads >= (webPad?.usable() ?? 0)

  // Pads come and go, so a count from startup goes stale.
  const recount = window.setInterval(() => {
    void padStatus()
      .then((s) => { nativePads = s.connected })
      .catch(() => { /* a count we cannot read is not worth a message */ })
  }, 3000)
  disposers.push(() => window.clearInterval(recount))

  webPad = createWebPad(
    (e) => {
      dispatch(e)
      tap(e.action, 'pad')
      note('pad')
    },
    nativeHandlesEverything,
  )
  disposers.push(() => webPad?.stop())

  return () => disposers.forEach((d) => d())
}

/** The live fallback, for the diagnostics in Settings. */
let webPad: WebPad | undefined

/** What the webview can see, whether or not it is the one driving. */
export function webviewPads(): string[] {
  return webPad?.seen() ?? []
}

/** Everything watching the raw stream, for the tester in Settings. */
const taps = new Set<(action: Action, device: Device) => void>()

/** Called from each dispatch above, so the tap sees exactly what the app sees. */
function tap(action: Action, device: Device): void {
  for (const t of taps) t(action, device)
}

/**
 * Watch every action as it arrives, and every button that mapped to nothing.
 * Returns a function that stops watching.
 */
export function onAnyInput(
  onAction: (action: Action, device: Device) => void,
  onUnmapped: (raw: string) => void,
): () => void {
  taps.add(onAction)
  let stopRust: (() => void) | undefined
  let stopped = false
  if (inApp) {
    // Stopping before listen() resolves must still detach it.
    void listen<string>('input-unmapped', (e) => onUnmapped(e.payload))
      .then((un) => { if (stopped) un(); else stopRust = un })
      .catch((e) => logWarn('input', 'could not watch for unmapped buttons', e))
  }
  return () => {
    stopped = true
    taps.delete(onAction)
    stopRust?.()
  }
}
