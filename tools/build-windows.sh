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

for tool in clang-cl lld-link llvm-rc; do
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
echo
echo "==> $(cd .. && pwd)/src-tauri/$EXE"
ls -la "$EXE" | awk '{printf "    %.1f MB\n", $5/1048576}'
echo "    Copy it to a Windows machine and run it. Nothing else is needed."
