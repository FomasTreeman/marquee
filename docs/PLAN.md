# Marquee: plan and decisions

Why Marquee is built the way it is. Where this and the code disagree, the code
is right. Code comments cite sections by number (`PLAN.md §5`), so keep the
numbering. (A cabinet's marquee is the lit art panel above the screen.)

Priorities, in the order they break ties: **performance, stability, UI.** When
two conflict, the higher one wins and the trade is written down here.

## 1. Scope

A **frontend for games you already own and have installed.** It finds them,
shows them well and launches them: a television interface for a PC.

**Only Steam is automated.** Every other game (Epic, GOG, EA, Ubisoft,
Battle.net, Xbox, emulators, itch, an old installer) is added the same way, by
pointing at the executable. One code path, no per-store reverse engineering.
§5 covers what that buys and costs.

Not in scope:

- **A store.** No purchasing.
- **An installer.** No downloading, patching or repair. That needs per-store
  authentication, DRM, CDN protocols and delta patching for every store, and
  would turn a year's project into a decade's.
- **A compatibility layer.** Wine prefixes are what Lutris, Bottles and Heroic
  already manage.
- **An emulator frontend**, though ROM folders mostly work through manual
  entry.

Nothing else is cross-platform, all-store and controller-first. Playnite and
LaunchBox are Windows only, Lutris is Linux only and only partly
controller-first, Heroic covers Epic, GOG and Amazon, and Steam Big Picture
covers Steam and shortcuts.

**Playnite is the reference.** Marquee copies its single library across
stores, its separation of scanned data from user data, metadata by search and
pick, and a fullscreen mode designed for a pad. But its WPF theming is fragile
(overriding one key replaces a whole style, a malformed file drops the theme,
and there is no letter-spacing or saturation filter), hence CSS; and it is a
.NET desktop stack, Windows only.

## 2. Budgets

A change that breaks a budget is a bug.

**Performance**

| Metric | Budget | Measured with |
|---|---|---|
| Cold start → grid painted, 2,000 games | < 800 ms | in-app trace, logged every boot in dev |
| Idle RSS, 2,000 games | < 200 MB | OS reporting, all three platforms |
| Grid scroll | **< 1% dropped frames**; p99 < 1.25 × frame interval | frame timing HUD |
| Pad press → visible response | < 50 ms (**measured 0.3–2 ms**; hold that) | timestamped in the input event |
| Launch keypress → process spawned | < 200 ms | trace |
| Library rescan, 2,000 games | < 3 s, never blocking the UI | trace |

Budgets assume 2,000 games because a 200-game library hides most mistakes.
Scrolling counts dropped frames because p99 alone sits just above the refresh
interval whatever the page does ([DEBUGGING.md](DEBUGGING.md)).

**Stability**

- No panic crosses from Rust into the UI. Every provider returns `Result`.
- One store failing shows as *"EA: 0 games, see log"* and does not affect the
  rest of the scan.
- User data (custom games, manual art, playtime, favourites, hidden flags)
  lives in tables **no scanner may delete from**.
- Config and database writes are atomic: write temp, fsync, rename.
- Every store parser has golden-file tests against real captured manifests.
- CI builds and tests on Windows, macOS and Linux from the first commit.

**UI.** Design tokens live in `design/tokens.json` and are generated into CSS.
Never edit them in two places.

## 3. Stack

**Tauri v2: Rust core, TypeScript, Vite, no UI framework.**

Tauri uses the system webview (WebView2 on Windows, WKWebView on macOS,
WebKitGTK on Linux) instead of bundling Chromium. Bundles are around 3–10 MB
against Electron's 120–200 MB, and idle memory 20–100 MB against several
hundred. Rust also suits stability: parsers cannot segfault or leak, and the
type system forces handling of malformed files.

Rejected:

- **Electron.** One engine everywhere helps stability, but its memory and
  startup cost is what priority 1 rules out for an app idling on a TV.
- **Native GPU UI** (Rust with `egui`/`iced`, or C++). Fastest, but not CSS.
- **Flutter or Compose Multiplatform.** Not CSS.
- **React, Svelte or Solid.** The app is one grid, one detail view and a few
  overlays. If state management starts to hurt, add Solid or Svelte 5, which
  compile away.

The same reasoning keeps the dependency list short: no framework where the
platform will do, and small parsers of our own where a format is simple (§5).
A new dependency needs a reason in its commit message.

**Three webview engines is the biggest risk in the project.** Mitigations:

- A conservative design: flat, black, one accent, few effects.
- Test risky properties on all three engines before relying on them:
  `backdrop-filter`, `mask-composite`, `:has()`, container queries,
  `color-mix()`, CSS nesting, `content-visibility`.
- CI builds and tests on all three. Screenshot diffing was planned and not
  built: a screenshot catches a change, not a bug. The self-check in
  [DEBUGGING.md](DEBUGGING.md) hit-tests what is painted instead.

## 4. Architecture

The webview (TypeScript and CSS, no framework) draws the grid, hero, detail
view, overlays and settings, and reads an abstract action stream, never raw
input. It sends commands to the Rust core over IPC and receives streamed
events. The core's modules are `input` (gilrs poll loop), `library` (provider
registry, scans), `store` (SQLite, `rusqlite` bundled), `art` (fetch, resize,
content-addressed cache), `meta` (Steam CDN, SteamGridDB) and `run` (process
spawn, playtime, session watch).

