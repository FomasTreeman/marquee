# Marquee

A controller-first game launcher for the television. One grid, every store,
pitch black, cover art doing the work.

Windows, macOS and Linux. Tauri v2 — a Rust core with a web frontend, so the
interface is a stylesheet and the parsers are memory-safe.

## The idea in four lines

1. Install it. Your Steam library is there, with art.
2. Add anything else by typing its name. One field.
3. **No API keys. No accounts. No configuration.**
4. The whole interface is CSS.

## Installing

Download the newest build from
[Releases](https://github.com/FomasTreeman/marquee/releases/latest):

| | file | note |
|---|---|---|
| Windows | `marquee_<version>_x64-setup.exe` | SmartScreen will object, because the installer is not code-signed: *More info → Run anyway*. The `.msi` is the same thing for people who prefer one |
| macOS, Apple silicon | `marquee_<version>_aarch64.dmg` | Not notarised, so the first launch is a right-click → Open rather than a double-click |
| macOS, Intel | `marquee_<version>_x64.dmg` | as above |
| Linux | `.AppImage`, `.deb` or `.rpm` | The AppImage needs `chmod +x`. Linux builds and is released on every merge, and has had far less use than the other two |

Installed copies update themselves. About twenty seconds after launch Marquee
checks for a newer release and offers it when nothing else is on screen —
never over a running game. "Not now" is remembered for that version. Every
download is verified against a public key compiled into the copy already
running; [docs/UPDATES.md](docs/UPDATES.md) explains the whole mechanism.

## How it works

**Steam is automated.** It reads Steam's own library manifests, so every
installed game appears with its cover, its wide key art and its transparent
logo, and launches with a button. If Steam is closed it is started silently to
the tray first, so its window never appears in front of the game.

**Everything else is a name.** Epic, GOG, EA, Ubisoft, emulators, a decade-old
installer — type *"Hollow Knight"*, pick it from the results, and it lands in
the library complete with metadata and artwork. Pointing at the executable is
a separate one-click step afterwards, so a game looks finished before you have
said anything about where it lives on disk. Every executable you choose
teaches Marquee a folder, and it searches those first next time — a library
on whichever drive had room gets found, which guessing at `Program Files`
never would.

That is one code path instead of five undocumented per-store parsers, and it
is why there is no EA integration to break.

**Metadata needs no keys**, because Steam's store search, app details and art
CDN are public and unauthenticated, and a Steam *store page* exists for most
PC games regardless of where you bought them. Steam's own art has real gaps —
recent releases publish a grey placeholder where a cover should be, and plenty
of games have no transparent wordmark at all — so a free
[SteamGridDB](https://www.steamgriddb.com) key can be pasted into Settings to
fill them. Strictly optional, and the app says so when artwork is missing and
the key that would fix it is not set. When no box art exists anywhere, one is
composed from the game's key art and wordmark.

**It is built for a sofa.** Fullscreen by default, the screen kept awake while
you browse, an on-screen keyboard when a pad is what you are holding, and the
launcher minimised the moment a game starts. Favourites, hidden games, hand-
added games, artwork corrections and settings can be exported as a profile,
kept current in a folder of your choosing, and are found on their own after a
reinstall if that folder was beside your games.

## Controls

Everything is reachable with a pad alone, a keyboard alone, or a mouse alone.
A test holds every pad action to having a keyboard route, because "add a
game" once spent a year pad-only.

| Pad | Keyboard | |
|---|---|---|
| D-pad / stick | Arrows, WASD | Move |
| **A** | Enter, Space | Play |
| **B** | Escape, Backspace | Back |
| **X** | X | Favourite |
| **Y** | Y | Details — rename, fix artwork, hide |
| **LB / RB** | Q / E | Page between the preset tabs: All, Favourites, Installed, Never played, Hidden |
| **L3** | O | Sort — recency, playtime, name, size; favourites lead every order |
| **R3** | / or F | Search — matches genre and studio too, so "roguelike" or "larian" finds something |
| **Start** (☰) | Tab, M | Main menu — settings, rescan, quit, restart, shut down |
| **Select** (⧉) | N | Add a game by name |
| | F11 | Windowed or fullscreen; remembered |
| | P | The performance HUD |

The legend along the bottom follows whatever you last used — pad buttons for
a pad, keys for a keyboard, and what clicking does for a mouse — and every
entry in it is clickable. In the grid, click selects and double-click plays.

Motion is tunable in `design/tokens.json`: `--scroll-ms` for the grid glide,
`--motion` as a global multiplier. Both go to zero under
`prefers-reduced-motion`, which makes everything instant rather than degraded.

## Status

In daily use on a Windows machine in a lounge and a Mac on a desk, with a
real library of a couple of hundred games. Linux is built and released on the
same commits and has not been lived with.

Measured on macOS with 2,000 cards: 0–2 dropped frames in 180, 0.3–2 ms input
latency, 0.35 ms IPC round trip. The budgets and how they were arrived at are
in [docs/PLAN.md](docs/PLAN.md) §2 and [docs/DEBUGGING.md](docs/DEBUGGING.md).

Not built: categories and collections; anything about a game that is owned
but has never been installed; running a hand-added Windows executable on
Linux, which would need Proton.

## Building it

Rust stable, Node 20 and pnpm 9. On Linux, the WebKitGTK toolchain first:

```bash
sudo apt-get install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libudev-dev
```

Then:

```bash
pnpm install
pnpm app        # the real thing: a Tauri window with a real library
pnpm dev        # a plain browser tab, for CSS work only — no backend, ?mock=40 for a library
pnpm tokens     # regenerate src/css/tokens.css from design/tokens.json
pnpm logs       # tail the log — both runtimes, one file
pnpm test       # every check CI runs: silence, workflows, board rules, vitest, tsc, cargo test
pnpm check      # the static checks alone
pnpm build:windows   # cross-compile a Windows .exe from a Mac; docs/WINDOWS.md
```

`pnpm app` puts a HUD in the bottom right with frame rate, input latency, IPC
round trip and the webview that drew it, because priority #1 is performance
and a budget nobody can see is a budget nobody keeps. Do not trust frame
numbers from `pnpm dev` — a backgrounded tab has `requestAnimationFrame`
throttled and will report nonsense.

Design tokens live in `design/tokens.json` and are generated into CSS. Never
edit `src/css/tokens.css` by hand; CI checks that the two agree.

[CONTRIBUTING.md](CONTRIBUTING.md) has the conventions, and the one unusual
rule.

## The documents

| | |
|---|---|
| [docs/PLAN.md](docs/PLAN.md) | The plan it was built from, kept as the record of why: scope, stack, priorities as numbers, what was rejected |
| [docs/DEBUGGING.md](docs/DEBUGGING.md) | The log, the self-check that hit-tests what is painted, and the four silent bugs that made it necessary |
| [docs/SECURITY.md](docs/SECURITY.md) | What a launcher can do, and what bounds it. Read before running anything that starts other programs |
| [docs/UPDATES.md](docs/UPDATES.md) | How it updates itself, and the one mistake in the flow you cannot undo |
| [docs/AUTOMATION.md](docs/AUTOMATION.md) | How it is maintained: issue → agent → pull request → CI → review → merge queue → release |
| [docs/WINDOWS.md](docs/WINDOWS.md) | Cross-compiling from a Mac, and what to read when a pad does nothing on Windows |

## Why

[Playnite](https://playnite.link) is the reference and it is excellent: one
library across every store, user data that survives, a fullscreen mode built
for a pad. It is also Windows-only, heavier than a television interface needs
to be, and themed through WPF resource dictionaries, where one malformed file
silently drops the whole theme and the platform has no letter-spacing and no
saturation filter at all.

Marquee is the same design with no host to fight.

Priorities, in the order they break ties: **performance, stability, UI.**
