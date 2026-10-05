/** Frame timing against the budget in docs/PLAN.md §2. */

export interface FrameStats {
  fps: number
  /** 99th percentile frame time; a good mean can hide a spike every second. */
  p99: number
  worst: number
  /** Refresh rate from the median interval, without which a p99 cannot be
   *  read: 18 ms passes at 60 Hz and drops frames at 120 Hz. */
  hz: number
  /** The fastest rate seen. Adaptive displays such as ProMotion idle at 60 Hz,
   *  so a high `peakHz` over a low `hz` is the display resting, not a cap. */
  peakHz: number
  /** Frames that overran the display's interval by half or more; independent
   *  of refresh rate. */
  dropped: number
}

/** Nearest real refresh rate to a measured interval. */
function nearestHz(medianMs: number): number {
  const rates = [30, 48, 50, 60, 75, 90, 100, 120, 144, 165, 240]
  const measured = 1000 / medianMs
  return rates.reduce((a, b) => (Math.abs(b - measured) < Math.abs(a - measured) ? b : a))
}

/** Measures only between start() and stop(), so a closed HUD costs nothing. */
export function createFrameMeter(windowSize = 180) {
  const times: number[] = []
  let last = 0
  let raf = 0

  function tick(now: number) {
    // The first frame only sets the clock, or the wait counts as a drop.
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
      // 5th percentile, since one short interval after a stall overstates the rate.
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
 * Film grain as one static tile, generated once for a repeating background.
 * An animated canvas or live `feTurbulence` would repaint every frame.
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

/** Which background style a saved setting names; anything unrecognised is
 *  grain, so the window never ends up with neither. */
export function resolveBackgroundStyle(value: string): BackgroundStyle {
  return value === 'blur' ? 'blur' : 'grain'
}

/** Flip the CSS switch in app.css between the two background styles. */
export function applyBackgroundStyle(value: string): void {
  document.documentElement.dataset.background = resolveBackgroundStyle(value)
}