**Input does not go through the browser.** The browser Gamepad API differs
between webviews, reports nothing until the user interacts, and stops when a
game takes focus. A `gilrs` poll loop on its own Rust thread sends normalised
actions instead. `gilrs` uses SDL mappings from `SDL_GameControllerDB`, so
off-brand pads work without patches. The frontend only sees
`dispatch(action)`.

**The library does not cross the bridge in one go.** Tauri IPC serialises to
JSON, and 2,000 full records on boot would miss the 800 ms budget. Boot sends
ordered ids and a sort key. Full records arrive in batches for what is on or
near screen. Scan results **stream back as events** per provider, so the window
is usable at once.

**Images** (2,000 covers at 600×900 is about 200 MB decoded if careless):

- Resize **on ingest** to the displayed size and 2×. Never at paint time.
- Serve through the `art://` protocol. Never base64 into the DOM or store image
  bytes in SQLite.
- Every `<img>` has explicit `width`/`height` and `decoding="async"`. **Not
  `loading="lazy"` in the grid**: pooled, transformed slots hide which cards are
  near the viewport, and covers stayed blank. The picker's real scrolling list
  is lazy.
- The hero backdrop preloads neighbours and cross-fades with `opacity`. Animate
  compositor-only properties.
- **Film grain is a static tiled texture**, never an animated canvas or a live
  SVG `feTurbulence`.
- At most one `backdrop-filter: blur(30px)` surface visible at a time, and
  never animate its radius.
- The optional blurred background (Settings → Background) is `filter: blur()`
  on the hero image, which costs once per cross-fade, not every frame.

## 5. The library

Two providers only, behind one trait with `id`, `detect`, `scan` (returning
`Result`) and `launch`.

**Steam** reads `steamapps/libraryfolders.vdf` for the library roots, then
`appmanifest_*.acf` in each: plain-text VDF, a parser of about 150 lines, the
same on every OS. It launches by `steam://rungameid/<appid>`.

**Manual** is our own table, and it is **name-first**. You type a name, pick
from live results with cover art, and the game arrives with its title,
description, genres, developer, publisher, release date, score, cover, hero and
wordmark. **Setting the executable is a separate step** on the detail page;
until then the game shows *Set executable* instead of *Play*. There is no
title-guessing from folder names.

This keeps EA's encrypted catalogue, GOG's SQLite schema, Battle.net's
`product.db`, Ubisoft's registry keys and the Xbox package APIs **off the
roadmap**, with every Windows-only path in the library layer.

The costs: **one search per non-Steam game**, once; **launcher stubs**, which
start their store client and sometimes refuse to run without it; and
**launching a Steam game opens Steam**, which is structural, not a bug.

Playtime is exact for manual games, because Marquee owns the process. With
the Steam URI the child exits at once, so Steam playtime comes from Steam's
records.

**Adding a store later** is a module and a registry entry; Epic would be about
a hundred lines. **A store earns a provider only when the manual flow has
proven annoying for it in practice**, not in anticipation.

