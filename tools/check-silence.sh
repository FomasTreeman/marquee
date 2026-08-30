#!/usr/bin/env bash
#
# Fail the build on a failure that is discarded without saying so.
#
# Every hard bug in this project has been silent: a clipped focus ring, an
# invisible cover, a dev build, a stale frontend. `catch {}` and `let _ =` are
# how the next one gets written. Neither is banned -- plenty of failures really
# are survivable -- but the reason has to be on the page, either as a log call
# or as a comment saying why nobody needs to know.
#
# Run by `pnpm test` and by tools/build-windows.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
report() { printf '  %s\n    %s\n' "$1" "$2"; fail=1; }

# --- TypeScript: a catch block with nothing at all in it -----------------
while IFS=: read -r file line text; do
  [ -z "${file:-}" ] && continue
  report "$file:$line" "$(echo "$text" | sed 's/^ *//')"
done < <(grep -rnE 'catch *(\([^)]*\))? *\{ *\}' src/*.ts || true)

# --- Rust: a discarded Result from a call that touches the disk ----------
# Test code is exempt: a temp directory that fails to delete is not a bug the
# user will ever see.
for f in src-tauri/src/*.rs; do
  while IFS=: read -r line text; do
    [ -z "${line:-}" ] && continue
    # A comment on the line above counts as the stated reason.
    prev=$(sed -n "$((line - 1))p" "$f" | sed 's/^ *//')
    case "$prev" in //*) continue ;; esac
    report "$f:$line" "$(echo "$text" | sed 's/^ *//')"
  done < <(sed '/^#\[cfg(test)\]/,$d' "$f" \
    | grep -nE 'let _ = (std::fs::|paths::ensure|serde_json::to_(string|writer))' || true)
done

if [ "$fail" -ne 0 ]; then
  echo
  echo "A discarded failure needs either a log line or a comment saying why not."
  echo "See tools/check-silence.sh."
  exit 1
fi
echo "check-silence: no unexplained discards"
