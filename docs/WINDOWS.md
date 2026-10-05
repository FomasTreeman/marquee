# Building for Windows from a Mac

```bash
tools/build-windows.sh          # release
tools/build-windows.sh debug    # faster, for checking it compiles
```

This produces `src-tauri/target/x86_64-pc-windows-msvc/release/marquee.exe`,
about 6 MB, with the interface compiled in. Copy it to Windows and run it.
Real releases are built on a Windows runner by `release.yml`.

Run the script before pushing anything with `#[cfg]` in it: code that only
Windows compiles can fail CI's `-D warnings` while macOS stays clean.

## Setup, once

```bash
rustup target add x86_64-pc-windows-msvc
brew install llvm            # clang-cl, lld-link, llvm-rc, about 1.5 GB
cargo install cargo-xwin
```

`cargo-xwin` downloads and caches Microsoft's CRT and SDK headers on first use.
Later builds take about two minutes. Homebrew's `llvm` has no `lld-link`, and
none is needed: the linker is `rust-lld` from the Rust toolchain. Homebrew
keeps LLVM off `PATH`; the script adds it, so do the same if you run
`cargo xwin` by hand.

## What you get

A Windows 10 and 11 executable with the frontend embedded. Every dependency
cross-compiles, including bundled SQLite and the WebView2 bindings. You do not
get:

- **An installer.** Tauri's MSI and NSIS bundlers need Windows.
- **A signature.** SmartScreen warns: *More info → Run anyway*. See "Still
  open" in [UPDATES.md](UPDATES.md).
- **Proof that it works.** How WebView2 renders is the main risk of this stack
  ([PLAN.md](PLAN.md) §3), and only running it on Windows tests that.

## Read the log first

Rust writes the log before the window draws, at
`%LOCALAPPDATA%\Marquee\logs\marquee.log`. A healthy start:

```
INFO  start  Marquee 0.0.1 · WebView2 (Chromium) · windows/x86_64 · log ...
INFO  boot   window up
INFO  scan   215 games in 4 ms (steam=ok manual=ok)
INFO  boot   ready in 130 ms · 215 games · shell=tauri
INFO  selfcheck 20 checks passed
```

If `boot window up` is the last line, Rust started and the interface did not:
a frontend or packaging problem, most likely the next one. If the window is
blank or the app will not start, check for the WebView2 runtime. Windows 11
ships it, Windows 10 has it through Edge, and Microsoft distributes an
Evergreen Bootstrapper.

## "localhost refused to connect"

The binary is a **dev** build looking for a dev server. Tauri chooses between
the dev server and the embedded interface from a cargo feature,
`dev = !custom-protocol`, not from the build profile. A `--release` binary
without the feature is still a dev binary. `Cargo.toml` needs:

```toml
[features]
default = ["custom-protocol"]
custom-protocol = ["tauri/custom-protocol"]
```

It is on by default so any `cargo build` produces a real application; `tauri
dev` turns it off with `--no-default-features`. `tools/build-windows.sh`
refuses to build a release without it.

## The controller does not work

gilrs uses its `wgi` backend, **Windows.Gaming.Input**, which sees any HID game
controller: Xbox, DualSense, a Steam Deck's pad, Razer or 8BitDo dongles. No
extra driver is needed.

**The likeliest cause is that the input thread died.** gilrs registers its
WinRT handlers with `.unwrap()`, so a failure there panics the thread and
leaves the app running with no pad. `input.rs` catches the panic and logs:

```
ERROR input  the gamepad thread stopped: <message>. Windows.Gaming.Input is
             unavailable, so the interface is keyboard and mouse only.
```

**There is a fallback.** `src/webpad.ts` reads the pad through WebView2's
Gamepad API, which handles XInput, raw HID, DirectInput, DualShock and
DualSense. It arms only after the native path has found nothing, so the two
never both fire. Settings says when it has taken over. The log records each
step:

```
INFO  input  Xbox Wireless Controller — SDL mapping, connected (via Windows.Gaming.Input)
WARN  input  no gamepad after 3s. Windows.Gaming.Input started and enumerated nothing.
INFO  input  native gamepad path reported nothing; the webview is driving the pad instead
```

**Settings → Controller** shows the backend, every device it saw, and anything
the webview sees that the backend did not. The warning waits three seconds
because gilrs enumerates before Windows has finished reporting devices. A
wireless pad is invisible until it sends something, so press a button first.

## Some buttons do nothing

**Settings → Controller → Test a controller.** Press each button:

```
pad       lb
pad       a
unmapped  Unknown (12)   <- this is why that button does nothing
keyboard  sort
```

An `unmapped` line gives the raw button name and code; add it to
`button_action` in `src-tauri/src/input.rs`. A button that prints nothing is
not reaching the app, which is a driver problem. The keyboard is the control:
if **O** prints `keyboard sort` and L1 prints nothing, the pad is not reaching
the app.

- gilrs calls the bumper (L1/LB) `LeftTrigger` and the analogue trigger
  (L2/LT) `LeftTrigger2`. Both page the library.
- The webview path ignores a pad Chromium reports with `mapping: ""`, and logs
  it, because its button order is unknown.

## Stale frontend in the binary

`generate_context!` compiles the built frontend into the executable, and cargo
once did not know the frontend was an input, so a rebuild embedded the old
interface. `build.rs` now declares every file under `frontendDist` as a
dependency, recursively, because editing a file does not change its parent
directories' mtime. The build script also refuses to finish if anything in
`dist/` is newer than the executable. It compares timestamps because Tauri
compresses embedded files, so asset names never appear in the binary.
