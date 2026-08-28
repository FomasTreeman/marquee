# Phase 0 — spike results

The exit criterion in [PLAN.md](PLAN.md) §10 is not "the code is written". It
is **all four demonstrated, on all three platforms, with numbers written
down.** This is where they get written down.

The point of the phase is to kill the project cheaply if the stack was the
wrong choice. An empty column below is not a pass.

## How to reproduce

```bash
pnpm install
pnpm app                 # Tauri window, real numbers
pnpm app -- --n=2000     # or set ?n= in the dev URL to change the card count
```

The HUD is bottom right. It reports the webview that drew the frame, because
a frame rate without an engine name proves nothing — the whole risk in §3 is
that the three engines differ.

`pnpm dev` alone opens a plain browser tab. Useful for fast CSS work, but the
frame numbers there are meaningless: a backgrounded tab has `requestAnimation
Frame` throttled to a stop, and it will happily report 1 fps with a 17-second
worst frame. Only trust numbers from `pnpm app` with the window focused.

## Criteria

| # | Criterion | Budget |
|---|---|---|
| 1 | Shell builds and runs | — |
| 2 | The design's CSS renders correctly | no fallbacks, no visual divergence |
| 3 | Pad press → visible response | < 50 ms |
| 4 | 2,000 cards scroll at refresh rate | ≥ 58 fps, p99 < 20 ms |

## Results

| | macOS · WKWebView | Windows · WebView2 | Linux · WebKitGTK |
|---|---|---|---|
| **1** builds and runs | ✅ `cargo build` 1m37s cold, 8s warm | | |
| **2** CSS renders | | | |
| **3** input latency | | | |
| **4** grid fps / p99 | | | |
| IPC round trip | | | |

Fill each cell from the HUD. Leave a cell empty rather than guessing; an
optimistic blank is how a stack choice survives longer than it deserves.

## CSS property verdicts

The properties most likely to diverge across the three engines. Check each on
each platform before the interface depends on it — §3 exists because teams
routinely find this out in production instead.

| Property | Used for | macOS | Windows | Linux |
|---|---|---|---|---|
| `backdrop-filter: blur()` | HUD, overlays, the filter panel | | | |
| `contain: layout style` | grid cards | | | |
| `content-visibility: auto` | off-screen rows | not yet used | | |
| `:has()` | selection styling | not yet used | | |
| `color-mix()` | derived tints | not yet used | | |
| container queries | responsive card sizing | not yet used | | |
| `mask-composite` | gradient card rim | **do not use** | | |

`mask-composite` was tried and reverted once already in `playnite_clean` as
unverifiable. Treat that as a warning already paid for; if the rim effect is
wanted, find another way to get it.

## Known non-findings

Things that looked like results and were not, recorded so nobody re-derives
them:

- **A browser tab reporting 1–22 fps.** Chrome throttles `requestAnimation
  Frame` in a backgrounded tab, and driving one through automation leaves it
  backgrounded between every step. p99 came out at 17 seconds. Not a signal.
- **Arrow keys appearing to do nothing right after a reload.** The keys were
  arriving before the module had executed. Not a signal either.

## One real finding

`contain: paint` on `.card` silently clipped the focus ring, which is drawn
**outset** by design. No error, no warning, no console output — the ring was
simply never visible.

This is the same class of bug as the clipped focus outlines in the Playnite
theme, and it is worth naming the pattern because it will recur: **the
dangerous CSS is the kind that fails silently and correctly-looking.** The fix
and the reasoning are in `src/css/app.css`; the containment now sits on
`.card-art`, which actually wants to clip.
