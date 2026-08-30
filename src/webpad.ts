/**
 * The gamepad of last resort.
 *
 * `src-tauri/src/input.rs` owns the controller normally, and for good reasons
 * set out there: lower latency, repeat that keeps going while the webview is
 * busy painting, and it still exists when a game takes focus. This is not a
 * replacement for any of that.
 *
 * It exists because that path can fail completely and quietly. On Windows the
 * native backend is Windows.Gaming.Input, reached through a stack of WinRT
 * calls that gilrs unwraps rather than returns; when one of them refuses, the
 * poll thread dies and the app runs on perfectly well with no controller. The
 * user's report is "the pad does nothing", which is also what an unplugged pad
 * looks like.
 *
 * The webview has an entirely independent view of the same hardware. WebView2
 * is Chromium, whose gamepad layer reads XInput, raw HID and DirectInput, and
 * knows DualShock and DualSense specifically. If the native path is dead, this
 * is very likely still alive -- and a launcher whose whole premise is a
 * controller should exhaust every route before telling someone to use a
 * keyboard.
 *
 * Only one of the two ever runs. See `armAfter` below.
 */
import type { Action, ActionEvent } from './input'
import { logInfo, logWarn } from './log'

/** Matched to the Rust path so the pad feels identical whichever is driving. */
const REPEAT_DELAY = 380
const REPEAT_RATE = 95
const DEADZONE = 0.55

/**
 * The W3C "standard" mapping, which is what Chromium reports for anything it
 * recognises. Index order is fixed by the spec, so this is a lookup rather
 * than a guess.
 */
const BUTTONS: Array<Action | undefined> = [
  'a', 'b', 'x', 'y',       // 0-3   face
  'lb', 'rb',               // 4-5   bumpers
  'lb', 'rb',               // 6-7   triggers: page as well, see input.rs
  'add', 'menu',            // 8-9   Select/Back, Start
  'sort', 'filter',         // 10-11 stick clicks
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
  stop(): void
}

/**
 * Watch for pads, and take over only if nothing else has.
 *
 * `nativeIsAlive` is asked once, after a delay. Running both at once would
 * fire every press twice -- and a doubled A launches a game twice -- so the
 * native path gets first refusal and this only arms when it has visibly not
 * taken it.
 */
export function createWebPad(
  dispatch: (e: ActionEvent) => void,
  nativeIsAlive: () => boolean,
  armAfterMs = 2500,
): WebPad {
  let armed = false
  let raf = 0
  let stopped = false

  // Previous frame's pressed set, so we emit on the transition rather than
  // once per frame for as long as a button is held.
  let was = new Set<Action>()
  const repeatAt = new Map<Action, number>()
  /** Complain once per pad, not once per frame. */
  const warned = new Set<string>()

  function poll(): void {
    if (stopped) return
    raf = requestAnimationFrame(poll)
    if (!armed) return

    const now = performance.now()
    const down = new Set<Action>()

    for (const pad of livePads()) {
      // The index table above is the W3C *standard* mapping. A pad Chromium
      // cannot recognise reports `mapping: ""` and hands back buttons in
      // whatever order the device felt like, so reading index 4 as a bumper
      // would be a guess -- and a guess here produces a pad where some buttons
      // do the wrong thing, which is worse than one that does nothing.
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

  // Chromium exposes nothing until a pad announces itself, which it does on
  // the first button press. Listening is the only way to learn a pad exists
  // without a prior user gesture.
  const onConnect = (e: Event) => {
    const pad = (e as GamepadEvent).gamepad
    logInfo('input', `webview sees ${pad.id} (${pad.mapping || 'non-standard'} mapping)`)
  }
  window.addEventListener('gamepadconnected', onConnect)

  const timer = window.setTimeout(() => {
    if (nativeIsAlive()) return
    armed = true
    logInfo(
      'input',
      'native gamepad path reported nothing; the webview is driving the pad instead',
    )
  }, armAfterMs)

  raf = requestAnimationFrame(poll)

  return {
    seen: () => livePads().map((p) => `${p.id} — ${p.mapping || 'non-standard'} mapping`),
    stop() {
      stopped = true
      window.clearTimeout(timer)
      cancelAnimationFrame(raf)
      window.removeEventListener('gamepadconnected', onConnect)
    },
  }
}
