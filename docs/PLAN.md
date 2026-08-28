# Marquee — build plan

> **Marquee** is a placeholder name. An arcade cabinet's marquee is the lit
> panel above the screen: the art *is* the interface. It fits the design, but
> pick the real name before the first public commit — renaming a project after
> people have installed it is the one refactor you cannot do.

A cross-platform, controller-first game launcher. One grid, every store, pitch
black, cover art doing the work.

Priorities, in the order they break ties:

1. **Performance**
2. **Stability**
3. **UI**

Where two of them conflict, the higher number wins and the trade gets written
down in this document rather than argued again later.

---

## 1. Scope

### What it is

A **frontend for games you already own and have installed.** It finds them,
makes them beautiful, and launches them. It is a television interface for a PC.

### What it is not, in v1

- **Not a store.** No purchasing.
- **Not an installer.** No downloading, patching, or repair. If a game is not
  installed, we can show it greyed out and hand you off to the store client
  that owns it.
- **Not a compatibility layer.** On Linux we shell out to `umu-run` for Windows
  games. Managing Wine prefixes ourselves is a multi-year project that Lutris,
  Bottles and Heroic have already each spent years on.
- **Not an emulator frontend** — though ROM folders fall out nearly free from
  the custom-game provider, so we get most of it by accident.

That first exclusion is what makes the project finishable. Downloading and
installing means per-store authentication, DRM, CDN protocols, delta patching
and a support burden, for every store, forever. Launching means reading some
files and spawning a process. The gap between those two is roughly the gap
between a year and a decade.

### The gap it fills

| Existing | Cross-platform | All stores | Controller-first |
|---|---|---|---|
| Playnite | Windows only | yes | yes |
| Heroic | yes | Epic/GOG/Amazon | yes (console mode) |
| Lutris | Linux only | yes | partial |
| LaunchBox | Windows only | emulator-led | yes (paid tier) |
| Steam Big Picture | yes | Steam + shortcuts | yes |

Nothing occupies the top-right of that table. That is the whole thesis.

---

## 2. The priorities, made numeric

Vague priorities lose arguments to whoever speaks last. These are the budgets.
A change that breaks one is a bug, not a preference.

**Performance**

| Metric | Budget | Measured with |
|---|---|---|
| Cold start → grid painted, 2,000 games | < 800 ms | in-app trace, logged every boot in dev |
| Idle RSS, 2,000 games | < 200 MB | OS reporting, all three platforms |
| Grid scroll | locked to refresh rate on integrated graphics | frame timing overlay |
| Pad press → visible response | < 50 ms | timestamped in the input event |
| Launch keypress → process spawned | < 200 ms | trace |
| Library rescan, 2,000 games | < 3 s, never blocking the UI | trace |

The 2,000-game figure is deliberate. A 200-game library hides every mistake you
can make here.

**Stability**

- No panic ever crosses from Rust into the UI. Every provider returns `Result`.
- One store failing degrades to *"EA: 0 games, see log"* and never affects the
  other providers or the rest of the scan.
- User-authored data — custom games, manual art, playtime, favourites, hidden
  flags — lives in tables that **no scanner is permitted to delete from.**
- Config and DB writes are atomic (write temp, fsync, rename).
- Every store parser has golden-file tests against real captured manifests.
- CI builds and runs the test suite on Windows, macOS and Linux from commit one.
  Not "before release". Commit one.

**UI**

- The existing prototype in `playnite_clean/web/` is the spec. It is already
  vanilla ES modules with a real data model, an abstract input layer and a
  token system — roughly 2,700 lines that port more or less directly.
- Design tokens stay in `design/tokens.json` and are generated into CSS, same
  convention as the two theme projects. One source of truth, never hand-edited
  in two places.

---

## 3. Stack

**Recommendation: Tauri v2 — Rust core, web frontend, TypeScript, Vite, no UI framework.**

### Why

Tauri uses the operating system's own webview (WebView2 on Windows, WKWebView
on macOS, WebKitGTK on Linux) instead of shipping a copy of Chromium. Bundles
land around 3–10 MB against Electron's 120–200 MB, and idle memory in the
20–100 MB range against Electron's several hundred. Priority #1 is
performance, and that is not a close call.

