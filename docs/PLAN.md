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

**Exactly one store is automated: Steam.** Every other game — Epic, GOG, EA,
Ubisoft, Battle.net, Xbox, emulators, itch downloads, a decade-old GOG installer
— is added the same way: point at the executable. One code path, one UI, no
per-store reverse engineering.

That decision is the single most important one in this document, and §5 explains
what it buys and what it costs.

### What it is not, in v1

- **Not a store.** No purchasing.
- **Not an installer.** No downloading, patching, or repair. If a game is not
  installed, the store client that owns it is where you go.
- **Not a compatibility layer.** Managing Wine prefixes is a multi-year project
  that Lutris, Bottles and Heroic have each already spent years on.
- **Not an emulator frontend** — though ROM folders fall out nearly free from
  the manual-entry path, so we get most of it by accident.

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

### The reference is Playnite

Playnite is the thing to beat, and it is worth being precise about why, because
"build a better Playnite" is otherwise just enthusiasm.

**What it got right, and we should copy without ego:**

- One library across every store, with the store as an implementation detail
  rather than a top-level concept the user has to navigate.
- Clean separation of scanned data from user data — playtime, favourites and
  categories survive a store client being uninstalled.
- A metadata flow built around *search and pick* rather than *guess and hope*.
- Filters, categories, tags and completion status that are actually used.
- A fullscreen mode designed for a pad, not a desktop mode with bigger buttons.
- Emulator support that does not feel bolted on.

**Where it leaves room, which is the entire reason this exists:**

- **Theming.** WPF resource dictionaries mean overriding a key replaces the
  whole style including its template, one malformed file silently drops the
  entire theme to default, storyboards cannot resolve dynamic resources, and
  there is no letter-spacing and no saturation filter in the platform at all.
  Two sibling repositories document this in detail; it is the reason for CSS.
- **Weight.** A .NET desktop stack idling in the background of a television.
- **Windows only**, which rules out handhelds and the machine this is being
  written on.

So: the same library model, a fraction of the footprint, and an interface that
can be changed by editing a stylesheet.

## 2. The priorities, made numeric

Vague priorities lose arguments to whoever speaks last. These are the budgets.
A change that breaks one is a bug, not a preference.

**Performance**

| Metric | Budget | Measured with |
|---|---|---|
| Cold start → grid painted, 2,000 games | < 800 ms | in-app trace, logged every boot in dev |
| Idle RSS, 2,000 games | < 200 MB | OS reporting, all three platforms |
| Grid scroll | **< 1% dropped frames**; p99 < 1.25 × frame interval | frame timing HUD |
| Pad press → visible response | < 50 ms (**measured 0.3–2 ms**; hold that) | timestamped in the input event |
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
- The optional blurred background (Settings → Background) is a plain `filter:
  blur()` on the hero backdrop image itself, not `backdrop-filter`. It costs
  once per cross-fade rather than every frame, so it is orthogonal to the rule
  above rather than a second surface competing with it.

---

## 5. The library problem
### Steam is automated. Everything else is a name you type.

Two providers, and only two:

```rust
trait LibraryProvider {
    fn id(&self) -> &'static str;
    fn detect(&self) -> bool;                            // present on this machine?
    fn scan(&self) -> Result<Vec<GameRef>, ScanError>;   // installed games
    fn launch(&self, g: &GameRef) -> Result<Child, LaunchError>;
}
```

**Steam** reads `steamapps/libraryfolders.vdf` for the library roots, then
`appmanifest_*.acf` in each. Plain-text VDF, a parser of roughly 150 lines, and
the format is byte-identical on Windows, macOS and Linux — only the base path
differs. Launch by `steam://rungameid/<appid>`.

**Manual** is our own table, and it is **name-first**.

### Adding a game is one search field

Not a file picker. Not a form. You type *"Hollow Knight"* and everything else
happens:

```
  type a name  →  live results with cover art  →  pick one
                                                    ↓
       title, description, genres, developer, publisher, release date,
       score, cover, hero backdrop, transparent logo — all attached
```

The game is in your library, looking exactly right, before you have told us
anything about where it lives on disk.

**Pointing at the executable is a separate, later, one-click action** on the
detail page. A game without one is in the library and looks finished; it just
says *Set executable* where it would say *Play*. That split is deliberate: the
interesting part of adding a game is identifying it, and identifying it is the
part we can do for you.

There is no title-guessing from folder names, no stripping `bin/x64/Binaries`,
no matching heuristics to get wrong. §6 explains why that entire class of
problem disappeared.

