#!/usr/bin/env bash
#
# Fail when a failure is discarded without a stated reason: an empty catch in
# TypeScript or the board scripts, `let _ =` on a disk call in Rust, or
# `|| true`, `2>/dev/null` or `continue-on-error` in a workflow. A comment above
# is enough. Run by `pnpm test` and tools/build-windows.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
report() { printf '  %s\n    %s\n' "$1" "$2"; fail=1; }

# --- TypeScript and the board scripts: a catch with nothing in it --------
while IFS=: read -r file line text; do
  [ -z "${file:-}" ] && continue
  prev=$(sed -n "$((line - 1))p" "$file" | sed 's/^ *//')
  case "$prev" in //*) continue ;; esac
  report "$file:$line" "$(echo "$text" | sed 's/^ *//')"
done < <(find src .github/scripts -name '*.ts' -o -name '*.mjs' \
         | xargs grep -nE 'catch *(\([^)]*\))? *\{ *\}|\.catch\(\(\) *=> *\{ *\}\)' || true)

# --- Rust: a discarded Result from a call that touches the disk ----------
# Test code is exempt.
for f in src-tauri/src/*.rs src-tauri/src/*/*.rs; do
  while IFS=: read -r line text; do
    [ -z "${line:-}" ] && continue
    prev=$(sed -n "$((line - 1))p" "$f" | sed 's/^ *//')
    case "$prev" in //*) continue ;; esac
    report "$f:$line" "$(echo "$text" | sed 's/^ *//')"
  done < <(sed '/^#\[cfg(test)\]/,$d' "$f" \
    | grep -nE 'let _ = (std::fs::|paths::ensure|serde_json::to_(string|writer))' || true)
done

# --- Workflows: a discarded failure in the automation itself ------------
# A comment anywhere in the same paragraph counts, since a pipeline spans
# several lines. The search stops at `run:` so a step's header comment cannot
# excuse every discard inside it; an unbounded search once passed a hidden
# `|| true` on a refused label write.
explained() {   # file, line, whether to stop at the run: boundary
  local f=$1 n=$2 bounded=$3 cur
  while [ "$n" -gt 1 ]; do
    n=$((n - 1))
    cur=$(sed -n "${n}p" "$f" | sed 's/^ *//')
    [ -z "$cur" ] && return 1                       # blank: end of paragraph
    case "$cur" in '#'*) return 0 ;; esac
    if [ "$bounded" = yes ]; then
      case "$cur" in run:*|'- '*) return 1 ;; esac
    fi
  done
  return 1
}

for f in .github/workflows/*.yml; do
  while IFS=: read -r line text; do
    [ -z "${line:-}" ] && continue
    case "$text" in *'#'*) continue ;; esac        # a trailing comment counts
    explained "$f" "$line" yes && continue
    report "$f:$line" "$(echo "$text" | sed 's/^ *//')"
  done < <(grep -nE '\|\| true|2>/dev/null' "$f" || true)

  # `continue-on-error` is a step key, so its reason goes above the `- name:`.
  while IFS=: read -r line text; do
    [ -z "${line:-}" ] && continue
    explained "$f" "$line" no && continue
    report "$f:$line" "$(echo "$text" | sed 's/^ *//')"
  done < <(grep -nE 'continue-on-error: *true' "$f" || true)
done

if [ "$fail" -ne 0 ]; then
  echo
  echo "A discarded failure needs either a log line or a comment saying why not."
  echo "See tools/check-silence.sh."
  exit 1
fi
echo "check-silence: no unexplained discards"
