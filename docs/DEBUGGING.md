# Debugging

By default a Tauri app hides both runtimes: Rust's stdout goes to whatever
launched it, and the webview's console goes nowhere unless devtools are open.
In a black design, a blank window from a swallowed rejection looks the same as
a working one. This is the tooling that makes failures visible.

## The log

Both runtimes write to one file, in order, with a source tag:

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

`pnpm logs` tails it. The path is the first line of every session and the
result of the `log_path` command. The file rolls at 4 MB, keeping one.

What reaches it without opting in:

- Every Rust `log_info!`, `log_warn!` and `log_error!`.
- **Rust panics**, through a hook installed before the window opens.
- **`window.onerror` and `unhandledrejection`** from the webview. `void main()`
  on an async function otherwise swallows every rejection.
- **`console.error` and `console.warn`**, mirrored.
- **Every failed IPC call**, with the command and its arguments. All invokes go
  through `call()` in `src/host.ts` for this.

Logging never throws and never awaits, so it cannot add a second failure.

### Marquee stays minimised after a game closes

Marquee knows a session ended only by watching it: a process it spawned for a
hand-added game, or on Windows the appid Steam reports as running.

- **No `session ended` line:** the watching failed, and the line before says
  why. `exited immediately, cleanly -- probably a launcher stub` means the
  executable handed off to a store client. `never showed up as Steam's running
  game` means Steam never reported the game starting.
- **`session ended` is there:** the restore failed. `restoring the window` is
  followed by `the window is back` or `still minimised after asking to restore
  it`.

## Failures shown on screen

- **Fatal startup errors** show a panel with the message, the stack and the log
  path, styled without depending on anything the app sets up.
- **An empty library explains itself.** "No stores found" and "Steam is here
  but nothing is installed" are different messages.
- **A failed provider degrades.** Scanned games show, with the error beside.

## Failures discarded on purpose

A survivable failure (a backdrop that will not decode, a refused cache write)
still needs its reason written down. If the artwork cache silently fails to
write, Marquee re-downloads every cover on every launch and the only symptom is
slowness. So a bare `let _ =` or `catch {}` carries a log call or a comment
saying why nobody needs to know. `tools/check-silence.sh` (or `pnpm check`)
enforces it, in `pnpm test` and before a Windows build.

`log_if_err!(source, expr, "context {}", detail)` is the short way.

## The self-check

This project's hard bugs threw nothing: `contain: paint` clipping the focus
ring; a fallback painted over every loaded cover; about 48 unparked pooled
slots stacked on the first card, misread as an artwork bug in three
screenshots; a one-game library whose hero stayed empty because tests used
forty games.

`src/selfcheck.ts` asserts the invariants those broke, and **hit-tests what is
painted** rather than trusting the DOM:

- Cover art is the topmost thing at its own centre.
- The first card, the hero and the top bar share a left edge.
- The hero names the selected game and shows its facts.
- No more cards are visible than there are items.
- Exactly one filter preset is active.
- The focused card is on screen, has a visible ring, and no ancestor has paint
  containment that would clip it.
- With an overlay open: it covers the screen, its buttons are reachable by hit
  test, and its text field is not behind anything.
- With the on-screen keyboard up: exactly one key is highlighted, and it does
  not overlap the field it drives.
- Toasts do not intercept pointer events.
- The grid fills its width, with no horizontal overflow.
- The shell's four bands have non-zero height.
- No overlay intercepts the centre of the screen.
- Nothing animates a layout property such as `width`. Every stylesheet rule
  and keyframe is scanned, because a slow television GPU drops frames on it.

It runs automatically in development and with `?check=1`, and writes to the
same log. Opening the picker or the detail view runs it again under a context
tag, so `selfcheck 10 checks passed (artwork)` names the surface checked.

A check must know when its question makes sense, or people learn to ignore it.
Grid assertions are skipped while an overlay is open. Only the topmost overlay
is checked, since the picker opens over the detail view. Transitioned values
are asserted only when `visibilityState` is `visible`, because a hidden window
freezes animations; the DOM state is always asserted.

**When you add a feature, add its invariant here.**

## Driving the interface from a console

In a development build, `window.__marquee` exposes `games`, `focused`, `scan`,
`meta`, `grid`, `picker`, `detail`, `menu`, an `open*` function for each
overlay, `play`, `favourite`, `reloadLibrary` and `selfCheck()`, so overlays
can be opened and checked without real input. It is absent in release builds.

```js
__marquee.openAdd()                     // the add-a-game overlay
__marquee.detail.open(__marquee.games[0], undefined, {})
await __marquee.selfCheck()             // the invariants, as data
```

## Artwork

Each game's log line and detail page (**Artwork**) say where each asset came
from:

```
INFO  art  440:     cover=Steam hero=Steam logo=Steam (steam complete)
INFO  art  377560:  cover=Steam hero=Steam logo=None
INFO  art  2807960: cover=None  hero=Steam logo=None
```

After changing the pipeline, print the table for a spread of real games:

```bash
cd src-tauri && cargo test resolution_report -- --ignored --nocapture
```

An asset is accepted only if it **downloads, decodes, is not a placeholder, and
is the right shape**. Steam serves a grey placeholder rather than a 404, so a
200 proves nothing. A banner decodes and is still not box art. Steam uses more
than one filename per asset (Rainbow Six Siege 404s on `library_600x900.jpg`
and serves `portrait.png`). SteamGridDB's top entry can be dead or
mislabelled, so every submission is tried.

`search_games` searches the **Steam store** for "which game is this".
`search_artwork` searches **SteamGridDB** for "whose artwork should this use".
Using the first for the second re-pointed a game at its own appid.

## Measuring

`pnpm app` shows a HUD: webview, refresh rate, frame rate, p99, dropped frames,
IPC round trip, pad status and input latency. `?hud=0` hides it and **P**
toggles it. In a release build it is off unless `?hud=1`. The budgets are in
[PLAN.md](PLAN.md) §2.

- **The HUD must be cheap.** An earlier one rewrote `innerHTML` twice a second
  behind a 30px blur and caused most of the frame time it reported.
- **Count dropped frames, not just p99.** One frame of `requestAnimationFrame`
  jitter is normal, so p99 sits just above the refresh interval regardless.

Keep renders in `requestAnimationFrame`, track scroll position in JavaScript
rather than reading layout, and compare slot attributes before writing. Each
was a cause when the 2,000-card grid first missed its budget.

## Non-findings

**A background browser tab is not a measurement.** Chrome throttles
`requestAnimationFrame`, pauses compositor animations and deprioritises image
decoding there. Check `document.visibilityState` before believing anything.
Only `pnpm app` with the window in front gives real numbers.

**`pnpm dev` is for CSS work only.** There is no backend, scan or IPC.
`?mock=40` gives a library of real Steam titles to look at.
