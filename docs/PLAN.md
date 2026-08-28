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
### Steam is automated. Everything else is a path to an executable.

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
`appmanifest_*.acf` in each. Plain-text VDF, needs a parser of roughly 150
lines, and — importantly — **the format is identical on Windows, macOS and
Linux.** Only the base path differs. Launch by `steam://rungameid/<appid>`.

**Manual** is our own table. Title, executable, working directory, arguments,
art. Launch by spawning the process.

### What that deletes

The original plan had a five-tier difficulty table ending in EA's
hardware-key-encrypted catalogue file, which Playnite reverse-engineers and
which breaks whenever EA changes the derivation. Also GOG's undocumented SQLite
schema, Battle.net's protobuf `product.db`, Ubisoft's registry keys, and the
Windows-only package APIs behind Xbox.

All of it is gone. Not deferred — **gone from the roadmap.** With it goes every
Windows-only code path in the library layer, which is most of why §7 no longer
needs to sequence platforms.

### What it costs, honestly

Three things, and none of them are dealbreakers:

**1. Adding games is manual work, once per game.** Fifteen seconds each. For a
library of thirty non-Steam games that is under ten minutes, one time. This is
the trade and it is a good one.

**2. An executable has no identity.** This is the real cost, and it is a UI
problem rather than a plumbing one. `bf2042.exe` is not a title, so the
add-a-game flow needs a matching step: pick the executable → guess a title from
the folder and file name → search the metadata sources → **the user picks the
right game from a short list** → art and metadata attach. That overlay is new
work that did not exist when every game arrived with a store ID. It is one
screen, and the prototype already has the overlay patterns for it.

Make the guess good. Folder name beats executable name almost always
(`.../Cyberpunk 2077/bin/x64/Cyberpunk2077.exe`), and stripping the usual
`bin`, `x64`, `retail`, `Binaries`, `Win64` segments gets you most of the way.

**3. Some executables are launcher stubs.** Starting an EA or Ubisoft game
directly will often bootstrap that store's client anyway, and a few titles
refuse to run without it. That is the same visible handoff as the Steam case
below, not a new problem — but it is not magic either.

### One thing it makes *better*

Playtime. When we spawn the executable ourselves we own the child process and
can time the session exactly. With the Steam URI handoff our child exits
immediately and the game is Steam's, so Steam playtime needs process-name
watching or reading Steam's own records. The manual path is the accurate one.

### The Steam caveat that does not go away

Launching a Steam game opens Steam. We are a frontend, not a replacement, and
on a television that is visible. Detect the child and cover the handoff, but do
not pretend it is solved. Put it in the README.

### Leaving the door open

The provider trait means adding Epic later is **additive, not a rewrite** — a
new module, a registry entry, done. Epic in particular is nearly free: plain
JSON manifests in `Data/Manifests/*.item`, maybe a hundred lines. If the manual
flow proves annoying for a store with a lot of games, that store gets a
provider. The architecture does not need to change for it, which is precisely
why it is safe to not build it now.

## 6. Metadata and art
### IGDB is out

IGDB requires a Twitch client secret, and a client secret cannot ship inside a
distributed desktop application — it violates the developer agreement, and an
app access token is a password. IGDB only accepts app access tokens. Using it
would mean running a proxy server to hold the secret.

There is no need to. Three sources cover everything, and **not one of them
requires a secret or any server-side infrastructure.**

### The stack

**1. Steam Store API** — `store.steampowered.com/api/appdetails?appids=<id>`.
**No API key at all.** Descriptions, genres, developer, publisher, release date,
Metacritic score, screenshots. Rate-limited to roughly 200 requests per five
minutes, which matters only on a first scan and is trivially handled with a
queue and a cache. This is a different host from `api.steampowered.com`, which
does need a key — we do not use that one.

For Steam games, this is the whole answer.

**2. Steam's public CDN** — no key, no auth:
   - `library_600x900.jpg` — portrait cover
   - `library_hero.jpg` — wide key art for the backdrop
   - `logo.png` — **transparent wordmark**

   The prototype already proves the design works on exactly these three assets,
   and they exist for a large fraction of any library — including many games
   bought elsewhere, because Steam has a page for them regardless.

**3. SteamGridDB** — grids, heroes, logos and icons for everything the CDN does
not have. API key is generated from a profile page, free, per-user, **no
secret.** This is what makes a manually-added GOG game look as good as a Steam
one, and given §5 it is now load-bearing rather than a nicety.

**4. RAWG** — descriptions, genres, release dates and Metacritic scores for
non-Steam games. Free key from `rawg.io/apidocs`, again **a plain key with no
secret**, 20,000 requests a month. That is generous for a personal library
provided we cache and never re-fetch, and it is nowhere near enough to be
careless with.

Two conditions attach to RAWG and both are easy: attribution is required
wherever their data appears, so the detail view carries a discreet source line;
and the free tier is bounded by monthly active users, which a private tool
never approaches.

**5. Manual override**, always. Any user-supplied title, description or image
wins over every source above and is never overwritten by a rescan.

### The property to protect

