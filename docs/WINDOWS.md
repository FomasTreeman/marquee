# Building for Windows from a Mac

```bash
tools/build-windows.sh          # release
tools/build-windows.sh debug    # faster, for checking it compiles
```

Produces `src-tauri/target/x86_64-pc-windows-msvc/release/marquee.exe`, around
6 MB. Copy it to a Windows machine and run it — the interface is compiled into
the binary, so nothing else travels with it.

Real releases are built on a Windows runner by `release.yml` and arrive as an
`.msi` and an NSIS `-setup.exe`; this script is for checking a change on the
Windows half of the code before pushing it, from the machine you are sitting
at.

## Setup, once

```bash
rustup target add x86_64-pc-windows-msvc
brew install llvm            # clang-cl, lld-link, llvm-rc — about 1.5 GB
cargo install cargo-xwin
```

`cargo-xwin` downloads Microsoft's CRT and SDK headers on first use and caches
them, so the first build is slower than the ~2 minutes it takes afterwards.

Note that Homebrew's `llvm` does **not** include `lld-link`, and it is not
needed: the linker is `rust-lld`, which ships with the Rust toolchain. The
script's first version checked for `lld-link` and refused to run — a
precondition stricter than reality, blocking a build that worked.

Homebrew keeps LLVM out of the default `PATH` because it shadows Apple's clang.
The script adds it; if you run `cargo xwin` by hand, do the same.

## What this does and does not give you

**Does:** a working executable, with the frontend embedded, that runs on Windows
10 and 11. Every dependency cross-compiles cleanly — including bundled SQLite,
which is C, and the WebView2 bindings.

**Does not:**

- **An installer.** Tauri's MSI and NSIS bundlers need Windows tooling. This is
  a bare `.exe`, which is what you want for testing anyway.
- **A signature.** Unsigned binaries get a SmartScreen warning: *More info →
  Run anyway*. Signing needs a certificate; see "Still open" in
  [UPDATES.md](UPDATES.md).
- **A substitute for testing on Windows.** It proves the code *compiles*, not
  that it *works*. The three webview engines are the defining risk of this
  stack (see [PLAN.md](PLAN.md) §3) and a cross-compiler has no opinion about
  how WebView2 renders anything.

## When it does not work, read the log

The Rust half writes a log before the window has drawn anything, so a window
that fails to load still leaves a record:

```
%LOCALAPPDATA%\Marquee\logs\marquee.log
```

Open it in Notepad. A healthy start looks like this, and the last two lines only
appear if the interface actually loaded:

```
INFO  start  Marquee 0.0.1 · WebView2 (Chromium) · windows/x86_64 · log ...
INFO  boot   window up
INFO  scan   215 games in 4 ms (steam=ok manual=ok)
INFO  boot   ready in 130 ms · 215 games · shell=tauri
INFO  selfcheck 20 checks passed
```

If `boot window up` is there but nothing after it, the Rust side started and
the interface did not — that is a frontend or packaging problem, and the
"localhost refused to connect" case below is the one that has actually happened.

## "localhost refused to connect"

The binary was built as a **dev** build and is trying to reach a dev server that
is not running.

Tauri decides between the dev server and its embedded interface from a cargo
feature — `dev = !custom-protocol`, in tauri's own `build.rs` — **not** from the
build profile. A `--release` binary without that feature is still a dev binary.

`Cargo.toml` needs:

```toml
[features]
default = ["custom-protocol"]
custom-protocol = ["tauri/custom-protocol"]
```

It is on by default so any ordinary `cargo build` produces a real application,
and `tauri dev` disables it for itself with `--no-default-features`.

This shipped once, and nothing about the binary looked wrong: right size, right
architecture, frontend embedded, newer than the frontend. Every check the build
script had passed. `tools/build-windows.sh` now refuses to build a release
without the feature, and that guard was verified by removing the feature and
watching it fire.

## A controller that does not work

Start from what the backend actually is. gilrs enables its `wgi` backend by
default, not `xinput` — check `gilrs-core/Cargo.toml` if you doubt it. That
backend is **Windows.Gaming.Input**, and it enumerates through
`RawGameController`, which sees *any* HID game controller. A DualSense plugged
straight in is visible to it. So is a Steam Deck's built-in pad, and so is a
Razer or 8BitDo dongle.

An earlier version of this section said the opposite — XInput, Xbox pads
only, PlayStation needs DS4Windows — and Settings repeated it, so the app
confidently sent people off installing drivers they did not need. A wrong
diagnosis in a document is worse than no document; check the dependency's
source before writing down what it does.

Which leaves the real question: why would a pad not appear?

