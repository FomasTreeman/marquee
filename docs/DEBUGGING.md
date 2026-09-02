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
| Linux | `$XDG_STATE_HOME/marquee/marquee.log`, so `~/.local/state/marquee/marquee.log` by default |

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

## Failures that are discarded on purpose

Some failures really are survivable. A backdrop that will not decode, a cache
write that the disk refuses, a log line that cannot be flushed -- none of them
should stop the app. The danger is that the *reason* lives only in the head of
whoever wrote the line, and what is left on the page is `let _ =` or
`catch {}`.

That is not a hypothetical here. If the artwork cache silently fails to write,
Marquee re-downloads 215 covers on every launch, forever, and the only symptom
is that it feels slow. If the version stamp never lands, the cache is cleared
every start. Both look exactly like a slow network.

So the rule is: a discarded failure carries either a log call or a comment
saying why nobody needs to know. `tools/check-silence.sh` enforces it and runs
inside `pnpm test` and before a Windows build. Neither pattern is banned -- the
reason just has to be written down.

```bash
pnpm check      # or tools/check-silence.sh
```

`log_if_err!(source, expr, "context {}", detail)` is the short way to keep the
tolerance and add the sentence.

## The self-check

**This is the part that matters, because error handling does not catch the
bugs this project actually has.**

Four real bugs so far, and all four were silent:

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
- No more cards are visible than there are items. Bug 3, asserted.
- Exactly one filter preset is active — zero means the pills are decoration,
  two means the bar is claiming a different filter than the grid is showing.
- The **focused** card is on screen, not merely some card.
- While an overlay is open: it covers the screen, its buttons are reachable by
  hit test, and its text field is not behind anything. A button behind a scrim
  looks completely normal in the DOM *and in a screenshot*, and does nothing.
- While the on-screen keyboard is up: exactly one key is highlighted, and it
  does not overlap the field it is driving.
- Toasts do not intercept pointer events.
- **The grid fills its width.** Dead space at the right edge is invisible to
  every other assertion: each card is painted, aligned and correct.
- **Nothing animates a layout property.** "We only animate transform and
  opacity" was a promise nothing checked. Animating `width` is invisible until
  a television with a slow GPU drops frames on a menu, so every stylesheet rule
  and keyframe is scanned instead. Verified by adding a transition on `width`
  and a keyframe on `margin-left` and watching it fail, then pass again.

### It runs when overlays open, not only at boot

Checking once at startup means every overlay is verified in the one state it is
never in: closed. Opening the picker or the detail view re-runs the checks and
logs under a context tag, so `selfcheck 10 checks passed (artwork)` tells you
which surface was verified.

### A check that fires when the interface is working is worse than no check

Adding the overlay assertions immediately produced two false positives: with an
overlay open, the grid's cover art is legitimately behind it, and the check
dutifully reported that as a failure. Both were correct observations and useless
findings.

Grid assertions are now gated on no overlay being open. The rule generalises —
**a check must know the states in which its question is meaningful**, because
output that cries wolf teaches everyone to ignore it, including the output that
is real.

It happened twice more, which is why the rule is worth stating rather than just
applying:

- **Only the topmost overlay is checked.** The picker opens *from* the detail
  view, so the detail view stays open underneath and its buttons are then
  correctly unreachable. Asserting on them reported a failure while the
  interface worked exactly as designed.
- **Transitioned values are only asserted when the window can paint.** The
  focus ring's opacity is animated, and a hidden window freezes compositor
  animations mid-flight — so a backgrounded tab reported `opacity 0` for a ring
  plainly visible in the screenshot taken moments later. The DOM state is
  asserted always; the painted value only when `visibilityState` is `visible`.
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

## Driving the interface from a console

In a development build, `window.__marquee` exposes the running interface:
`games`, `focused`, `scan`, `meta`, `grid`, `picker`, `detail`, `menu`, the
`open*` functions for each overlay, `play`, `favourite`, `reloadLibrary`, and
`selfCheck()`.

It exists because overlays are otherwise reachable only through real input,
which makes them awkward to inspect from a console or a driven browser — and
an overlay nobody can open is an overlay nobody can check.

