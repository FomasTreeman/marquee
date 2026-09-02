/**
 * Frame timing.
 *
 * Priority #1 is performance, and docs/PLAN.md §2 states it in numbers. A
 * budget nobody can see is a budget nobody keeps, so this runs in dev and
 * puts the truth on screen.
 */

export interface FrameStats {
  fps: number
  /** 99th percentile frame time. The number that actually matters: a mean of
   *  60fps with a 40ms spike every second still feels broken on a pad. */
  p99: number
  worst: number
  /** Refresh rate the frames are actually arriving at, from the median
   *  interval. Without it a p99 is uninterpretable -- 18 ms is a comfortable
   *  pass at 60 Hz and two dropped frames at 120 Hz. */
  hz: number
  /** The fastest interval seen in the window, as a rate.
   *
   *  Distinguishes "this display cannot go faster" from "the compositor chose
   *  not to". macOS ProMotion is adaptive: it settles at a lower rate when
   *  content is static and ramps up under sustained animation, so a still grid
   *  reporting 60 Hz on a 120 Hz panel is the display working correctly, not a
   *  cap. If `peakHz` reaches 120 while `hz` sits at 60, that is what is
   *  happening. */
  peakHz: number
  /** Frames that overran the display's own interval by half or more. This is
   *  the honest metric: refresh-independent, and it counts the judder a hand
   *  on a stick actually feels. */
  dropped: number
}

/** Nearest real refresh rate to a measured interval. */
function nearestHz(medianMs: number): number {
  const rates = [30, 48, 50, 60, 75, 90, 100, 120, 144, 165, 240]
  const measured = 1000 / medianMs
  return rates.reduce((a, b) => (Math.abs(b - measured) < Math.abs(a - measured) ? b : a))
}

/**
 * Measures only between start() and stop(). It used to run from creation for
 * the life of the process, a callback every frame in every release build for
 * a readout nobody had opened; the HUD starts it when shown.
 */
export function createFrameMeter(windowSize = 180) {
  const times: number[] = []
  let last = 0
  let raf = 0

  function tick(now: number) {
    // The first frame after a start only sets the clock: measured from the
    // moment of the call it would report the wait as a dropped frame.
    if (last) times.push(now - last)
    last = now
    if (times.length > windowSize) times.shift()
    raf = requestAnimationFrame(tick)
  }

  return {
    start() {
      if (raf) return
      times.length = 0
      last = 0
      raf = requestAnimationFrame(tick)
    },
    stop() {
      cancelAnimationFrame(raf)
      raf = 0
    },
    read(): FrameStats {
      if (times.length < 8) return { fps: 0, p99: 0, worst: 0, hz: 0, peakHz: 0, dropped: 0 }
      const sorted = [...times].sort((a, b) => a - b)
      const mean = times.reduce((a, b) => a + b, 0) / times.length
      const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
      const median = at(0.5)
      const hz = nearestHz(median)
      // The 5th percentile rather than the outright minimum: one freakishly
      // short interval after a stall would otherwise claim a rate the display
      // never sustained.
      const peakHz = nearestHz(at(0.05))
      const interval = 1000 / hz
      return {
        fps: 1000 / mean,
        p99: at(0.99),
        worst: sorted[sorted.length - 1] ?? 0,
        hz,
        peakHz,
        dropped: times.filter((t) => t > interval * 1.5).length,
      }
    },
  }
}

/**
 * Film grain as a single static tile.
 *
 * Generated once into a data URI and handed to CSS as a repeating background.
 * It must never be an animated canvas or a live SVG `feTurbulence` filter —
 * those repaint every frame for an effect the eye reads as texture, and it is
 * the classic way to lose a frame budget to something nobody asked for.
 */
export function installGrainTile(size = 128): void {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')
  if (!ctx) return
  const img = ctx.createImageData(size, size)
  for (let i = 0; i < img.data.length; i += 4) {
    const v = (Math.random() * 255) | 0
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v
    img.data[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  document.documentElement.style.setProperty('--grain-tile', `url(${c.toDataURL('image/png')})`)
}

export type BackgroundStyle = 'grain' | 'blur'

/**
 * Which background style a saved setting names.
 *
 * Anything other than exactly `'blur'` -- an empty first-run value, or a
 * value from a profile written by an older or newer build -- falls back to
 * grain rather than resolving to neither, which would leave the window with
 * no background treatment at all and nothing to say why.
 */
export function resolveBackgroundStyle(value: string): BackgroundStyle {
  return value === 'blur' ? 'blur' : 'grain'
}

/** Flip the CSS switch in app.css between the two background styles. */
export function applyBackgroundStyle(value: string): void {
  document.documentElement.dataset.background = resolveBackgroundStyle(value)
}