### What this scope deletes

The original plan had a five-tier difficulty table ending in EA's
hardware-key-encrypted catalogue, which Playnite reverse-engineers and which
breaks whenever EA changes the derivation. Also GOG's undocumented SQLite
schema, Battle.net's protobuf `product.db`, Ubisoft's registry keys, and the
Windows-only package APIs behind Xbox.

All of it is gone. Not deferred — **gone from the roadmap.** With it goes every
Windows-only code path in the library layer, which is why §7 no longer needs to
sequence platforms.

### What it costs

**One search per non-Steam game, once.** Thirty games is a few minutes, one
time, and it is pleasant rather than tedious because the covers appear as you
type.

**Some executables are launcher stubs.** Starting an EA or Ubisoft game
directly will often bootstrap that store's client anyway, and a few titles
refuse to run without it. Same visible handoff as the Steam case below, not a
new problem — but not magic either.

### One thing it makes *better*

Playtime. When we spawn the executable ourselves we own the child process and
time the session exactly. With the Steam URI handoff our child exits
immediately and the game belongs to Steam, so Steam playtime needs process-name
watching or reading Steam's own records. The manual path is the accurate one.

### The Steam caveat that does not go away

Launching a Steam game opens Steam. We are a frontend, not a replacement, and
on a television that is visible. Detect the child and cover the handoff, but do
not pretend it is solved. Put it in the README.

### Leaving the door open

The provider trait means adding Epic later is **additive, not a rewrite** — a
new module, a registry entry, done. Epic is nearly free: plain JSON manifests in
`Data/Manifests/*.item`, maybe a hundred lines. But a store earns a provider
only when the manual flow has proven annoying for it **in practice, not in
anticipation.** That rule is the guard against drifting back into five
undocumented parsers.

## 6. Metadata and art — no keys, ever
### The whole thing runs on Steam, and Steam asks for nothing

Install it, sign into Steam, done. No API keys, no accounts, no Twitch
developer application, no proxy server, no settings screen with two empty
fields on it. This is a hard requirement, not an aspiration, and it is
achievable because three public Steam endpoints need no authentication at all.

**Verified working, no key, no headers:**

| Need | Endpoint | Returns |
|---|---|---|
| name → id | `store.steampowered.com/api/storesearch/?term=&cc=us&l=en` | appid, name, thumbnail |
| name → id (alt) | `steamcommunity.com/actions/SearchApps/<term>` | appid, name |
| id → metadata | `store.steampowered.com/api/appdetails?appids=` | description, genres, developer, publisher, release date, Metacritic |
| id → art | `cdn.cloudflare.steamstatic.com/steam/apps/<id>/` | `library_600x900.jpg`, `library_hero.jpg`, **`logo.png`** |

That last one is the important one. `logo.png` is the **transparent wordmark**
the whole design is built around, and it is a plain public image.

Note this is `store.steampowered.com`, not `api.steampowered.com` — the latter
does need a key, and we never touch it. Rate limit on the store host is roughly
200 requests per five minutes, which matters only during a first scan and is
handled by a queue plus a cache that never re-fetches.

### Why a Steam-only metadata source is not the compromise it sounds like

Because a Steam **store page** exists for the overwhelming majority of PC
games, whoever you bought the game from. Cyberpunk on GOG, Battlefield on EA,
Hogwarts Legacy on Epic — all of them have Steam pages with full metadata and
all three art assets. We are using Steam as a games database that happens to be
free and open, not as a storefront.

### The gaps, and the optional fallback

Genuinely absent from Steam: Epic exclusives that never came across, Game Pass
and Xbox-only titles, most console emulation, and some itch releases.

**SteamGridDB is now implemented**, and the gap it fills turned out to be
larger and closer to home than this section assumed. It is not only for games
Steam has never heard of:

- Steam serves a **flat grey placeholder rather than a 404** when an asset does
  not exist, and does this for a lot of recent releases. Battlefield 6's
  portrait cover and wordmark are both placeholders while its wide art is real.
- Plenty of well-known games have **no transparent wordmark at all**, and the
  wordmark is what the hero is built around.

So the artwork chain is: Steam's own asset, then SteamGridDB if a key is
configured. Every candidate is checked by looking at its pixels, because a 200
proves nothing — and by its **shape**, because a banner in a 2:3 card looks
broken however it is fitted. Letterboxing the wide capsule was tried and was a
mistake; a wrong-shaped asset is now rejected outright.

