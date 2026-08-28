/**
 * Phase 0 spike.
 *
 * docs/PLAN.md §10 sets four exit criteria, and this screen is where three of
 * them are demonstrated and measured: the shell runs, the design's CSS renders,
 * and a grid of 2,000 cards holds frame rate. Input arrives next.
 *
 * The purpose of this phase is to kill the project cheaply if the stack was
 * the wrong choice, so the numbers are on screen rather than in a console
 * somewhere — and stamped with the webview that produced them.
 */
import { createGrid, type GridItem } from './grid'
import { createFrameMeter, installGrainTile } from './perf'
import { hostInfo, pingMs, inApp } from './host'
import { createInput, padStatus, type Action } from './input'

const COUNT = Number(new URLSearchParams(location.search).get('n') ?? 2000)

/** Deterministic placeholder library. No network, no keys, no backend — the
 *  grid is being measured here, not the data layer. */
function mockLibrary(n: number): GridItem[] {
  const words = ['Shadow', 'Iron', 'Hollow', 'Crimson', 'Last', 'Silent', 'Broken', 'Elder',
    'Neon', 'Dead', 'Star', 'Deep', 'Lost', 'Wild', 'Frost', 'Ember']
  const nouns = ['Kingdom', 'Protocol', 'Legacy', 'Horizon', 'Requiem', 'Dominion', 'Ashes',
    'Odyssey', 'Covenant', 'Exile', 'Reckoning', 'Vanguard', 'Descent', 'Chronicle']
  const out: GridItem[] = []
  for (let i = 0; i < n; i++) {
    const w = words[i % words.length]
    const nn = nouns[(i * 7 + 3) % nouns.length]
    out.push({
      id: i,
      title: `${w} ${nn}${i > words.length * nouns.length ? ` ${((i / 224) | 0) + 1}` : ''}`,
      tint: `hsl(${(i * 47) % 360} 22% 14%)`,
    })
  }
  return out
}

function padLabel(p: { supported: boolean; connected: number }): string {
  if (!p.supported) return '<b class="bad">unsupported</b>'
  if (p.connected === 0) return '<b>none connected</b>'
  return `<b>${p.connected} connected</b>`
}

/**
 * The HUD, built once.
 *
 * It used to rewrite `innerHTML` twice a second behind a 30px backdrop blur,
 * which re-parsed the markup and forced a backdrop re-blur every tick. That
 * showed up as an 18 ms p99 on a *stationary* grid -- the instrument was most
 * of what it was measuring. Now the structure is created once and only text
 * nodes change, and the blur is gone from src/css/app.css for the same reason.
 */
function hud(rows: string[]): { set(key: string, value: string, bad?: boolean): void } {
  const el = document.createElement('div')
  el.className = 'hud'
  const cells = new Map<string, HTMLElement>()
  for (const key of rows) {
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
  document.body.appendChild(el)
  return {
    set(key, value, bad = false) {
      const cell = cells.get(key)
      if (!cell || cell.textContent === value) return
      cell.textContent = value
      cell.classList.toggle('bad', bad)
    },
  }
}

async function main(): Promise<void> {
  installGrainTile()

  const viewport = document.createElement('div')
  viewport.className = 'grid-viewport'
  document.getElementById('app')!.appendChild(viewport)

  const items = mockLibrary(COUNT)
  const grid = createGrid(viewport)
  grid.setItems(items)

  // Pad and keyboard feed the same action stream. Nothing here knows or cares
  // which one moved the cursor.
  const NAV: Partial<Record<Action, [number, number]>> = {
    left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1],
  }
  let lastLatency: number | null = null
  let worstLatency = 0
  await createInput((e) => {
    if (e.latency !== null) {
      lastLatency = e.latency
      worstLatency = Math.max(worstLatency, e.latency)
    }
    const d = NAV[e.action]
    if (d) grid.move(d[0], d[1])
  })

  const meter = createFrameMeter()
  // ?hud=0 measures without the instrument in the way. Any HUD costs
  // something; this is how you find out how much.
  const showHud = new URLSearchParams(location.search).get('hud') !== '0'
  const host = await hostInfo()
  const ipc = await pingMs()
  const pad = await padStatus()

  // docs/PLAN.md §2. A budget nobody can see is a budget nobody keeps.
  const budget = { p99: 20, ipc: 2, input: 50 }

  if (showHud) {
    const panel = hud(['host', 'display', 'cards', 'fps', 'p99', 'dropped', '-', 'ipc', 'pad', 'input'])
    panel.set('host', `${host.webview} · ${host.os}/${host.arch}`)
    panel.set('cards', `${items.length.toLocaleString()} · ${grid.columns} cols`)
    panel.set('ipc', ipc === null ? '— browser' : `${ipc.toFixed(2)} ms`, ipc !== null && ipc > budget.ipc)
    panel.set('pad', padLabel(pad), !pad.supported)

    setInterval(() => {
      const f = meter.read()
      const frame = f.hz ? 1000 / f.hz : 0
      panel.set('display', f.hz ? `${f.hz} Hz · ${frame.toFixed(1)} ms/frame` : '—')
      panel.set('fps', f.fps.toFixed(0), f.hz > 0 && f.fps < f.hz * 0.95)
      panel.set('p99', `${f.p99.toFixed(1)} ms`, f.p99 > budget.p99)
      // The refresh-independent one: frames that overran the display's own
      // interval by half or more, out of the last three seconds.
      panel.set('dropped', `${f.dropped} / 180 frames`, f.dropped > 2)
      panel.set('input', lastLatency === null
        ? '— press a button'
        : `${lastLatency.toFixed(1)} ms · worst ${worstLatency.toFixed(1)}`,
        worstLatency > budget.input)
    }, 500)
  }

  console.info(`[marquee] spike · ${host.webview} · ${items.length} cards · shell=${inApp ? 'tauri' : 'browser'}`)
}

void main()
