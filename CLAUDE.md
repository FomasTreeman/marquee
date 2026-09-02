# Working on Marquee

A controller-first game launcher. Tauri v2, Rust core, TypeScript frontend, no
UI framework. Read `docs/PLAN.md` for why any of it is the way it is.

**Priorities, in tie-breaking order: performance, then stability, then UI.**

## Before you finish

```bash
pnpm test          # silence, workflow and board checks, vitest, tsc, cargo test
cd src-tauri && cargo clippy --all-targets -- -D warnings
```

CI runs both on Linux, Windows and macOS with warnings as errors. It also
checks that `src/css/tokens.css` is in step with `design/tokens.json` — if you
touch tokens, run `pnpm tokens`.

Roughly a tenth of the Rust is behind `#[cfg(target_os)]` that macOS never
compiles, so a lint can be clean locally and red in CI. `tools/build-windows.sh`
lints the Windows target if you have the toolchain.

## The one rule that is unusual

**Every hard bug in this project has been silent.** A clipped focus ring, an
invisible cover, a stale frontend embedded in the binary, a dev build shipped
as a release, artwork that was a grey placeholder rather than a 404. None of
them threw. Conventional error handling catches none of them.

So:

- **A discarded failure needs a stated reason.** `let _ = ` and `catch {}` are
  allowed, but each needs either a log call or a comment saying why nobody
  needs to know. `tools/check-silence.sh` enforces it and runs in `pnpm test`.
  `log_if_err!(source, expr, "context {}", detail)` is the short way.
- **Prefer an assertion over a comment.** If an invariant matters, find a way
  to make it fail loudly: a test, a `const _: () = assert!(...)`, a check in
  `src/selfcheck.ts`. `docs/DEBUGGING.md` explains the self-check, which
  hit-tests what is actually painted.
- **Prove a test bites.** Reintroduce the bug, watch the test fail, put it
  back. A test that passes against the broken code is worse than no test.

## Style

- **Comments say why, never what.** The code says what. If a line needs a
  comment to explain what it does, rewrite the line.
- **Record the bug in the comment.** Most comments here name a real failure
  that happened, because "don't remove this" is not an argument and "this was
  how filtering to two results still showed forty-eight cards" is.
- **British English**, in comments, identifiers and user-facing text.
  `favourite`, `minimise`, `colour`.
- **No new dependencies without a reason in the commit message.** The
  dependency list is short on purpose; see `docs/PLAN.md §3`.
- Match the surrounding code's density and idiom. Rust is `cargo fmt`; do not
  fight it.

## Tests

- Pure logic lives in modules that can be tested without a DOM: `grid-math.ts`,
  `filter.ts`, the exported helpers in `shell.ts`, `menu.ts`, `detail.ts`.
  There is no jsdom — if something needs the DOM to test, extract the decision.
- **Check for existing coverage before adding a test.** Duplicates have been
  written and removed here more than once.
- Name tests as sentences about behaviour, not about functions:
  `a_blank_custom_title_clears_rather_than_storing_nothing`.

## Commits

Prose, not bullet-point changelogs. Say what changed, and why it was wrong
before — a reader in six months needs the reasoning, not the diff, which git
already has. Subject line in the imperative, no prefix tags, no trailing full
stop.

**Finished work ends in a pull request, not in the working tree.** When a
change is done and `pnpm test` and clippy have passed, branch it, commit it and
open the PR without being asked. Leaving it uncommitted is not the cautious
option: more than one agent works in this checkout, and a session that ran
`git commit -a` once swept another's unrelated, unreviewed changes into its own
commit and onto main under a commit message about something else.

Never commit to `main` — a ruleset refuses it. Never commit anything matching
`*.key`: the update signing key must not enter the repository. See
`docs/UPDATES.md`.

## Where things are

| | |
|---|---|
| `src-tauri/src/` | Rust. `art.rs` artwork resolution, `meta.rs` Steam metadata, `store.rs` SQLite, `input.rs` gamepad, `run.rs` launching, `profile.rs` export/import |
| `src/` | Frontend. `main.ts` wiring, `grid.ts` the virtualised grid, `selfcheck.ts` the invariants |
| `docs/` | `PLAN.md` decisions, `DEBUGGING.md` the log and self-check, `SECURITY.md`, `WINDOWS.md`, `UPDATES.md` |

## Things that will bite you

- **`dev = !custom-protocol`.** Tauri decides dev-vs-production from a cargo
  feature, not the build profile. Removing `custom-protocol` ships a build that
  tries to load `localhost:1420` on the user's machine.
- **Steam serves a grey placeholder, not a 404**, for artwork it does not have.
  `art.rs` detects this by pixel variance. Do not trust a 200.
- **The grid is virtualised.** Slots are pooled and recycled; `loading="lazy"`
  and anything that assumes one element per item will break in ways that look
  like an artwork bug.
- **A backgrounded tab freezes `requestAnimationFrame`**, so transitions stall
  mid-way and screenshots look wrong. `docs/DEBUGGING.md` lists this and the
  other non-findings.