**When no box art exists anywhere, one is composed** from the game's own key
art with its wordmark centred on a blurred, darkened fill. It reads as
deliberate and sits correctly beside real covers.

A wordmark is required for that, and the reason is worth recording: composing
without one produces a handsome abstract blur that identifies nothing, which is
worse than a plain tinted card carrying the game's name in text. A launcher's
job is letting you find a game at a glance, so legibility beats decoration.
This is the clearest thing a SteamGridDB key buys — it supplies the wordmarks
Steam does not have, and those turn blank cards into composed ones.

Wordmarks are also **trimmed to their ink** on ingest. Steam's are frequently a
small logo inside a large transparent canvas; Rainbow Six Siege's has enough
padding that it renders tiny and visibly off-centre.

The key is free, per-user, and carries no client secret — no proxy, no server.
Strictly opt-in, and the settings screen says so rather than presenting an empty
field as though setup were incomplete. RAWG remains unimplemented and is only
needed for text on games with no Steam page at all.

IGDB is out entirely: it requires a Twitch client secret, which cannot ship in
a distributed application, which would force us to run a server. Keep the
metadata layer behind one interface so it could slot in later — but the goal is
that no one ever needs it.

### Manual override, always

Any user-supplied title, description or image wins over every source above and
is never overwritten by a rescan.

### Licensing note

Cover art is publisher IP. Caching it locally, per user, for their own library
is ordinary and uncontroversial. Redistributing it — bundling art in an
installer, mirroring it from a server of ours — is not. Never ship art.

## 7. Platform reality
### The scope decision dissolved this question

With Steam as the only automated provider, there is almost no platform-specific
code left in the library layer to sequence. What remains:

| Surface | Windows | macOS | Linux |
|---|---|---|---|
| Steam library path | `Program Files (x86)\Steam` + registry | `~/Library/Application Support/Steam` | `~/.steam/steam`, `~/.local/share/Steam` |
| Steam manifest format | identical | identical | identical |
| Spawn + watch a process | `std::process` | `std::process` | `std::process` |
| `steam://` handoff | works | works | works |
| Inhibit screensaver | `SetThreadExecutionState` | `IOPMAssertion` | D-Bus `org.freedesktop.ScreenSaver` |
| Packaging | MSI / NSIS | DMG | AppImage / Flatpak |

Four small platform shims and three packaging targets. That is the entire
delta. **There is no longer a meaningful "platform first" decision to make** —
the thing that would have forced one was the per-store reverse engineering,
and that is gone.

### So: all three from commit one, develop on Mac, dogfood on Windows

- **Develop on the Mac** because that is where the machine is and the loop is
  fastest. There is a real technical dividend too: macOS WKWebView and Linux
  WebKitGTK are **both WebKit**, so getting the interface right on the Mac gets
  it most of the way to Linux for free.
- **Windows is the odd one out**, because WebView2 is Chromium. It is also
  where the app will actually be used for the next few months, so it is the
  dogfood target and it is in CI from the first commit. Divergence found in
  week one is a CSS tweak; found in month four it is an architecture problem.
- **Linux is not a big undertaking under this scope.** Native Linux games and
  Steam games both work with no special handling — Steam manages its own Proton
  and we never see it. Verify it in the Phase 0 spike, package it in Phase 5.

### The one Linux thing that is deferred

Running a *manually-added Windows executable* on Linux needs Proton, via
`umu-run` (umu-launcher), the project that makes Proton and protonfixes usable
outside Steam. Lutris, Heroic and Bottles all shell out to it and so should we.

Note how narrow that is: a niche within a niche, and it does not block anything
else. Defer until Linux is actually a daily driver. Also check in the spike
whether gamepad access needs udev rules on the target distribution — that is
the kind of thing better found deliberately than in a bug report.

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

### Phase 0 — Spike ✅ *(macOS)*

The purpose is to kill the project cheaply if it deserves to die.

- Tauri v2 shell building and running on Windows, macOS and Linux.
- The prototype's CSS rendering on all three, with a written verdict on every
  dangerous property.
- `gilrs` → webview action stream, measured under 50 ms.
- **A grid of 2,000 placeholder cards scrolling at refresh rate.**

**Exit:** all four demonstrated, on all three, with numbers written down. If
the grid cannot hold frame rate in a webview, the stack choice was wrong and
this is the cheapest possible moment to find that out.

### Phase 1 — Skeleton ✅ *(macOS)*

