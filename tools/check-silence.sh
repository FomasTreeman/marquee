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

# --- TypeScript and the board scripts: a catch with nothing in it --------
# Both the `catch {}` block and the `.catch(() => {})` handler, since a
# promise chain is where most of the frontend's failures arrive. The board
# scripts count too: the automation is where the silence rule was skipped
# first and where it cost the most (see below).
while IFS=: read -r file line text; do
  [ -z "${file:-}" ] && continue
  # A comment on the line above counts as the stated reason, same as Rust.
  prev=$(sed -n "$((line - 1))p" "$file" | sed 's/^ *//')
  case "$prev" in //*) continue ;; esac
  report "$file:$line" "$(echo "$text" | sed 's/^ *//')"
done < <(find src .github/scripts -name '*.ts' -o -name '*.mjs' \
         | xargs grep -nE 'catch *(\([^)]*\))? *\{ *\}|\.catch\(\(\) *=> *\{ *\}\)' || true)

# --- Rust: a discarded Result from a call that touches the disk ----------
# Test code is exempt: a temp directory that fails to delete is not a bug the
# user will ever see.
for f in src-tauri/src/*.rs src-tauri/src/*/*.rs; do
  while IFS=: read -r line text; do
    [ -z "${line:-}" ] && continue
    # A comment on the line above counts as the stated reason.
    prev=$(sed -n "$((line - 1))p" "$f" | sed 's/^ *//')
    case "$prev" in //*) continue ;; esac
    report "$f:$line" "$(echo "$text" | sed 's/^ *//')"
  done < <(sed '/^#\[cfg(test)\]/,$d' "$f" \
    | grep -nE 'let _ = (std::fs::|paths::ensure|serde_json::to_(string|writer))' || true)
done

# --- Workflows: a discarded failure in the automation itself ------------
# The rule did not used to apply here, and the automation collected exactly
# what the rule exists to stop. `gh issue edit ... || true` in claude.yml hid a
# label write that was being refused every single run -- the token in front of
# it could not write labels at all -- so the board silently stopped matching
# what was happening. Nothing failed anywhere.
#
# `|| true` and `2>/dev/null` and `continue-on-error` all stay allowed. The
# comment on the line above is the price, same as in Rust.
#
# Where the reason has to be is looser than in Rust, because the thing being
# excused is rarely on the line that needs excusing: a shell pipeline runs
# across four continuations. So the search walks up from the match to the blank
# line above it -- the paragraph the statement is in -- and a comment anywhere
# in that paragraph counts.
#
# It walks up no further than the `run:` that opened the script, though, and
# that boundary is the point. Without it a step whose *header* comment explains
# why it exists silently excuses every discard inside it, which is how the
# first version of this check passed the exact bug it was written for: the
# `|| true` hiding a refused label write sat in a step introduced by three
# paragraphs about something else entirely.
explained() {   # file, line, whether to stop at the run: boundary
  local f=$1 n=$2 bounded=$3 cur
  while [ "$n" -gt 1 ]; do
    n=$((n - 1))
    cur=$(sed -n "${n}p" "$f" | sed 's/^ *//')
    [ -z "$cur" ] && return 1                       # blank: end of paragraph
    case "$cur" in '#'*) return 0 ;; esac
    if [ "$bounded" = yes ]; then
      # Leaving the shell script means leaving where the reason belongs.
      case "$cur" in run:*|'- '*) return 1 ;; esac
    fi
  done
  return 1
}

for f in .github/workflows/*.yml; do
  # A discarded failure in shell. The reason has to be in the script.
  while IFS=: read -r line text; do
    [ -z "${line:-}" ] && continue
    case "$text" in *'#'*) continue ;; esac        # a trailing comment counts
    explained "$f" "$line" yes && continue
    report "$f:$line" "$(echo "$text" | sed 's/^ *//')"
  done < <(grep -nE '\|\| true|2>/dev/null' "$f" || true)

  # `continue-on-error` is a step key, not a statement, so its reason belongs
  # with the step -- above the `- name:`, where the rest of this repository
  # puts it.
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