**The app must look finished with no keys entered at all.** Steam appdetails
and the Steam CDN need nothing, and between them they cover the automated half
of the library completely. SteamGridDB and RAWG keys improve coverage for
manually-added games; they are never a gate on first run, and the settings
screen should say so rather than presenting two empty fields on a wizard.

### Keep it swappable

RAWG is the practical choice, not the best-curated database — IGDB's data is
better maintained. Keep the metadata layer behind one interface so that if this
ever goes public and a proxy becomes worth running, IGDB slots in as a source
rather than a rewrite.

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
| Steam library path | `Program Files (x86)\\Steam` + registry | `~/Library/Application Support/Steam` | `~/.steam/steam`, `~/.local/share/Steam` |
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

### Phase 0 — Spike (target: one week)

The purpose is to kill the project cheaply if it deserves to die.

- Tauri v2 shell building and running on Windows, macOS and Linux.
- The prototype's CSS rendering on all three, with a written verdict on every
  dangerous property.
- `gilrs` → webview action stream, measured under 50 ms.
- **A grid of 2,000 placeholder cards scrolling at refresh rate.**

**Exit:** all four demonstrated, on all three, with numbers written down. If
the grid cannot hold frame rate in a webview, the stack choice was wrong and
this is the cheapest possible moment to find that out.

### Phase 1 — Skeleton

Rust core, SQLite with migrations, the two providers from §5: **Steam** and
**manual**. Launch by `steam://` and by process spawn respectively. The ported
prototype UI running on real data.

**Exit:** the app finds the real Steam library, shows it in the real design, and
launches a game with a controller. A hand-added executable does the same.

### Phase 2 — Art, metadata, and the add-a-game flow

Steam appdetails and CDN (no keys), SteamGridDB and RAWG (BYO keys). Ingest
resizing, content-addressed cache, manual override.

Plus the matching overlay from §5 — pick an executable, guess a title, search,
choose from a short list, attach art. Under this scope that flow is not a side
feature; **it is how most of the library gets in.** Budget for it accordingly
and make the guess good.

**Exit:** a 2,000-game library looks like the prototype and meets every
performance budget in §2 with real images. Adding a non-Steam game takes under
fifteen seconds and lands the right art without typing a full title.

### Phase 3 — Big-screen behaviour

The unglamorous list that decides whether it is actually usable on a TV:
fullscreen and exclusive mode, first-run without a mouse, gamepad wake,
inhibiting the screensaver, returning to the launcher when a game exits,
detecting a game that failed to start, settings, and theming.

**Exit:** a full session — boot, browse, launch, play, exit, sleep, wake —
without touching a keyboard.

### Phase 4 — Release engineering

Deferred while the project is private, but the work is known: Windows code
signing (or SmartScreen will scare off most users), macOS notarization (needs a
paid Apple Developer account), Linux packaging (AppImage plus Flatpak), Tauri's
signed updater, crash reporting.

**Exit:** somebody who is not us installs it, on a machine we have never
touched, without instructions.

## 11. Risks and caveats
For whoever picks this up later, including us in six months.

**Three webview engines.** The defining risk, and the one the scope decision did
not shrink. §3 covers the mitigation. Do not let it slide, because the failure
mode is "works on my Mac" — and the daily driver is Windows, the one engine
that is not WebKit.

**Steam's manifest format is undocumented.** Only one parser now reads a private
format, which is a large improvement over five, but Valve still owes us nothing.
Golden-file tests against captured `.acf` and `.vdf` files catch regressions;
they cannot prevent breakage. A failed Steam scan must degrade to a visible
warning with the manual path still available, never a crash.

**Match quality is the new failure mode.** With most of the library added by
hand, a bad title guess or a wrong metadata match is the thing that will
actually annoy a user day to day. It replaces "EA integration broke" as the
top support issue. Treat the matching overlay as a first-class surface, not
plumbing, and always allow a manual search and a manual art override.

**RAWG's free tier is 20,000 requests a month** and attribution is required.
Fine for a personal library, but only if the cache is genuinely permanent and
nothing re-fetches on a rescan. Get that right early; it is painful to retrofit.

**Anti-cheat.** Some games check their parent process or refuse to run outside
their launcher. Launching Steam titles by URI avoids most of this. Manually
launched executables from other stores may hit it, and there is no general fix.

**Store terms of service.** Reading files a store wrote on the user's own
machine is fine. Automating a store client, scraping web pages, or
redistributing store assets is not. Stay on the first side of that line and
never scrape when an API exists.

**"It still opens Steam."** Structural, not a bug. Documented in §5.

**Scope creep toward being a store.** Every downloading and installing feature
looks like a small addition to the one before it, and together they are a
different, much larger project. §1 is the line. Move it deliberately or not at
all.

**Scope creep back toward per-store providers.** The other direction, and
subtler: it will be tempting to add Epic "because it is easy", then GOG
"because it is only SQLite", and end up maintaining five undocumented parsers
again. The rule from §5 holds — a store earns a provider only when the manual
flow has proven annoying for it in practice, not in anticipation.

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

3. **How much of the tuner survives.** `tuner.js` and `presets.js` are how the
   design got tuned in the first place and they are genuinely useful, but they
   are also a whole settings surface with no user. Ship them behind a dev flag
   in Phase 1 and decide in Phase 3 whether any of it should be user-facing.