Rust core, SQLite with migrations, the two providers from §5: **Steam** and
**manual**. Launch by `steam://` and by process spawn respectively. The ported
prototype UI running on real data.

**Exit:** the app finds the real Steam library, shows it in the real design, and
launches a game with a controller. A hand-added executable does the same.

### Phase 2 — Art, metadata, and the add-a-game flow ✅ *(macOS)*

Steam appdetails and CDN (no keys), SteamGridDB and RAWG (BYO keys). Ingest
resizing, content-addressed cache, manual override.

Plus the matching overlay from §5 — pick an executable, guess a title, search,
choose from a short list, attach art. Under this scope that flow is not a side
feature; **it is how most of the library gets in.** Budget for it accordingly
and make the guess good.

**Exit:** a 2,000-game library looks like the prototype and meets every
performance budget in §2 with real images. Adding a non-Steam game takes under
fifteen seconds and lands the right art without typing a full title.

### Phase 3 — Big-screen behaviour  ← **in progress**

Done: fullscreen and its persistence, keeping the display awake while browsing
with a pad, an on-screen keyboard, a first run that says what **A** does when
there is nothing to select, and detecting a game that spawns and dies.

Remaining: **gamepad wake** — raising the window on a button press — which is
deliberately not built yet. The obvious implementation steals focus from a
running game, which is precisely when nobody wants it, and there is no reliable
way to know a game is running when it was launched through `steam://`. Better
absent than wrong.

Returning to the launcher when a game exits needs nothing: the OS restores
focus on its own, and the window already rescans on focus, so playtime updates
from Steam's own records without anything watching.


Plus the thing Phases 1 and 2 deferred and must not defer again: **Windows and
Linux actually being run.** Everything is written for all three and CI compiles
all three, but compiling is not running, and §3 is explicit that a pass on one
engine is not a pass.

The on-screen keyboard landed early, at the end of Phase 2, because without it
the headline feature of §5 needed a desk — which contradicts the premise.


The unglamorous list that decides whether it is actually usable on a TV:
fullscreen and exclusive mode, first-run without a mouse, gamepad wake,
inhibiting the screensaver, returning to the launcher when a game exits,
detecting a game that failed to start, settings, and theming.

**Exit:** a full session — boot, browse, launch, play, exit, sleep, wake —
without touching a keyboard.

### Phase 3.5 — Profiles and synced settings  ✅ *(option 1, done)*

Carry a configuration between machines: the SteamGridDB key, sort order,
favourites, hidden games, artwork corrections and hand-added games, so a second
machine is set up by signing in rather than by repeating the work.

**Everything needed is already in the right shape.** `user_game`, `manual_game`,
`game_root` and `setting` are exactly the tables that would sync, and they are
already separated from anything a scanner writes — which is the hard part of
this and it is done. What would sync is small: kilobytes, not artwork.

The open question is not the format, it is **where it goes**. This project's
whole position is that it needs no server and no account (§6), and a sync
service is both. Three options, in the order I would try them:

1. **A file the user syncs themselves** — export to a folder that is already in
   Dropbox, iCloud or a git repo. No account, no server, no liability, works
   today for anyone who already syncs a folder. It is not automatic.
2. **A user-supplied backend** — a WebDAV URL, an S3 bucket, a gist. Still no
   service of ours, and automatic for people who want it.
3. **A real account system.** Contradicts §6 and turns this into something with
   users, uptime and a privacy policy. Worth it only if this goes public.

Option 1 is built, with a twist that makes it better than manual export usually
is:

- **Export and import to any path**, from Settings.
- **A configured folder is kept current**, rewritten on every change rather than
  when someone remembers. Point it at a synced folder and it is cloud sync;
  point it at a second drive and it survives the reinstall that took the first.
- **A profile is looked for on first run** — in the configured folder, and in
  every folder the app has learned games live in. That last one is what makes
  it work without anyone remembering: a machine whose C: drive was just
  reinstalled still has its games on D:, and a profile saved beside them is
  found on its own.

Options 2 and 3 remain open and are now cheaper, because the format is the same
either way and the only new part would be where the bytes go.

### Phase 4 — Release engineering

Deferred while the project is private, but the work is known: Windows code
signing (or SmartScreen will scare off most users), macOS notarization (needs a
paid Apple Developer account), Linux packaging (AppImage plus Flatpak), crash
reporting, and over-the-air updates.

**Exit:** somebody who is not us installs it, on a machine we have never
touched, without instructions.

