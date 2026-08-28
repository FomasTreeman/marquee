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
| 4 | 2,000 cards scroll at refresh rate | p99 < 20 ms, **0 dropped frames** |

The HUD now reports the detected refresh rate and a dropped-frame count,
because an absolute p99 is uninterpretable on its own: 18 ms is a comfortable
pass at 60 Hz and two missed frames at 120 Hz. This is developed on a
ProMotion display and used on a television, so those are not the same machine.
**Dropped frames is the honest metric** — refresh-independent, and it counts
the judder a hand on a stick actually feels.

## Results

| | macOS · WKWebView | Windows · WebView2 | Linux · WebKitGTK |
|---|---|---|---|
| **1** builds and runs | ✅ 1m37s cold, 8s warm | | |
| **2** CSS renders | pending | | |
| **3** input latency | ✅ **0.3–2 ms**, worst 6.3 ms | | |
| **4** grid p99 | ⚠️ re-measuring — see below | | |
| IPC round trip | ✅ **0.35 ms** | | |

Fill each cell from the HUD. Leave a cell empty rather than guessing; an
optimistic blank is how a stack choice survives longer than it deserves.

### Input and IPC: pass, with room to spare

0.3–2 ms typical and 6.3 ms worst against a **50 ms** budget, and 0.35 ms IPC
against **2 ms**. Both are an order of magnitude inside. Two things follow:

- The stack choice is vindicated on the axis that was least certain. Native
  pad polling in Rust pushed to a webview is not a compromise on latency.
- **The budgets were set too loose.** 50 ms was chosen as "imperceptible" and
  the real figure is nearer 5. Do not spend the difference — treat the
  measured number as the new ceiling and notice if it ever triples.

### Grid p99: the first measurement failed, and it was our own fault

First run: **18 ms stationary, 22–25 ms navigating**, against a 20 ms budget.

The stationary figure was the tell. A grid where nothing moves should cost
nothing at all, so a p99 above one frame while idle meant something was doing
work that had no business existing. Four causes, all ours:

1. **The instrument was most of the cost.** The HUD rewrote `innerHTML` twice
   a second behind a `backdrop-filter: blur(30px)`, which re-parsed the markup
   *and* forced a backdrop re-blur on every tick. That is the stationary 18 ms
   almost entirely. The HUD is now built once and only text nodes change, and
   the blur is gone from it.
2. **Two renders per keypress.** `setFocus` rendered synchronously *and*
   scrolled, and the scroll event scheduled a second render for the next
   frame. One of the two was outside the frame entirely. Everything now goes
   through `requestAnimationFrame`.
3. **Forced synchronous layout on every focus move.** `scrollIntoView` read
   `scrollTop` and `clientHeight` and then wrote `scrollTop` in the same turn.
   Both values are now tracked in JavaScript — the scroll listener keeps one
   honest, the other only changes on resize.
4. **49 redundant DOM writes per frame.** `transform` and `data-focus` were
   written unconditionally for every pooled slot, when at most a handful of
   transforms and exactly two focus attributes ever change. Both are now
   compared before writing.

None of these are Tauri, WebKit or the webview. They are the ordinary way a
grid gets slow, and they were found because the number was on screen.

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