The core being Rust also buys the thing priority #2 needs most: store parsers
that cannot segfault, cannot leak, and are forced by the type system to handle
the malformed-file case that *will* arrive the week after a store client
updates.

### What was rejected, and why

**Electron.** One engine everywhere, which genuinely serves priority #2 — it is
what Heroic uses and the reason its CSS behaves identically on every OS. But
the memory and startup cost is exactly the thing priority #1 forbids, and a
launcher sits idle in the background on a TV for hours. Rejected on the stated
priority order, not on merit.

**Native GPU UI (Rust + `egui`/`iced`, or C++).** Fastest, and fails the
explicit requirement to author the interface in CSS. Also throws away a
working prototype.

**Flutter / Compose Multiplatform.** Good, fast, cross-platform — and not CSS.

**A framework (React/Svelte/Solid) on top of Tauri.** The app is one grid, one
detail view and a few overlays, and the prototype already runs framework-free.
Start with TypeScript and no framework. If state management genuinely starts
hurting, add Solid or Svelte 5 — both compile away and neither imposes a
virtual DOM. Do not start there.

### The cost of this choice, stated up front

**Three webview engines is the single biggest risk in the project.** Teams pick
Tauri, develop against one engine, and find CSS divergence in production.
Mitigations, all of which are cheap if done from the start and expensive later:

- The design is already conservative: flat, pitch black, one accent, almost no
  effects. That is luck we should not spend.
- Feature-test the dangerous properties in the spike, on all three, before
  writing any real UI: `backdrop-filter`, `mask-composite`, `:has()`, container
  queries, `color-mix()`, CSS nesting, `content-visibility`.
- `mask-composite` in particular was already tried and reverted once in the
  Playnite project as unverifiable. Treat that as a warning already paid for.
- CI screenshots the same three pages on all three OSes every commit and diffs
  them. This is the direct descendant of the XAML linter, and it exists for the
  same reason: **the bugs that matter are the ones that only appear on a
  machine you are not sitting at.**

---

## 4. Architecture

```
┌───────────────────────────────────────────────────────┐
│  WebView   TypeScript + CSS, no framework             │
│  · grid, hero, detail, overlays, settings             │
│  · reads an abstract action stream, never raw input   │
└───────────▲───────────────────────────┬───────────────┘
            │ events (streamed)         │ commands (IPC)
┌───────────┴───────────────────────────▼───────────────┐
│  Rust core                                            │
│                                                       │
│  input      gilrs poll loop → normalised actions      │
│  library    provider registry, scan orchestration     │
│  store      SQLite (rusqlite, bundled)                │
│  art        fetch, resize, content-addressed cache    │
│  meta       Steam CDN / SteamGridDB / IGDB            │
│  run        process spawn, playtime, session watch    │
└───────────────────────────────────────────────────────┘
```

### Input does not go through the browser

The prototype reads the browser Gamepad API. **The shipped app must not.**
Gamepad support differs across the three webviews, requires user interaction
before it reports anything, and — decisively — stops existing the moment a game
takes focus, which is precisely when a launcher still needs to know whether you
held the guide button for two seconds.

So: a `gilrs` poll loop on a dedicated Rust thread emits normalised actions to
the frontend. `gilrs` uses SDL-compatible mappings from `SDL_GameControllerDB`,
which is what makes an off-brand pad work without a per-device patch.

The prototype's `input.js` already dispatches an abstract action stream that
nothing downstream branches on. That abstraction was written for the Playnite
theme and it is exactly the seam this needs — the frontend keeps its
`dispatch(action)` contract and stops caring where actions come from.

### Never send the library across the bridge

Tauri IPC serialises to JSON. Two thousand full game records through it on
every boot is the easiest way to miss the 800 ms budget.

- Boot sends an ordered array of ids plus a minimal sort key. Cheap.
- Full records arrive in batches, on demand, for what is on or near screen.
- Scan results **stream back as events** as each provider finishes, so the grid
  fills in progressively and the window is interactive immediately.

### Images are the whole performance story

