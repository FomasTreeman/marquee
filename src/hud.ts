/**
 * The performance HUD. Built once with text nodes and no blur, because an
 * `innerHTML` version behind a backdrop blur cost most of the frame time it
 * reported. Shows dropped frames as well as p99, which rAF jitter keeps just
 * above the refresh interval.
 */
import type { Grid } from './grid'
import type { FrameStats } from './perf'
import type { HostInfo } from './host'
import type { PadStatus } from './input'
import type { ScanResult } from './library'

interface Meter { read(): FrameStats; start(): void; stop(): void }

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
  let refresh: () => void = () => {}

  // Off in release builds; on with ?hud=1 or P.
  let visible =
    new URLSearchParams(location.search).get('hud') === '1' ||
    (import.meta.env.DEV && new URLSearchParams(location.search).get('hud') !== '0')

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

  // The meter and timer run only while shown, so a hidden HUD costs nothing.
  function show(on: boolean): void {
    visible = on
    el.style.display = on ? '' : 'none'
    window.clearInterval(timer)
    timer = undefined
    if (!on) { meter.stop(); return }
    meter.start()
    timer = window.setInterval(refresh, 500)
  }

  return {
    noteInput(latency: number | null): void {
      if (latency === null) return
      lastInput = latency
      worstInput = Math.max(worstInput, latency)
    },

    toggle(): void { show(!visible) },

    async attach(ctx: HudContext): Promise<void> {
      document.body.appendChild(el)
      set('host', `${ctx.host.webview} · ${ctx.host.os}/${ctx.host.arch}`)
      set('library', libraryLabel(ctx.scan), ctx.scan.providers.some((p) => p.error !== null))
      set('ipc', ctx.ipc === null ? '— browser' : `${ctx.ipc.toFixed(2)} ms`,
        ctx.ipc !== null && ctx.ipc > BUDGET.ipcMs)
      set('pad', padLabel(ctx.pad), !ctx.pad.supported)

      refresh = () => {
        const f = meter.read()
        const interval = f.hz ? 1000 / f.hz : 0
        const droppedPct = (f.dropped / 180) * 100
        set('display', f.hz
          ? `${f.hz} Hz${f.peakHz > f.hz ? ` (peak ${f.peakHz})` : ''} · ${interval.toFixed(1)} ms`
          : '—')
        set('cards', `${ctx.total.toLocaleString()} · ${grid.columns} cols`)
        set('fps', f.fps.toFixed(0), f.hz > 0 && f.fps < f.hz * 0.95)
        set('p99', `${f.p99.toFixed(1)} ms`, interval > 0 && f.p99 > interval * BUDGET.p99Frames)
        set('dropped', `${f.dropped} / 180`, droppedPct > BUDGET.droppedPercent)
        set('input', lastInput === null
          ? '— press a button'
          : `${lastInput.toFixed(1)} ms · worst ${worstInput.toFixed(1)}`,
          worstInput > BUDGET.inputMs)
      }
      show(visible)
    },
  }
}
