# Building for Windows from a Mac

```bash
tools/build-windows.sh          # release
tools/build-windows.sh debug    # faster, for checking it compiles
```

Produces `src-tauri/target/x86_64-pc-windows-msvc/release/marquee.exe`, around
6 MB. Copy it to a Windows machine and run it — the interface is compiled into
the binary, so nothing else travels with it.

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
  Run anyway*. Signing needs a certificate and is a Phase 4 problem.
- **A substitute for testing on Windows.** It proves the code *compiles*, not
  that it *works*. The three webview engines are the defining risk of this
  stack (see [PLAN.md](PLAN.md) §3) and a cross-compiler has no opinion about
  how WebView2 renders anything.

## The target machine needs the WebView2 runtime

Windows 11 ships it. Windows 10 has it through Edge on any current install. If
the window opens blank or the app refuses to start, that is the first thing to
check — Microsoft distributes an Evergreen Bootstrapper for it.

## It already caught something

The first cross-build produced a warning that no amount of work on macOS would
have: an import used only on the non-Windows path of `screen.rs`, unused once
the Windows branch was compiled instead. CI builds on a real Windows runner
with `-D warnings`, so that would have been a red build — found here in two
minutes instead.

**That is the real argument for this**: a two-minute local check of the half of
the codebase that macOS never compiles. Run it before pushing anything with
`#[cfg]` in it.