Two thousand covers at 600×900 is roughly 200 MB of decoded bitmap if handled
carelessly. Non-negotiable rules:

- Resize **on ingest** to exactly the displayed size (and 2×), store on disk,
  never resize at paint time.
- Serve through a custom `asset://` protocol handler. Never base64 into the
  DOM; never store image bytes in SQLite.
- Every `<img>` gets explicit `width`/`height`, `loading="lazy"`,
  `decoding="async"`. `content-visibility: auto` on off-screen rows.
- The hero backdrop swaps on every selection change: preload neighbours,
  cross-fade with `opacity` only. Compositor-only properties, always.
- **The film grain must be a static tiled texture.** Not an animated canvas,
  and never a live SVG `feTurbulence` — that is a per-frame CPU burn and it is
  the classic way to lose a frame budget to something nobody asked for.
- `backdrop-filter: blur(30px)` is the most expensive thing in the design.
  At most one such surface visible at a time, and never animate its radius.

---

## 5. The library problem

This is where the actual work is. Everything else is a solved problem.

A single Rust trait, one module per store:

```rust
trait LibraryProvider {
    fn id(&self) -> &'static str;
    fn detect(&self) -> bool;                       // installed on this machine?
    fn scan(&self) -> Result<Vec<GameRef>, ScanError>;   // installed games
    fn launch(&self, g: &GameRef) -> Result<Child, LaunchError>;
}
```

Providers are independent, run concurrently, and are individually fallible.

### Difficulty tiers — read this before estimating anything

| Tier | Store | Source | Notes |
|---|---|---|---|
| **0** | Steam | `steamapps/libraryfolders.vdf` + `appmanifest_*.acf` | Plain text VDF. Needs a ~150-line parser. Multi-library aware. Works on all three OSes. |
| **0** | Epic | `Data/Manifests/*.item` | Plain JSON. Nearly free. |
| **0** | Custom / ROMs | our own DB | Ship this first — it is the fallback for everything below. |
| **1** | GOG Galaxy | `galaxy-2.0.db` SQLite | Read-only, schema is undocumented and can shift. |
| **1** | Ubisoft Connect | Windows registry `Ubisoft\Launcher\Installs` | Windows only. |
| **1** | Battle.net | `product.db` protobuf | Needs a schema we do not control. |
| **2** | Xbox / MS Store | `GamingServices`, package enumeration | Windows-only APIs; launch via `shell:AppsFolder\<PFN>!App`. |
| **3** | **EA** | encrypted `IS` file under `ProgramData\EA Desktop` | See below. |

**EA is the hard one, and it deserves a paragraph of its own.** The modern EA
Desktop client stores its catalogue in a file encrypted with a key derived from
machine hardware identifiers. Playnite's EA plugin reverse-engineers that
derivation, and it breaks whenever EA changes it. The older Origin format
(`ProgramData\Origin\LocalContent\**\*.mfst`, plain text) is far friendlier but
is only present on machines that still have legacy installs.

Plan accordingly: **EA ships behind the custom-game provider, not before it.**
If a user can add an EA game by hand in fifteen seconds, the encrypted-manifest
work stops being a launch blocker and becomes a nice-to-have that can break
without taking a release down with it. Build the escape hatch first.

### Launching, v1: hand off to the store

Do not fight DRM. Launch through the store's own URI handler:

- `steam://rungameid/<appid>`
- `com.epicgames.launcher://apps/<id>?action=launch`
- GOG, EA, Ubisoft, Battle.net all expose equivalents.

This is one line per store, survives store updates, keeps overlays and cloud
saves working, and avoids anti-cheat systems that refuse to run a game started
from an unexpected parent process.

**The honest caveat:** launching a Steam game will open Steam. We are a
frontend, not a replacement, and on a television that is visible. Mitigate by
detecting the child process and covering the handoff, but do not pretend it is
solved. Write it in the README.

---

## 6. Metadata and art

### The constraint that shapes this section

**IGDB requires a Twitch client secret, and a client secret cannot ship inside
a distributed desktop application** — it violates the developer agreement, and
an app access token is a password. IGDB's API only accepts app access tokens.

There are exactly two lawful options:

1. **Bring your own credentials.** The user creates a free Twitch application
   and pastes two values into settings.
