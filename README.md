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
logo, and launches with a button. If Steam is closed it is started silently to
the tray first, so its window never appears in front of the game.

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

**Phases 0–2 are done on macOS.** Not a prototype: it reads a real library,
looks right, and launches games.

```
INFO  scan       215 games in 0 ms (steam=ok manual=ok)
INFO  boot       ready in 116 ms · 215 games
INFO  selfcheck  16 checks passed
```

Measured on macOS / WKWebView: 0–2 dropped frames out of 180 with 2,000 cards,
0.3–2 ms input latency, 0.35 ms IPC round trip. Budgets and method are in
[docs/PHASE-0.md](docs/PHASE-0.md).

**Working**

- The Steam library — installed *and* played, with real playtime, from Steam's
  own local files
- Cover art, wide key art and transparent wordmarks, fetched once, resized on
  ingest, then served from disk. The library renders with no network at all
- Names, descriptions, genres, dates and scores — **no API key anywhere**
- **A second artwork source.** Steam's own art has real gaps: recent releases
  publish a grey placeholder where a cover should be, and plenty of games have
  no transparent wordmark at all. Paste a free SteamGridDB key in Settings and
  those fill in — on a real library, 23 of 28 games resolve entirely from Steam
  and the remaining 5 entirely from SteamGridDB. Optional, and the app says so
  when artwork is missing and the key that would fix it is not set
- Launching, by `steam://` for Steam and directly for anything else
- A detail view, favourites that survive a rescan, filter presets, search
- **Renaming any game**, edited in place where its title is shown. Steam's name
  for a game is often not the one you would look for it under, and an edition
  suffix reads badly under a card. An empty field restores the original
- **Adding any other game by typing its name**, with an on-screen keyboard
  when a pad is connected — the whole premise is a launcher used from a sofa,
  and until that existed the headline feature needed a desk
- **Fixing wrong or missing artwork** on any game by searching the name it is
  actually listed under
- **Learning where you keep games.** Every executable you choose by hand
  teaches it a folder, and it searches those first next time — so a library on
  a custom folder on whichever drive had room gets found, which guessing at
  `Program Files` never would

- **Minimises when a game starts**, so a fullscreen launcher is never sitting
  in front of a game that is still loading. Switchable in Settings
- **A profile that survives the machine.** Favourites, hidden games, hand-added
  games and where they live, artwork corrections, settings — exported to any
  path, kept current in a folder of your choosing, and found on its own after a
  reinstall if it was saved beside your games
- **Fullscreen by default** — it is a launcher, not a desktop application that
  happens to be large. **F11** switches to windowed and that choice is
  remembered. The screen is also kept awake
  while you browse — a controller is not an input device as far as the OS is
  concerned, so ten minutes of browsing looks like ten minutes of idle

- Sorting by recency, playtime, name or size — remembered, with favourites
  leading every order. Search matches genre and studio too, so "roguelike" or
  "larian" finds something
- A game that spawns and dies immediately says so, rather than looking like it
  launched

**Not yet**

- **Windows and Linux are entirely unverified.** The code is written for all
  three and CI builds all three, but nothing has been *run* anywhere but macOS,
  and [the plan](docs/PLAN.md) is explicit that a pass on one webview engine is
  not a pass
- Categories and collections

- Anything about a game that is owned but has never been played or installed

- **[docs/PLAN.md](docs/PLAN.md)** — scope, stack, architecture, phasing, and
  the risks worth knowing before starting.
- **[docs/PHASE-0.md](docs/PHASE-0.md)** — the spike's exit criteria and the
  numbers, per platform.
- **[docs/DEBUGGING.md](docs/DEBUGGING.md)** — the log, the self-check, and how
  to tell a real measurement from a browser-tab artifact.
- **[docs/SECURITY.md](docs/SECURITY.md)** — what a launcher can do, and what
  bounds it. Worth reading before running anything that starts other programs.
- **[docs/UPDATES.md](docs/UPDATES.md)** — how Marquee updates itself, how to
  cut a release, and the one mistake in the whole flow you cannot undo.
- **[docs/WORKFLOW.md](docs/WORKFLOW.md)** — the loop from "that's broken" to
  "it updated itself": the board, the labels, who does what and when.
- **[docs/CONTRIBUTING-AI.md](docs/CONTRIBUTING-AI.md)** — the setup behind it,
  and what makes an issue that gets a real fix.

## Running it

```bash
pnpm install
pnpm app        # the real thing: Tauri window, real numbers
pnpm dev        # plain browser tab, fast loop for CSS work only
pnpm tokens     # regenerate src/css/tokens.css from design/tokens.json
pnpm logs       # tail the log (both runtimes, one file)
pnpm test       # silence check + frontend tests + tsc + cargo test
pnpm check      # just the silence check: discarded failures with no reason given
pnpm build:windows   # cross-compile a Windows .exe from here
```

`pnpm build:windows` needs a one-time setup and produces a bare executable, not
an installer — see [docs/WINDOWS.md](docs/WINDOWS.md). It proves the code
compiles for Windows; it does not prove it works there.

`?mock=40` populates the library with real Steam titles — useful on a machine
with two games installed. `?hud=0` hides the HUD, and **P** toggles it.

| | |
|---|---|
| **A** | Play |
| **B** | Back |
| **Y** | Details |
| **X** | Favourite |
| **L3** | Sort menu |
| **R3** / I | Filter menu — search lives at the top of it |
| **LB / RB** | Page up and down |
| **☰** / Tab, M | Main menu — settings, rescan, quit, restart, shut down |
| **⧉** (Select) / N | Add a game by name |
| **/** or F | Search (also reachable from the filter menu, for a pad) |
| **F11** | Fullscreen |
| **P** | Toggle the performance HUD |

The legend along the bottom **follows whatever you last used** — pad buttons for
a pad, keys for a keyboard, and for a mouse it says what clicking does. Every
entry in it is clickable, so sort, filter, search and the menus are reachable
without learning a binding. In the grid, click selects and double-click plays.

Everything is reachable with a pad alone, with a keyboard alone, and with a
mouse alone. Search was keyboard-only for a while; it now sits at the top of
the filter menu, which is where a console would put it. "Add a game" was the
mirror of that -- pad only, on Select, with no key at all -- which is the sort
of gap that lasts a year in a controller-first app, so a test now holds every
pad action to having a keyboard route.

Motion is tunable in `design/tokens.json`: `--scroll-ms` for the grid glide,
`--motion` as a global multiplier. Both go to zero under
`prefers-reduced-motion`, which makes everything instant rather than degraded.

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
