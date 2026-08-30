#!/usr/bin/env bash
#
# Build a Windows executable from macOS or Linux.
#
# Cross-compiles with cargo-xwin, which downloads Microsoft's CRT and SDK
# headers and links them with LLVM's clang-cl and lld-link. No Windows machine,
# no virtual machine.
#
# What this produces is a bare .exe, not an installer -- see docs/WINDOWS.md for
# why, and for what the target machine needs.

set -euo pipefail

TARGET=x86_64-pc-windows-msvc
PROFILE=${1:-release}

# Homebrew keeps LLVM out of the default PATH because it shadows Apple's clang.
if [ -d /opt/homebrew/opt/llvm/bin ]; then
  export PATH="/opt/homebrew/opt/llvm/bin:$PATH"
fi

# clang-cl compiles and llvm-rc builds the Windows resource. The *linker* is
# rust-lld, which ships with the Rust toolchain -- Homebrew's llvm formula does
# not include lld-link, and requiring it blocks a build that works perfectly.
for tool in clang-cl llvm-rc; do
  command -v "$tool" >/dev/null || {
    echo "error: $tool not found. Install LLVM:  brew install llvm" >&2
    exit 1
  }
done
command -v cargo-xwin >/dev/null || {
  echo "error: cargo-xwin not found.  cargo install cargo-xwin" >&2
  exit 1
}
rustup target list --installed | grep -qx "$TARGET" || {
  echo "error: target missing.  rustup target add $TARGET" >&2
  exit 1
}

# The frontend is embedded into the binary at compile time, so it has to exist
# and has to be current. Building it here rather than assuming means the exe can
# never ship a stale interface.
echo "==> building the frontend"
pnpm build

echo "==> cross-compiling for Windows ($PROFILE)"
cd src-tauri
if [ "$PROFILE" = "release" ]; then
  cargo xwin build --release --target "$TARGET"
else
  cargo xwin build --target "$TARGET"
fi

EXE="target/$TARGET/$PROFILE/marquee.exe"

# Verify the binary is newer than the interface inside it.
#
# This is not paranoia. Cargo had no idea the frontend was an input, so
# rebuilding it and then building the crate produced a binary carrying the
# *previous* interface -- and reported success. build.rs now declares every
# frontend file as a dependency; this confirms it worked, because a silently
# stale build is worse than a failed one.
#
# By timestamp rather than by looking for the asset name inside the executable:
# Tauri compresses the embedded files, so a hashed filename never appears in
# plaintext and searching for one fails on a perfectly good build. That check
# was written first and rejected this exact binary.
NEWEST_ASSET=$(find ../dist -type f -newer "$EXE" -print -quit 2>/dev/null || true)
if [ -n "$NEWEST_ASSET" ]; then
  echo "error: $NEWEST_ASSET is newer than the executable -- the embedded interface is stale." >&2
  echo "       Try: cargo clean -p marquee && $0 $PROFILE" >&2
  exit 1
fi

echo
echo "==> $(cd .. && pwd)/src-tauri/$EXE"
ls -la "$EXE" | awk '{printf "    %.1f MB\n", $5/1048576}'
echo "    interface: $(basename "$(ls ../dist/assets/*.js | head -1)")"
echo "    Copy it to a Windows machine and run it. Nothing else is needed."