2. **Run a proxy.** A Cloudflare Worker holding the secret, ~50 lines,
   effectively free at this scale. This is what Playnite does.

**Recommendation: BYO for v1.** Zero infrastructure, zero running cost, zero
liability, and it can ship the day the code works. Add the proxy only if the
project goes public and the setup friction proves to be the thing stopping
adoption. Design the metadata layer so the swap is a config change.

### Art sources, in priority order

1. **Steam's public CDN** — no key, no auth, no rate limit worth worrying about:
   - `library_600x900.jpg` — portrait cover
   - `library_hero.jpg` — wide key art for the backdrop
   - `logo.png` — **transparent wordmark**

   This covers a large fraction of a typical library for free, and the
   prototype already proves the design works on exactly these three assets.
   It is the default.

2. **SteamGridDB** — grids, heroes, logos and icons for everything Steam does
   not have. The API key is generated per-user from a profile page, free, and
   BYO is the normal, expected pattern there. This is what makes non-Steam
   games look as good as Steam ones.

3. **IGDB** — descriptions, genres, release dates, scores. Text, mostly.

4. **Manual override**, always. Any user-supplied image wins over every source
   above and is never overwritten by a rescan.

That ordering matters: **the app must look finished with no API keys at all.**
Keys improve coverage; they are not a gate on the first-run experience.

### Licensing note

Cover art is publisher IP. Caching it locally, per user, for their own library
is ordinary and uncontroversial. Redistributing it — bundling art in the
installer, mirroring it from our own server — is not. Never ship art.

---

## 7. Platform reality

**Windows** — the primary target. Every store exists here. Most of the
provider work is Windows-specific and some of it (Xbox, registry) has no
meaning elsewhere.

**Linux** — the most interesting target, because it is the one with a real
audience that is underserved and because handheld PCs live here. Native games
and Steam work directly; Windows games go through `umu-run` (umu-launcher),
the Open Wine Components project that makes Proton and protonfixes usable
outside Steam. Lutris, Heroic and Bottles all use it. We shell out to it and
we do not reinvent it. Also: gamepad access may need udev rules on some
distributions — check in the spike, not in a bug report.

**macOS** — the development platform, and it should be first-class as a *UI*
target because that is where the design gets looked at. Be honest that the
Mac gaming library is small: Steam, native apps, and not much else. Treating
it as a co-equal gaming target would distort the roadmap.

---

## 8. Data model

SQLite via `rusqlite`, bundled (no system dependency). Versioned migrations
from the first commit — schema changes after other people have libraries are
otherwise unrecoverable.

The single most important structural decision:

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

If a store client is uninstalled and its games vanish from a scan, the play
history and the favourites survive. That single property is most of what
"stability" means to somebody who has used the app for two years.

---

## 9. Frontend

The prototype is not a mockup — it is the frontend, with mock data. Port it,
do not rewrite it.

| Prototype file | Becomes |
|---|---|
| `data.js` | typed client for the Rust library API |
| `input.js` | subscriber to Rust-emitted actions; keymap and repeat logic survive intact |
| `grid.js`, `cards.js` | virtualised grid, windowed, `content-visibility` |
| `detail.js`, `overlays.js`, `filterpanel.js` | near-direct port |
| `settings.js`, `persist.js` | back onto the Rust config store |
| `tuner.js`, `presets.js` | dev-only, keep behind a flag — it is how the design got tuned |
| `tokens.css` | generated from `design/tokens.json` by `tools/build-tokens.py` |

Two things must change on the way across:

1. The Playnite-specific **1080-px virtual canvas with a Viewbox** goes away.
   It exists because Playnite lays out on a fixed canvas and scales it. We
   have real CSS and can lay out against the actual viewport, which is better
   at every resolution. `--s` and `--cw` disappear.
2. Everything in `PLAYNITE-LIMITS.md` becomes possible again — letter-spacing,
   saturation and contrast filters, real gradients, clamped radii. Do not
   rush to spend that. The design as tuned is the approved one; the
   constraints being lifted is permission, not instruction.

---

## 10. Phases