## 6. Metadata and art: no keys required

Install, sign in to Steam, done. No API keys, accounts or proxy. These public
endpoints need no authentication:

| Need | Endpoint | Returns |
|---|---|---|
| name → id | `store.steampowered.com/api/storesearch/?term=&cc=us&l=en` | appid, name, thumbnail |
| name → id (alt) | `steamcommunity.com/actions/SearchApps/<term>` | appid, name |
| id → metadata | `store.steampowered.com/api/appdetails?appids=` | description, genres, developer, publisher, release date, Metacritic |
| id → art | `cdn.cloudflare.steamstatic.com/steam/apps/<id>/` | `library_600x900.jpg`, `library_hero.jpg`, **`logo.png`** |

`logo.png` is the **transparent wordmark** the design is built around.
`api.steampowered.com` needs a key and is never used. The store host allows
about 200 requests per five minutes, handled by a queue and a permanent cache.
Most PC games have a Steam page whichever store sold them, so Steam works as a
games database.

**SteamGridDB is optional.** Steam lacks some games entirely (Epic exclusives,
Game Pass, console emulation, some itch releases), serves a **grey placeholder
rather than a 404** for missing assets, and has **no wordmark** for many
well-known games. The chain is Steam, then SteamGridDB if a key is set. Every
candidate is checked by its pixels and by its **shape**; wrong-shaped assets
are rejected, not letterboxed. The key is free, per-user and has no client
secret, and Settings presents it as optional.

**When no box art exists, one is composed** from the key art with the wordmark
centred on a blurred, darkened fill. Without a wordmark the result identifies
nothing, and a plain tinted card with the name is better. Supplying missing
wordmarks is the main thing a SteamGridDB key buys. Wordmarks are **trimmed to
their ink** on ingest.

**IGDB is out**: its Twitch client secret cannot ship in a desktop app without
a server. RAWG is not implemented; it would only add text for games with no
Steam page.

**Manual override always wins** and survives a rescan. **Never ship art**:
caching it per user is normal; redistributing publisher art is not.

## 7. Platforms

| Surface | Windows | macOS | Linux |
|---|---|---|---|
| Steam library path | `Program Files (x86)\Steam` + registry | `~/Library/Application Support/Steam` | `~/.steam/steam`, `~/.local/share/Steam` |
| Inhibit screensaver | `SetThreadExecutionState` | `IOPMAssertion` | D-Bus `org.freedesktop.ScreenSaver` |
| Packaging | MSI / NSIS | DMG | AppImage / Flatpak |

The manifest format, `std::process` and the `steam://` handoff are the same on
all three. All three are built from the first commit. Development is on a Mac, and
WKWebView and WebKitGTK are both WebKit, so the Mac covers most of Linux.
Windows uses Chromium-based WebView2 and is where the app is used daily, so it
is the primary test target. Steam manages Proton on Linux.

**Deferred:** running a manually added Windows executable on Linux, which
needs Proton through `umu-run` as Lutris, Heroic and Bottles do. Also check
whether gamepads need udev rules on the target distribution.

## 8. Data model

SQLite through `rusqlite`, bundled, with versioned migrations from the first
commit.

> **Scanner-owned data and user-owned data live in different tables.**

```
games            id, title, sort_title, provider, provider_game_id, ...
                 ← scanners may insert, update and delete freely
user_game        game_id, favourite, hidden, custom_title, custom_art,
                 rating, notes
                 ← scanners MUST NOT touch this. Ever.
play_session     game_id, started_at, ended_at
                 ← append-only, never rewritten
art_cache        content hash → path, source, fetched_at
provider_state   provider id, last_scan, last_error
```

If a store client is uninstalled and its games drop out of a scan, play history
and favourites survive.

## 9. Frontend

Ported from a framework-free prototype in `playnite_clean/web/`. Its data layer
became a typed client for the Rust API, its input layer a subscriber to Rust
actions, and its grid a virtualised grid using `content-visibility`.
`tokens.css` is generated by `tools/build-tokens.py`. Playnite's 1080 px
virtual canvas is gone in favour of the real viewport, and the limits in
`PLAYNITE-LIMITS.md` no longer apply, but the tuned design is still the
approved one.