**The likeliest answer is that the input thread died.** gilrs registers its
WinRT event handlers with `.unwrap()`, so a refusal anywhere in that stack
arrives as a panic rather than an `Err`. A panic in a spawned thread kills that
thread alone, prints to a stderr nobody is reading, and leaves the app running
perfectly — with no gamepad and nothing in the log. From the sofa that is
identical to an unplugged controller.

`input.rs` now catches that panic and records it. If it happens you will see:

```
ERROR input  the gamepad thread stopped: <message>. Windows.Gaming.Input is
             unavailable, so the interface is keyboard and mouse only.
```

**And there is now a second route.** `src/webpad.ts` drives the pad through the
webview's own Gamepad API — a completely independent code path, since WebView2
is Chromium and its gamepad layer reads XInput, raw HID and DirectInput, with
specific support for DualShock and DualSense. It arms itself only after the
native path has visibly failed to find anything, so the two can never both fire
(a doubled A launches a game twice). When it takes over, Settings says so.

The log records the backend and every device it enumerates:

```
INFO  input  Xbox Wireless Controller — SDL mapping, connected (via Windows.Gaming.Input)
WARN  input  no gamepad after 3s. Windows.Gaming.Input started and enumerated nothing.
INFO  input  native gamepad path reported nothing; the webview is driving the pad instead
```

Settings → Controller shows the same thing without needing the file: the
backend, every device it saw, and anything the webview can see that it could
not. That distinction is the whole diagnosis — "nothing enumerated" and
"enumerated but unmapped" feel identical and have nothing in common.

## "Some buttons work and some do nothing"

**Settings → Controller → Test a controller.** Press each button in turn and
watch what arrives:

```
pad       lb
pad       a
unmapped  Unknown (12)   <- this is why that button does nothing
keyboard  sort
```

A pad whose buttons arrive under names Marquee does not recognise behaves
*exactly* like a pad that sends nothing, and no device list separates the two —
but one is a two-line fix to `button_action` in `src-tauri/src/input.rs` and the
other is a driver problem. The `unmapped` lines are the interesting ones: they
carry the raw button name and code, which is all that is needed to add it.

The keyboard shows up here too, deliberately. It is the control case: if
pressing O prints `keyboard sort` and pressing L1 prints nothing at all, the
pad is not reaching the app; if L1 prints an `unmapped` line, it is.

Two things this already caught:

- **The triggers did nothing.** gilrs names these confusingly — `LeftTrigger`
  is the *bumper* (L1/LB) and `LeftTrigger2` is the analogue trigger (L2/LT).
  Only the bumpers were mapped, so pulling a trigger was silently ignored.
  Both now page the library.
- **A pad with no standard mapping was being read as though it had one.** The
  webview path indexes buttons by the W3C standard layout; Chromium reports
  `mapping: ""` for a device it cannot recognise and returns buttons in
  whatever order the device chose. Reading index 4 as a bumper there is a
  guess, and a guess gives you a pad where some buttons do the *wrong* thing,
  which is worse than one that does nothing. Such a pad is now ignored by that
  path and says so in the log.

The three-second delay before complaining is deliberate: gilrs enumerates
before the platform has finished reporting devices, so a connected pad shows as
absent for a few milliseconds. Warning immediately produced `no gamepad seen`
followed 11 ms later by `gamepad connected`, which is worse than saying nothing.

A wireless pad is also genuinely invisible until it has something to say. Press
a button before deciding it is broken.

## The target machine needs the WebView2 runtime

Windows 11 ships it. Windows 10 has it through Edge on any current install. If
the window opens blank or the app refuses to start, that is the first thing to
check — Microsoft distributes an Evergreen Bootstrapper for it.

## The stale-build trap

The first working version of this shipped a binary containing the **previous**
interface, and reported success.

`generate_context!` compiles the built frontend into the executable, but nothing
told cargo that the frontend was an input. So `pnpm build` followed by a cargo
build produced a binary with the old interface embedded, in 0.2 seconds, looking
exactly like a fresh one. It was caught by checking the asset hash inside the
executable and finding a hash from thirteen hours earlier.

Two things now prevent it. `build.rs` declares every file under `frontendDist`
as a dependency — recursively, because changing a file's contents does not touch
the mtime of the directories above it — and the build script refuses to finish
if anything in `dist/` is newer than the executable.

That second check is by **timestamp**, not by looking for the asset name inside
the binary. Tauri compresses the embedded files, so a hashed filename never
appears in plaintext; the content check was written first and rejected a
perfectly good build.

## It already caught something

The first cross-build produced a warning that no amount of work on macOS would
have: an import used only on the non-Windows path of `screen.rs`, unused once
the Windows branch was compiled instead. CI builds on a real Windows runner
with `-D warnings`, so that would have been a red build — found here in two
minutes instead.

**That is the real argument for this**: a two-minute local check of the half of
the codebase that macOS never compiles. Run it before pushing anything with
`#[cfg]` in it.
