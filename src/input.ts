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

export type Action =
  | 'up' | 'down' | 'left' | 'right'
  | 'a' | 'b' | 'x' | 'y'
  | 'lb' | 'rb'
  | 'menu' | 'mainmenu'
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

export interface ActionEvent {
  action: Action
  /** From auto-repeat rather than a fresh press. */
  repeat: boolean
  /** Delivery latency in ms, or null when it cannot be measured (keyboard,
   *  or running as a plain browser tab). */
  latency: number | null
}

/** Xbox layout, PlayStation in brackets — matches the prototype exactly.
 *    A [X]  confirm     B [O]  back
 *    X [□]  quick       Y [△]  details
 */
const KEYMAP: Record<string, Action> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
  Enter: 'a', Space: 'a',
  Escape: 'b', Backspace: 'b',
  KeyX: 'x', KeyY: 'y',
  KeyQ: 'lb', KeyE: 'rb',
  Tab: 'menu', KeyM: 'menu',
  KeyI: 'filter',
  KeyP: 'perf',
  Slash: 'search', KeyF: 'search',
  F11: 'fullscreen',
  KeyO: 'sort',
}

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

export interface PadStatus { supported: boolean; connected: number }

export async function padStatus(): Promise<PadStatus> {
  if (!inApp) return { supported: false, connected: 0 }
  return call<PadStatus>('pad_status')
}

export async function createInput(dispatch: (e: ActionEvent) => void): Promise<() => void> {
  const disposers: Array<() => void> = []

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
    dispatch({ action, repeat: e.repeat, latency: null })
  }
  window.addEventListener('keydown', onKey)
  disposers.push(() => window.removeEventListener('keydown', onKey))

  if (inApp) {
    const offset = await syncClock()
    const unlisten = await listen<RustInputEvent>('input', (ev) => {
      const p = ev.payload
      dispatch({
        action: p.action,
        repeat: p.repeat,
        latency: performance.now() - (p.t + offset),
      })
    })
    disposers.push(unlisten)
  }

  return () => disposers.forEach((d) => d())
}
