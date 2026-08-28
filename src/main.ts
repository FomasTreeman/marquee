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

function hud(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'hud'
  document.body.appendChild(el)
  return el
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
  const panel = hud()
  const host = await hostInfo()
  const ipc = await pingMs()
  const pad = await padStatus()

  // docs/PLAN.md §2. A budget nobody can see is a budget nobody keeps.
  const budget = { fps: 58, p99: 20, ipc: 2, input: 50 }
  const flag = (v: number, max: number) => (v > max ? ' class="bad"' : '')

  setInterval(() => {
    const f = meter.read()
    panel.innerHTML = `
      <b>${host.webview}</b><br>
      ${host.os} · ${host.arch} · v${host.version}${host.debug ? ' · debug' : ''}
      <hr>
      cards   <b>${items.length.toLocaleString()}</b> · ${grid.columns} cols<br>
      fps     <b${f.fps < budget.fps ? ' class="bad"' : ''}>${f.fps.toFixed(0)}</b><br>
      p99     <b${flag(f.p99, budget.p99)}>${f.p99.toFixed(1)} ms</b><br>
      worst   <b>${f.worst.toFixed(1)} ms</b><br>
      ipc     ${ipc === null ? '<b>—</b> (browser)' : `<b${flag(ipc, budget.ipc)}>${ipc.toFixed(2)} ms</b>`}
      <hr>
      pad     ${padLabel(pad)}<br>
      input   ${lastLatency === null
                 ? '<b>—</b> press a pad button'
                 : `<b${flag(lastLatency, budget.input)}>${lastLatency.toFixed(1)} ms</b> · worst <b${flag(worstLatency, budget.input)}>${worstLatency.toFixed(1)} ms</b>`}
    `
  }, 500)

  console.info(`[marquee] spike · ${host.webview} · ${items.length} cards · shell=${inApp ? 'tauri' : 'browser'}`)
}

void main()
