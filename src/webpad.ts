/**
 * The gamepad fallback, via the webview's Gamepad API. `src-tauri/src/input.rs`
 * drives the pad normally, but its Windows backend can die silently; Chromium
 * reads XInput, HID and DirectInput independently. Only one path runs at once.
 */
import type { Action, ActionEvent } from './input'
import { logInfo, logWarn } from './log'

/** Matched to the Rust path so the pad feels identical whichever is driving. */
const REPEAT_DELAY = 380
const REPEAT_RATE = 95
const DEADZONE = 0.55

/** Button indices in the W3C standard mapping. */
const BUTTONS: Array<Action | undefined> = [
  'a', 'b', 'x', 'y',       // 0-3   face
  'lb', 'rb',               // 4-5   bumpers
  undefined, undefined,     // 6-7   triggers: see input.rs, they do not page
  'add', 'menu',            // 8-9   Select/Back, Start
  'sort', 'search',         // 10-11 stick clicks
  'up', 'down', 'left', 'right', // 12-15 d-pad
]

/** Only directions and shoulders repeat. A repeating confirm launches twice. */
const REPEATS = new Set<Action>(['up', 'down', 'left', 'right', 'lb', 'rb'])

/** Any pad Chromium can name, whether or not it has a standard mapping. */
function livePads(): Gamepad[] {
  const list = navigator.getGamepads?.() ?? []
  return [...list].filter((p): p is Gamepad => !!p && p.connected)
}

export interface WebPad {
  /** Names of the pads the webview can see, for the diagnostics screen. */
  seen(): string[]
  /** Whether this path is currently the one dispatching. */
  armed(): boolean
  /** How many of those have a standard mapping, so this path can drive them. */
  usable(): number
  stop(): void
}

/**
 * Watch for pads, and drive them only while `nativeIsAlive` says the native
 * path does not. Asked every frame after a quiet period, since both paths at
 * once fire every press twice.
 */
export function createWebPad(
  dispatch: (e: ActionEvent) => void,
  nativeIsAlive: () => boolean,
  armAfterMs = 2500,
): WebPad {
  let armed = false
  let raf = 0
  let stopped = false

  // Last frame's pressed set, to emit on the transition only.
  let was = new Set<Action>()
  const repeatAt = new Map<Action, number>()
  /** Complain once per pad, not once per frame. */
  const warned = new Set<string>()

  function poll(): void {
    if (stopped) return
    raf = requestAnimationFrame(poll)
    if (performance.now() < settleUntil) return

    // Both arming and standing down are checked every frame; arming once at
    // startup left some machines with neither path driving.
    const nativeCovers = nativeIsAlive()
    if (armed && nativeCovers) {
      armed = false
      was = new Set()
      repeatAt.clear()
      logInfo('input', 'the native gamepad path is delivering; the webview is standing down')
      return
    }
    if (!armed && !nativeCovers && livePads().length) {
      armed = true
      logInfo('input', 'the native path is not covering every pad; the webview is driving')
    }
    if (!armed) return

    const now = performance.now()
    const down = new Set<Action>()

    for (const pad of livePads()) {
      // A non-standard pad's buttons are in arbitrary order; guessing would
      // make buttons do the wrong thing.
      if (pad.mapping !== 'standard') {
        if (!warned.has(pad.id)) {
          warned.add(pad.id)
          logWarn('input', `${pad.id} has no standard mapping; ignoring it in the webview path`)
        }
        continue
      }
      pad.buttons.forEach((b, i) => {
        // 0.5 rather than b.pressed: analogue triggers and some third-party
        // pads report a value without ever setting the boolean.
        const action = BUTTONS[i]
        if (action && (b.pressed || b.value > 0.5)) down.add(action)
        else if (!action && (b.pressed || b.value > 0.5) && !warned.has(pad.id + i)) {
          warned.add(pad.id + i)
          logWarn('input', `${pad.id}: button ${i} is not mapped to anything`)
        }
      })
      const [x = 0, y = 0] = pad.axes
      if (x <= -DEADZONE) down.add('left')
      else if (x >= DEADZONE) down.add('right')
      // Y is inverted in the spec: -1 is up.
      if (y <= -DEADZONE) down.add('up')
      else if (y >= DEADZONE) down.add('down')
    }

    for (const action of down) {
      if (!was.has(action)) {
        dispatch({ action, repeat: false, latency: null, device: 'pad' })
        if (REPEATS.has(action)) repeatAt.set(action, now + REPEAT_DELAY)
      } else {
        const due = repeatAt.get(action)
        if (due !== undefined && now >= due) {
          dispatch({ action, repeat: true, latency: null, device: 'pad' })
          repeatAt.set(action, now + REPEAT_RATE)
        }
      }
    }
    for (const action of was) if (!down.has(action)) repeatAt.delete(action)
    was = down
  }

  // Chromium reveals a pad only on its first button press.
  const onConnect = (e: Event) => {
    const pad = (e as GamepadEvent).gamepad
    logInfo('input', `webview sees ${pad.id} (${pad.mapping || 'non-standard'} mapping)`)
  }
  window.addEventListener('gamepadconnected', onConnect)

  // A quiet period first, so the native path gets first refusal.
  const settleUntil = performance.now() + armAfterMs

  raf = requestAnimationFrame(poll)

  return {
    seen: () => livePads().map((p) => `${p.id} — ${p.mapping || 'non-standard'} mapping`),
    armed: () => armed,
    usable: () => livePads().filter((p) => p.mapping === 'standard').length,
    stop() {
      stopped = true
      cancelAnimationFrame(raf)
      window.removeEventListener('gamepadconnected', onConnect)
    },
  }
}
