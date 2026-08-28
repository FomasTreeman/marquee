# Marquee

A cross-platform, controller-first game launcher. One grid, every store, pitch
black, cover art doing the work.

Windows, Linux and macOS. Tauri v2 — a Rust core with a web frontend, so the
interface is CSS and the parsers are memory-safe.

## The idea in four lines

1. Install it. Sign into Steam. Your library is there, with art.
2. Add anything else by typing its name. One field.
3. **No API keys. No accounts. No configuration.**
4. The whole interface is a stylesheet.

## How it works

**Steam is automated.** It reads Steam's own library manifests, so every
installed game appears with its cover, its wide key art and its transparent
logo, and launches with a button.

**Everything else is a name.** Epic, GOG, EA, Ubisoft, emulators, a decade-old
installer — you type *"Hollow Knight"*, pick it from the results, and it lands
in the library complete with metadata and artwork. Pointing at the executable
is a separate one-click step afterwards, so a game looks finished before you
have said anything about where it lives on disk.

That is one code path instead of five undocumented per-store parsers, and it is
why there is no EA integration to break.

**Metadata needs no keys**, because Steam's store search, app details and art
CDN are all public and unauthenticated — and a Steam *store page* exists for
most PC games regardless of where you bought them. Optional keys exist for
games Steam has never heard of, and they are strictly optional.

## Status

**Phase 1 — the skeleton.** Phase 0 passed on macOS: 0–2 dropped frames out of
180 with 2,000 cards, 0.3–2 ms input latency, 0.35 ms IPC. Windows and Linux
are unmeasured.

Now reading a real Steam library and showing it with real cover art. No
metadata, no launching, no manual games yet.

- **[docs/PLAN.md](docs/PLAN.md)** — scope, stack, architecture, phasing, and
  the risks worth knowing before starting.
- **[docs/PHASE-0.md](docs/PHASE-0.md)** — the spike's exit criteria and the
  numbers, per platform.
- **[docs/DEBUGGING.md](docs/DEBUGGING.md)** — the log, the self-check, and how
  to tell a real measurement from a browser-tab artifact.

## Running it

```bash
pnpm install
pnpm app        # the real thing: Tauri window, real numbers
pnpm dev        # plain browser tab, fast loop for CSS work only
pnpm tokens     # regenerate src/css/tokens.css from design/tokens.json
pnpm logs       # tail the log (both runtimes, one file)
pnpm test       # cargo test + tsc
```

`?mock=40` populates the library with real Steam titles — useful on a machine
with two games installed. `?hud=0` hides the HUD, and so does **Y** on the pad.

`pnpm app` puts a HUD in the bottom right with frame rate, input latency, IPC
round trip and the webview that drew it. It is there because priority #1 is
performance and [a budget nobody can see is a budget nobody keeps](docs/PLAN.md).

Do not trust frame numbers from `pnpm dev` — a backgrounded browser tab has
`requestAnimationFrame` throttled and will report nonsense.

Design tokens live in `design/tokens.json` and are generated into CSS. Never
edit `src/css/tokens.css` by hand; the header says so and the next build will
overwrite it.

## Why

[Playnite](https://playnite.link) is the reference and it is excellent: one
library across every store, user data that survives, a fullscreen mode built
for a pad. It is also Windows-only, heavier than a television interface needs
to be, and themed through WPF resource dictionaries — where one malformed file
silently drops the whole theme, and the platform has no letter-spacing and no
saturation filter at all.

The sibling repositories `playnite_clean` and `heroic_clean` are that same
design fighting its host. This is the design with no host to fight.

Priorities, in the order they break ties: **performance, stability, UI.**

Private. Licence deferred.