Each phase has an exit criterion. A phase is not done because the code is
written; it is done because the criterion is demonstrably met.

### Phase 0 — Spike (target: one week)

The purpose is to kill the project cheaply if it deserves to die.

- Tauri v2 shell building and running on all three OSes.
- The prototype's CSS rendering on all three, with a written verdict on every
  dangerous property.
- `gilrs` → webview action stream, measured under 50 ms.
- **A grid of 2,000 placeholder cards scrolling at refresh rate.**

**Exit:** all four demonstrated, on all three OSes, with numbers written down.
If the grid cannot hold frame rate in a webview, the stack choice was wrong
and this is the cheapest possible moment to discover it.

### Phase 1 — Skeleton

Rust core, SQLite with migrations, provider registry. Two providers only:
**custom games** and **Steam**. Launch by URI. Real data behind the ported
prototype UI.

**Exit:** the app finds a real Steam library, shows it in the real design, and
launches a game with a controller. Nothing else.

### Phase 2 — Art and metadata

Steam CDN, SteamGridDB (BYO key), IGDB (BYO credentials). Ingest resizing,
content-addressed cache, manual override.

**Exit:** a 2,000-game library looks like the prototype, and the performance
budgets in §2 are met with real images.

### Phase 3 — The rest of the stores

Epic, GOG, then tier 1, then Xbox. EA last and explicitly optional.

**Exit:** each provider has golden-file tests and degrades visibly rather than
fatally.

### Phase 4 — Big-screen behaviour

The unglamorous list that decides whether it is actually usable on a TV:
fullscreen and exclusive mode, first-run without a mouse, gamepad wake,
inhibiting the screensaver, returning to the launcher when a game exits,
detecting a game that failed to start, settings, and theming.

**Exit:** a full session — boot, browse, launch, play, exit, sleep, wake —
without touching a keyboard.

### Phase 5 — Release engineering

Windows code signing (or SmartScreen will scare off most users), macOS
notarization (needs a paid Apple Developer account), Linux packaging
(AppImage plus Flatpak), Tauri's signed updater, crash reporting.

**Exit:** somebody who is not us installs it, on a machine we have never
touched, without instructions.

---

## 11. Risks and caveats

For whoever picks this up later, including us in six months.

**Three webview engines.** The defining risk. §3 covers the mitigation. Do not
let it slide, because the failure mode is "works on my Mac".

**Store formats are undocumented and unstable.** Every parser here reads a
private format that its owner may change without warning and owes us nothing.
Golden-file tests catch regressions; they cannot prevent breakage. Design so a
broken provider is a visible warning, never a crash, and always leave the
manual escape hatch.

**Anti-cheat.** Some games check their parent process or refuse to run outside
their launcher. Launching by store URI avoids most of this. It will not avoid
all of it, and there is no general fix.

**Store terms of service.** Reading local files that a store wrote on the
user's own machine is fine. Automating a store client, scraping web pages, or
redistributing store assets is not. Stay on the first side of that line and
never scrape when an API exists.

**EA's encrypted manifest.** Fragile by construction — see §5. Never a release
blocker.

**Signing costs real money and time.** An Apple Developer account is an annual
fee; Windows signing is a certificate with its own procurement story. Neither
is technically hard and both take longer than expected. Do not discover them
in release week.

**"It still opens Steam."** Structural, not a bug. Documented in §5.

**Scope creep toward being a store.** Every downloading and installing feature
looks like a small addition to the one before it, and together they are a
different, much larger project. §1 is the line. Move it deliberately or not
at all.

---

## 12. Open decisions

Genuinely open — needs a call before Phase 1, not before Phase 0.

1. **Name.** "Marquee" is a placeholder. Check availability before committing.
2. **Licence.** MIT matches both existing projects and maximises adoption.
   GPL-3 matches Heroic and Lutris and prevents a closed fork. MIT is the
   default here unless there is a reason.
3. **Public or private.** Changes the metadata answer (proxy vs BYO), the
   signing answer, and whether issues become a support obligation. It does not
   change any code before Phase 4, so it can wait.
4. **Windows-first or Linux-first for providers.** Windows has all the stores;
   Linux has the underserved audience and the handhelds.
