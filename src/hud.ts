/**
 * The performance HUD.
 *
 * Priority #1 is performance and docs/PLAN.md §2 states it in numbers, so the
 * numbers live on screen. Two rules learned the hard way:
 *
 *   1. **The instrument must not cost what it measures.** An earlier version
 *      rewrote `innerHTML` twice a second behind a 30px backdrop blur and was
 *      responsible for most of the frame time it was reporting. Built once,
 *      text nodes only, no blur.
 *   2. **Report dropped frames, not just p99.** A p99 over a 180-frame window
 *      is the second worst frame in three seconds, and one frame of rAF jitter
 *      is ordinary in every engine, so the floor sits just above the refresh
 *      interval regardless. Dropped frames is refresh-independent and matches
 *      what a hand on a stick feels.
 */
import type { Grid } from './grid'
import type { FrameStats } from './perf'
import type { HostInfo } from './host'
import type { PadStatus } from './input'
import type { ScanResult } from './library'

interface Meter { read(): FrameStats }

/** Refresh-relative, so the same budget holds on a ProMotion laptop and a
 *  60 Hz television. */
const BUDGET = { p99Frames: 1.25, droppedPercent: 1, ipcMs: 2, inputMs: 50 }

const ROWS = ['host', 'display', 'library', 'cards', 'fps', 'p99', 'dropped', '-', 'ipc', 'pad', 'input'] as const

export interface HudContext {
  host: HostInfo
  ipc: number | null
  pad: PadStatus
  scan: ScanResult
  total: number
}

export function createHud(grid: Grid, meter: Meter) {
  const el = document.createElement('div')
  el.className = 'hud'
  const cells = new Map<string, HTMLElement>()
  for (const key of ROWS) {
    if (key === '-') { el.appendChild(document.createElement('hr')); continue }
    const line = document.createElement('div')
    const label = document.createElement('span')
    label.className = 'k'
    label.textContent = key
    const value = document.createElement('b')
    line.append(label, value)
    el.appendChild(line)
    cells.set(key, value)
  }

  function set(key: string, value: string, bad = false): void {
    const cell = cells.get(key)
    if (!cell || cell.textContent === value) return
    cell.textContent = value
    cell.classList.toggle('bad', bad)
  }

  let lastInput: number | null = null
  let worstInput = 0
  let timer: number | undefined

  // Default on in development, off with ?hud=0. Also toggled from the pad, so
  // it can be dismissed without a keyboard on a television.
  let visible = new URLSearchParams(location.search).get('hud') !== '0'

  function libraryLabel(scan: ScanResult): string {
    const failed = scan.providers.filter((p) => p.error !== null)
    if (failed.length) return `${failed[0]!.provider}: ${failed[0]!.error}`
    const found = scan.providers.filter((p) => p.detected).map((p) => p.provider)
    return found.length ? `${found.join(', ')} · ${scan.tookMs} ms` : 'no stores detected'
  }

  function padLabel(p: PadStatus): string {
    if (!p.supported) return 'unsupported'
    return p.connected === 0 ? 'none connected' : `${p.connected} connected`
  }

  return {
    noteInput(latency: number | null): void {
      if (latency === null) return
      lastInput = latency
      worstInput = Math.max(worstInput, latency)
    },

    toggle(): void {
      visible = !visible
      el.style.display = visible ? '' : 'none'
    },

    async attach(ctx: HudContext): Promise<void> {
      document.body.appendChild(el)
      el.style.display = visible ? '' : 'none'
      set('host', `${ctx.host.webview} · ${ctx.host.os}/${ctx.host.arch}`)
      set('library', libraryLabel(ctx.scan), ctx.scan.providers.some((p) => p.error !== null))
      set('ipc', ctx.ipc === null ? '— browser' : `${ctx.ipc.toFixed(2)} ms`,
        ctx.ipc !== null && ctx.ipc > BUDGET.ipcMs)
      set('pad', padLabel(ctx.pad), !ctx.pad.supported)

      window.clearInterval(timer)
      timer = window.setInterval(() => {
        if (!visible) return
        const f = meter.read()
        const interval = f.hz ? 1000 / f.hz : 0
        const droppedPct = (f.dropped / 180) * 100
        set('display', f.hz ? `${f.hz} Hz · ${interval.toFixed(1)} ms` : '—')
        set('cards', `${ctx.total.toLocaleString()} · ${grid.columns} cols`)
        set('fps', f.fps.toFixed(0), f.hz > 0 && f.fps < f.hz * 0.95)
        set('p99', `${f.p99.toFixed(1)} ms`, interval > 0 && f.p99 > interval * BUDGET.p99Frames)
        set('dropped', `${f.dropped} / 180`, droppedPct > BUDGET.droppedPercent)
        set('input', lastInput === null
          ? '— press a button'
          : `${lastInput.toFixed(1)} ms · worst ${worstInput.toFixed(1)}`,
          worstInput > BUDGET.inputMs)
      }, 500)
    },
  }
}