## 10. Phases

A phase is done when its exit criterion is demonstrably met.

- **Phase 0, spike ✅** Tauri on all three platforms, a verdict on each risky
  CSS property, `gilrs` actions under 50 ms, 2,000 cards at refresh rate.
- **Phase 1, skeleton ✅** Rust core, SQLite with migrations, both providers,
  the UI on real data. Launches a Steam game and a hand-added one with a pad.
- **Phase 2, art and adding games ✅** Steam metadata and CDN, SteamGridDB,
  ingest resizing, content-addressed cache, manual override. 2,000 games meet
  every budget in §2, and adding a non-Steam game takes under fifteen seconds.

- **Phase 3, big-screen behaviour (in progress).** Done: fullscreen and its
  persistence, keeping the display awake while browsing with a pad, an
  on-screen keyboard, a first run that explains **A**, and detecting a game
  that spawns and dies. Focus returns after a game on its own, and a rescan on
  focus updates Steam playtime. Not built: **gamepad wake**, because the
  obvious version steals focus from a running game and a `steam://` game cannot
  be reliably detected. Linux is built and released but has not been run.
  **Exit:** boot, browse, launch, play, exit, sleep and wake without a
  keyboard.
- **Phase 3.5, profiles ✅** A profile carries sort order, favourites, hidden
  games, artwork corrections and hand-added games (`user_game`, `manual_game`,
  `game_root`, `setting`) to another machine. The SteamGridDB key is left out,
  because a profile is meant to be copied around. Of three options (a file the
  user syncs, a user-supplied backend such as WebDAV or S3, an account system
  that contradicts §6) the first is built: export and import to any path, a
  configured folder rewritten on every change, and a search on first run of
  that folder and every folder games live in, so a reinstalled C: drive finds
  the profile beside the games on D:.
- **Phase 4, release engineering.** Every merge to `main` builds, signs and
  publishes installers, and installed copies update themselves
  ([AUTOMATION.md](AUTOMATION.md), [UPDATES.md](UPDATES.md)). The update
  endpoint must be public, which is one reason the repository is. Open: Windows
  code signing, macOS notarisation, Flatpak, crash reporting, and running the
  self-check after an update with the previous version kept until it passes.
  **Exit:** someone else installs it on a machine we have never touched,
  without instructions.

## 11. Risks

- **Three webview engines.** See §3. The daily machine runs the one engine that
  is not WebKit.
- **Undocumented Steam endpoints.** Stable in practice, not a contract. The
  metadata layer sits behind one interface, a failed fetch shows *"no artwork
  yet, retry"*, and the cache is permanent so an outage does not affect an
  existing library.
- **Undocumented Steam manifests.** Golden-file tests against captured `.acf`
  and `.vdf` files catch regressions but cannot prevent them. A failed scan
  shows a warning and leaves the manual path open.
- **Games Steam does not know.** A mostly Game Pass library gets a worse first
  run. Say so in the README.
- **Anti-cheat.** Some games refuse to run outside their launcher. Steam URIs
  avoid most of this; manual executables may not.
- **Store terms.** Read files a store wrote and call public endpoints at a
  human rate with an honest user agent. Do not automate a store client, scrape
  pages or redistribute assets.
- **Scope creep toward a store**, one small download feature at a time. §1 is
  the line.
- **Scope creep toward per-store providers.** The §5 rule holds.

## 12. Settled decisions

- Steam is the only automated provider; IGDB is out; platforms are not
  sequenced; the name stayed.
- Releases are GitHub Releases on a public repository, because the updater
  needs an endpoint it can read without a token.
- **Licence:** [PolyForm Strict 1.0.0](../LICENSE.md). Run it, read it, learn
  from it; no redistribution or derived works. It is source-available, not open
  source. MIT would allow the copying this is meant to prevent. Contributors'
  work comes under the same terms, which will put some off.
- **Renaming** is in the game details screen and edits the title in place,
  with the on-screen keyboard on a pad. An empty field restores the provider's
  name, which is the only way back.
- **No tuner.** The design is tuned through `design/tokens.json` and
  `pnpm tokens`.
