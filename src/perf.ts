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
}

export function createFrameMeter(windowSize = 180) {
  const times: number[] = []
  let last = performance.now()
  let raf = 0

  function tick(now: number) {
    times.push(now - last)
    last = now
    if (times.length > windowSize) times.shift()
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  return {
    read(): FrameStats {
      if (times.length < 2) return { fps: 0, p99: 0, worst: 0 }
      const sorted = [...times].sort((a, b) => a - b)
      const mean = times.reduce((a, b) => a + b, 0) / times.length
      const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
      return { fps: 1000 / mean, p99: at(0.99), worst: sorted[sorted.length - 1] ?? 0 }
    },
    stop() { cancelAnimationFrame(raf) },
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