```js
__marquee.openAdd()                     // the add-a-game overlay
__marquee.detail.open(__marquee.games[0], undefined, {})
await __marquee.selfCheck()             // the invariants, as data
```

Not present in a release build.

## Is the artwork working?

Answerable without looking at the screen, which was the point.

Every game gets a manifest recording where each of its three assets came from,
and one log line saying so:

```
INFO  art  440:     cover=Steam hero=Steam logo=Steam (steam complete)
INFO  art  377560:  cover=Steam hero=Steam logo=None
INFO  art  2807960: cover=None  hero=Steam logo=None
```

The same thing appears on a game's detail page under **Artwork**, naming the
source per field so "no wordmark" is distinguishable from "partly Steam".

```bash
cd src-tauri && cargo test resolution_report -- --ignored --nocapture
```

prints that table for a spread of real games — one Steam has everything for,
one it has nothing for, and cases in between. Run it after touching the
pipeline.

### The two searches are different questions

`search_games` searches the **Steam store** and answers *"which game is this"*.
`search_artwork` searches **SteamGridDB** and answers *"whose artwork should
this use"*. Using the first for the second was a real bug and a subtle one: the
picker offered Steam results, the obvious match was the game itself, and
choosing it re-pointed the game at its own appid — a no-op that looked exactly
like a fix. Three of those accumulated in the database before anyone noticed.

### What "working" means here

An asset is accepted only if it **downloads, decodes, is not a placeholder, and
is the right shape.** Each of those rejected something real:

- Steam answers with a flat grey placeholder rather than a 404, so a 200 proves
  nothing.
- A banner decodes perfectly and is still not box art.
- Steam publishes assets under more than one filename and is inconsistent about
  which it has. Rainbow Six Siege 404s on `library_600x900.jpg` and serves a
  perfect 600×900 `portrait.png`.
- SteamGridDB is community submitted, so its top-ranked entry can be a dead
  link or mislabelled. Every submission is tried, not just the first.

## Measuring

`pnpm app` shows a HUD: webview, refresh rate, frame rate, p99, dropped
frames, IPC round trip, pad status, input latency. `?hud=0` hides it and **P**
toggles it at any time — keyboard only, because a development tool does not
deserve a face button. In a release build it is off unless `?hud=1`. Budgets
and their rationale are in [PLAN.md](PLAN.md) §2.

Two rules learned the hard way:

- **The instrument must not cost what it measures.** An earlier HUD rewrote
  `innerHTML` twice a second behind a 30px backdrop blur and was responsible
  for most of the frame time it reported.
- **Report dropped frames, not just p99.** A p99 over 180 frames is the second
  worst frame in three seconds, and one frame of `requestAnimationFrame`
  jitter is ordinary in every engine, so that number sits just above the
  refresh interval no matter how little the page does.

### Where the frame time went, the first time

The first measurement of the 2,000-card grid failed its budget: 18 ms
stationary, 22–25 ms navigating. The stationary figure was the tell — a grid
where nothing moves should cost nothing, so a p99 above one frame while idle
meant something was doing work that had no business existing. Four causes,
none of them Tauri or the webview:

1. **The instrument was most of the cost.** The HUD above, before it was
   rewritten.
2. **Two renders per keypress.** `setFocus` rendered synchronously *and*
   scrolled, and the scroll event scheduled a second render for the next
   frame. Everything now goes through `requestAnimationFrame`.
3. **Forced synchronous layout on every focus move.** `scrollIntoView` read
   `scrollTop` and `clientHeight` and then wrote `scrollTop` in the same turn.
   Both are now tracked in JavaScript; the scroll listener keeps one honest,
   the other only changes on resize.
4. **49 redundant DOM writes per frame.** `transform` and `data-focus` were
   written unconditionally for every pooled slot, when at most a handful of
   transforms and exactly two focus attributes ever change. Both are compared
   before writing.

After the fixes: 0–2 dropped frames in 180, and a p99 that barely moved,
because it was never going to — which is how the budget in PLAN.md §2 became
refresh-relative and dropped-frame based. They are the ordinary ways a grid
gets slow, and they were found because the number was on screen.

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
