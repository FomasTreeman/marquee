/**
 * Input.
 *
 * One abstract action stream. The gamepad arrives from Rust (see
 * src-tauri/src/input.rs for why it is not the browser Gamepad API) and the
 * keyboard is handled here; nothing downstream ever branches on which.
 *
 * This mirrors the abstraction in the browser prototype's input.js, which was
 * written for the Playnite theme. Keeping the same action names is what makes
 * the rest of the prototype port across unchanged.
 */
import { listen } from '@tauri-apps/api/event'
import { call, inApp } from './host'
import { createWebPad, type WebPad } from './webpad'
import { logWarn } from './log'

export type Action =
  | 'up' | 'down' | 'left' | 'right'
  | 'a' | 'b' | 'x' | 'y'
  | 'lb' | 'rb'
  | 'menu'
  /** Add a game -- Select/Back on a pad. */
  | 'add'
  /** Keyboard only. The HUD is a development tool and does not deserve a
   *  face button. */
  | 'perf'
  /** Open the library search field. */
  | 'search'
  | 'fullscreen'
  /** Open the sort menu — left stick click. */
  | 'sort'
  /** Open the filter menu — right stick click. */
  | 'filter'

/** What the person is actually holding. */
export type Device = 'pad' | 'keyboard' | 'mouse'

export interface ActionEvent {
  action: Action
  /** From auto-repeat rather than a fresh press. */
  repeat: boolean
  /** Delivery latency in ms, or null when it cannot be measured (keyboard,
   *  or running as a plain browser tab). */
  latency: number | null
  /** Where it came from. The legend follows this: telling someone to press A
   *  when they are holding a mouse is worse than telling them nothing. */
  device: Device
}

/** Xbox layout, PlayStation in brackets — matches the prototype exactly.
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
  KeyI: 'filter',
  KeyP: 'perf',
  Slash: 'search', KeyF: 'search',
  F11: 'fullscreen',
  KeyO: 'sort',
}

/**
 * Every action a controller can produce.
 *
 * Marquee is controller-first but has to be fully usable on keyboard and
 * mouse, and "fully" is the part that rots: a new pad binding gets added and
 * the keyboard route is remembered a release later, if at all. Listing them
 * here lets a test hold the two in step.
 */
export const PAD_ACTIONS: readonly Action[] = [
  'up', 'down', 'left', 'right',
  'a', 'b', 'x', 'y',
  'lb', 'rb',
  'menu', 'add',
  'search', 'sort', 'filter',
]

interface RustInputEvent { action: Action; repeat: boolean; t: number }

/**
 * Align the Rust monotonic clock with `performance.now()`.
 *
 * Each sample is biased by roughly half an IPC round trip, so we take the best
 * of several — the fastest round trip is the least biased one. The residual
 * error is well under a millisecond, which is noise against the 50 ms input
 * budget in docs/PLAN.md §2.
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
      // Rust read its clock somewhere inside the round trip; the midpoint is
      // the best available estimate of when.
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
  /** One line per device the backend enumerated. Empty is an answer too. */
  devices: string[]
  /** Why there is no input, when there is a reason worth repeating. */
  failure: string | null
}

export async function padStatus(): Promise<PadStatus> {
  if (!inApp) {
    return { supported: false, connected: 0, backend: 'browser', devices: [], failure: null }
  }
  return call<PadStatus>('pad_status')
}

export async function createInput(
  dispatch: (e: ActionEvent) => void,
  /** Called when the person switches between pad, keyboard and mouse. */
  onDeviceChange?: (device: Device) => void,
): Promise<() => void> {
  const disposers: Array<() => void> = []

  // Mouse movement never produces an action, but it does answer "what are they
  // holding", which is what the legend needs to know.
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
    // While a text field has focus, the keyboard belongs to it. Otherwise the
    // search box eats no letters at all, because W/A/S/D are bound to
    // navigation and Space is bound to confirm.
    //
    // Escape still gets through: a modal you cannot leave from the keyboard is
    // a trap, and the pad's B button reaches the same handler by another road.
    const target = e.target as HTMLElement | null
    const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    if (typing && e.code !== 'Escape') return

    const action = KEYMAP[e.code]
    if (!action) return
    e.preventDefault()
    // Browser key repeat is the OS's, not ours, and its cadence differs per
    // platform. The pad's repeat is tuned in Rust; this just reports honestly.
    note('keyboard')
    dispatch({ action, repeat: e.repeat, latency: null, device: 'keyboard' })
    tap(action, 'keyboard')
  }
  window.addEventListener('keydown', onKey)
  disposers.push(() => window.removeEventListener('keydown', onKey))

  // Whether the Rust path has ever actually delivered a press. Not whether it
  // says it is running -- a thread that enumerated a pad and then died still
  // reports a pad. Only an event that arrived proves the route works.
  let nativeDelivered = false

  if (inApp) {
    const offset = await syncClock()
    const unlisten = await listen<RustInputEvent>('input', (ev) => {
      const p = ev.payload
      nativeDelivered = true
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

  // The fallback. It arms itself only if the native path has neither delivered
  // an event nor found a pad, so in the normal case it costs one timer and
  // never dispatches anything. See webpad.ts for why it exists at all.
  const atStartup = await padStatus()
  webPad = createWebPad(
    (e) => {
      dispatch(e)
      tap(e.action, 'pad')
      note('pad')
    },
    // Re-read on every frame, not captured once. `nativeDelivered` is the
    // half that matters -- a pad connected after startup is not in the
    // snapshot, and an event that actually arrived is the only real proof
    // the native path works.
    () => nativeDelivered || atStartup.connected > 0,
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

/** Called from the dispatch below, so the tap sees exactly what the app sees. */
function tap(action: Action, device: Device): void {
  for (const t of taps) t(action, device)
}

/**
 * Watch every action as it arrives, and every button that mapped to nothing.
 *
 * The second half is the point. A pad whose buttons arrive under names we do
 * not recognise behaves identically to a pad that sends nothing at all, and no
 * device list separates the two -- but one is a two-line fix and the other is
 * a driver problem.
 *
 * Returns a function that stops watching.
 */
export function onAnyInput(
  onAction: (action: Action, device: Device) => void,
  onUnmapped: (raw: string) => void,
): () => void {
  taps.add(onAction)
  let stopRust: (() => void) | undefined
  if (inApp) {
    void listen<string>('input-unmapped', (e) => onUnmapped(e.payload))
      .then((un) => { stopRust = un })
      .catch((e) => logWarn('input', 'could not watch for unmapped buttons', e))
  }
  return () => {
    taps.delete(onAction)
    stopRust?.()
  }
}