#### Over-the-air updates ✅ *(built)*

Done, and documented end to end in **[docs/UPDATES.md](UPDATES.md)** — the
keypair, the manifest, the release workflow, and the two policy rules that
matter more than the plumbing: never interrupt a session, and always say what
changed and let it be refused.

What remains is not code. The endpoint has to be publicly readable, because a
private repository's release assets need a token and there is nowhere safe to
put one in a desktop app. That is the constraint tying updates to the decision
in §12.3. The private signing key must also be backed up before anything ships:
lose it and no existing install can ever be updated again, since each one only
trusts bundles signed by the key it was compiled against.

Still open, and worth doing before the first real release: running the
self-check on the first launch after an update and keeping the previous version
recoverable until it passes. An update that installs and then will not start is
the worst outcome, because the machine is in the lounge.

## 11. Risks and caveats
For whoever picks this up later, including us in six months.

**Three webview engines.** The defining risk, and the one no scope decision
shrinks. §3 covers the mitigation. Do not let it slide, because the failure
mode is "works on my Mac" — and the daily driver is Windows, the one engine
that is not WebKit.

**Everything depends on undocumented Steam endpoints.** The store search,
appdetails and CDN paths in §6 are public and stable in practice, but none of
them is a contract. Valve owes us nothing and could change any of them. This is
the price of needing no keys, and it is worth paying — but it means the
metadata layer must sit behind one interface with a real fallback path, and a
failed fetch must degrade to *"no artwork yet, retry"* rather than a broken
card. Cache permanently so an outage is invisible to anyone with an existing
library.

**Steam's manifest format is undocumented too.** One parser now reads a private
format, which is a large improvement over five. Golden-file tests against
captured `.acf` and `.vdf` files catch regressions; they cannot prevent
breakage. A failed scan degrades to a visible warning with the manual path
still available, never a crash.

**Games Steam has never heard of.** Epic exclusives, Game Pass titles, console
emulation. The optional keys in §6 cover them, but the first-run experience for
somebody whose library is mostly Game Pass will be worse than for somebody on
Steam. Know that; do not pretend otherwise in the README.

**Anti-cheat.** Some games check their parent process or refuse to run outside
their launcher. Launching Steam titles by URI avoids most of this. Manually
launched executables from other stores may hit it, and there is no general fix.

**Store terms of service.** Reading files a store wrote on the user's own
machine is fine, and so is calling a public endpoint at a human rate. Automating
a store *client*, scraping web pages, or redistributing store assets is not.
Stay on the first side of that line, respect the rate limit, and identify
ourselves honestly in the user agent.

**"It still opens Steam."** Structural, not a bug. Documented in §5.

**Scope creep toward being a store.** Every downloading and installing feature
looks like a small addition to the one before it, and together they are a
different, much larger project. §1 is the line. Move it deliberately or not at
all.

**Scope creep back toward per-store providers.** The other direction, and
subtler: it will be tempting to add Epic "because it is easy", then GOG
"because it is only SQLite", and end up maintaining five undocumented parsers
again. The rule from §5 holds — a store earns a provider only when the manual
flow has proven annoying for it in practice.

## 12. Open decisions
Most of what was open here has been settled: Steam is the only automated
provider, IGDB is out in favour of key-only sources, the repository stays
private, and platforms are no longer sequenced.

What is left:

1. **Name.** "Marquee" is a placeholder. It costs nothing to change now and it
   is unfixable once anyone has installed the thing, so decide before the
   interface starts saying it out loud.

2. **Licence.** Deferred. The repository is private and nothing is published,
   so this only needs answering if and when it goes public. Both sibling
   projects are MIT, which is the obvious default if it ever matters.

3. **Where releases are hosted.** Tied to the licence question and forced by
   the updater, not by the code: a private repository's release assets need a
   token to download, so an over-the-air update needs either a public
   repository, public releases on a private one, or a bucket. Phase 4 lays out
   the three. Nothing depends on it until we want to ship to someone who is not
   us.

*Settled since: the rename UI. It is built -- Rename sits in the game details
screen, edits the title in place where it is shown, and takes the on-screen
keyboard when a pad is what is being held. An empty field restores the
provider's own name, which is the only route back and so could not be a
separate button nobody would find.*

*Settled since: the tuner. Both sibling projects had one, and the plan carried
the question over, but the design here got tuned through `design/tokens.json`
and `pnpm tokens` instead. No tuner was built and none is wanted -- a settings
surface with no user is exactly what §5 says to delete.*
