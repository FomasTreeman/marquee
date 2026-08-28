# Debugging

A Tauri app is two runtimes and, by default, you can see inside neither.
Rust's stdout goes to whatever launched the process; the webview's console
goes nowhere at all unless someone has devtools open at the exact moment
something throws. A blank window caused by a swallowed promise rejection looks
identical to a blank window caused by a layout bug, which in a pitch-black
design also looks identical to a window that is working perfectly.

This is the tooling that fixes that. It exists because it was needed, and each
piece is here because something was invisible without it.

## One log, both runtimes

Everything lands in one file, in order, with a source tag:

```
22:12:48.747 INFO  scan     1 games in 0 ms (steam=ok)
22:12:48.765 INFO  boot     ready in 21 ms · 1 games · shell=tauri
22:12:49.668 ERROR selfcheck 1/9 checks FAILED
    cover art is painted on top: 1/1 covers are behind img
```

| | |
|---|---|
| macOS | `~/Library/Logs/Marquee/marquee.log` |
| Windows | `%LOCALAPPDATA%\Marquee\logs\marquee.log` |
| Linux | `$XDG_STATE_HOME/marquee/marquee.log` |

```bash
pnpm logs        # tail it
```

The path is printed on the first line of every session and returned by the
`log_path` command, so it can be found without knowing platform conventions.
The file rolls at 4 MB keeping one previous — a launcher runs for hours on a
television, and an unbounded log is a slow leak.

**What reaches it, without anyone opting in:**

- Every Rust `log_info!` / `log_warn!` / `log_error!`.
- **Rust panics**, via a hook installed before the window opens. Otherwise the
  process simply vanishes and the only evidence is on a stderr nobody watched.
- **`window.onerror` and `unhandledrejection`** from the webview. The second
  matters most: `void main()` on an async function swallows every rejection,
  and the symptom is a window that renders nothing with no error anywhere.
- **`console.error` and `console.warn`**, mirrored, so a third-party warning
  is not invisible for not having come through our own helpers.
- **Every failed IPC call**, with the command name and its arguments. All
  invokes route through `call()` in `src/host.ts` for exactly this reason.

Logging never throws and never awaits. Logging that can fail turns one
diagnosable bug into two, and the second hides the first.

## Failures that are visible on screen

- **Fatal startup errors** render a legible panel with the message, the stack
  and the log path, styled without depending on anything the app sets up —
  because the thing that failed may be what would have set it up.
- **An empty library explains itself.** "No stores found" and "Steam is here
  but nothing is installed" are different sentences. Pitch black with nothing
  on it is what this design looks like when it is working, which makes it the
  worst possible way to report that nothing was found.
- **A failed provider degrades.** The shell still comes up, the games that did
  scan are still shown, and the error appears beside them.

## The self-check

**This is the part that matters, because error handling does not catch the
bugs this project actually has.**

Three real bugs so far, and all three were silent:

1. `contain: paint` on the card clipped the focus ring, which is drawn outset
   by design. No error. The ring was simply never visible.
2. `.card-fallback` was absolutely positioned and the cover image was static,
   so the fallback painted on top. Every cover was fully loaded, the network
   was clean, `naturalWidth` was correct — and nothing was visible.
3. Pooled grid slots were created without being parked, so ~48 empty cards sat
   stacked at 0,0 on top of the first card. This one was looked at directly,
   in three separate screenshots, and misread as an artwork bug every time.
4. With exactly one game, the initial selection was never announced. `focus(0)`
   returns early when the index has not changed, and the nudge that worked
   around it (`move(1,0)` then `move(-1,0)`) clamps straight back to 0 in a
   one-item library. The hero and backdrop stayed empty. Every test until then
   had used forty mock games, so the case never arose — **the library size the
   developer's machine actually has was the one size never tested.**

Nothing throws in any of these, so nothing logs. The only conventional way to
find them is for a human to look at the screen and correctly interpret what
they see — and the third shows how well that goes.

So `src/selfcheck.ts` asserts the invariants that would have failed, and it
**hit-tests what is actually painted** rather than trusting the DOM:

- Cover art is the topmost thing at its own centre.
- The first card, the hero and the top bar share a left edge — the design's
  most load-bearing rule, and the one a report like "the card is halfway down
  on the right" is describing.
- The hero identifies the selected game and shows its facts. Bug 4, asserted.
- The focused card has a visible ring, and no ancestor has paint containment
  that would clip it.
- The shell's four bands are laid out with non-zero height.
- No horizontal overflow.
- No overlay intercepts the centre of the screen.

It runs automatically in development and with `?check=1`, and writes to the
same log. Bug 3 above was found by it, fixed, and confirmed fixed, entirely
from a terminal without anyone looking at the window.

**When you add a feature, add its invariant here.** The check is only worth
having if it grows with the interface.

## Measuring

`pnpm app` shows a HUD: webview, refresh rate, frame rate, p99, dropped
frames, IPC round trip, pad status, input latency. `?hud=0` hides it, as does
**Y** on the pad. Budgets and their rationale are in [PLAN.md](PLAN.md) §2.

Two rules learned the hard way:

- **The instrument must not cost what it measures.** An earlier HUD rewrote
  `innerHTML` twice a second behind a 30px backdrop blur and was responsible
  for most of the frame time it reported.
- **Report dropped frames, not just p99.** A p99 over 180 frames is the second
  worst frame in three seconds, and one frame of `requestAnimationFrame`
  jitter is ordinary in every engine, so that number sits just above the
  refresh interval no matter how little the page does.

## Non-findings

Recorded so nobody re-derives them.

**A browser tab that is not in front is not a measurement.** Chrome throttles
`requestAnimationFrame`, pauses compositor animations, and deprioritises image
decoding in a backgrounded tab. Observed there: 1 fps, a 17-second worst
frame, and a CSS opacity transition frozen at `currentTime: 49ms` that never
advanced. `document.visibilityState` says `hidden`; check it before believing
anything. Only `pnpm app`, with the window in front, produces real numbers.

**`pnpm dev` is for CSS work only.** `inApp` is false there, so there is no
backend, no library scan and no IPC — `?mock=40` gives a populated library of
real Steam titles to look at.
