#!/usr/bin/env bash
#
# Cross-compile a bare Windows .exe from macOS or Linux with cargo-xwin, and
# lint the Windows target. Not an installer: see docs/WINDOWS.md.

set -euo pipefail
cd "$(dirname "$0")/.."

TARGET=x86_64-pc-windows-msvc
PROFILE=${1:-release}

# Homebrew keeps LLVM out of the default PATH because it shadows Apple's clang.
if [ -d /opt/homebrew/opt/llvm/bin ]; then
  export PATH="/opt/homebrew/opt/llvm/bin:$PATH"
fi

# Linking uses rust-lld from the Rust toolchain; Homebrew's llvm lacks lld-link.
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

# The frontend is embedded at compile time, so build it fresh every time.
echo "==> checking for unexplained discarded failures"
tools/check-silence.sh

echo "==> building the frontend"
pnpm build

echo "==> cross-compiling for Windows ($PROFILE)"
cd src-tauri

# Clippy on macOS never sees the Windows-only #[cfg(target_os)] code, which
# CI lints with -D warnings.
if [ "$PROFILE" = "release" ]; then
  echo "    linting the Windows target"
  cargo xwin clippy --release --target "$TARGET" --all-targets -- -D warnings
fi

# Tauri picks dev mode from the `custom-protocol` feature, not the profile.
# Without it a release binary loads localhost:1420; one shipped like that.
if [ "$PROFILE" = "release" ]; then
  if ! cargo tree --target "$TARGET" -e features -i tauri 2>/dev/null \
       | grep -q 'tauri feature "custom-protocol"'; then
    echo "error: tauri's custom-protocol feature is not enabled." >&2
    echo "       Without it this builds a dev binary that expects a dev server." >&2
    echo "       Cargo.toml needs:  [features] default = [\"custom-protocol\"]" >&2
    exit 1
  fi
fi
if [ "$PROFILE" = "release" ]; then
  cargo xwin build --release --target "$TARGET"
else
  cargo xwin build --target "$TARGET"
fi

EXE="target/$TARGET/$PROFILE/marquee.exe"

# The binary must be newer than the frontend inside it; a stale embedded
# interface once built with no error. Timestamps, because Tauri compresses
# embedded assets so their names never appear in the executable.
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
