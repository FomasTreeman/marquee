# Contributing

The licence is [PolyForm Strict](LICENSE.md): use, but no redistribution or
derived works. A contribution is offered under the same terms, so you cannot
fork your own work afterwards.

## Before you open a pull request

```bash
pnpm test          # every check CI runs
cd src-tauri && cargo clippy --all-targets -- -D warnings
```

CI runs both on Linux, Windows and macOS with warnings as errors. About a
tenth of the Rust is behind `#[cfg(target_os)]` that a Mac never compiles, so
a lint can pass locally and fail in CI. `tools/build-windows.sh` lints the
Windows target if you have the toolchain.

## Silent failures

Most of the hard bugs here threw nothing: a clipped focus ring, an invisible
cover, a stale frontend in the binary, a grey placeholder instead of a 404.

- **A discarded failure needs a stated reason.** `let _ =` and `catch {}` need
  a log call or a comment saying why nobody needs to know.
  `tools/check-silence.sh` enforces it.
- **Prefer an assertion over a comment**: a test, a
  `const _: () = assert!(...)`, or a check in `src/selfcheck.ts`.
- **Prove a test bites.** Reintroduce the bug, watch the test fail, restore the
  fix, and say in the pull request that you did.

[docs/DEBUGGING.md](docs/DEBUGGING.md) covers the log and the self-check.

## Style

- Comments say why, never what.
- British English in comments, identifiers and user-facing text.
- No new dependencies without a reason in the commit message
  ([docs/PLAN.md](docs/PLAN.md) §3).
- Rust is `cargo fmt`. Otherwise match the surrounding code.
- Test names are sentences about behaviour:
  `a_blank_custom_title_clears_rather_than_storing_nothing`. Pure logic lives
  in modules that need no DOM; there is no jsdom.
- Commit messages are prose: what changed and why it was wrong before.
  Imperative subject, no prefix tags, no trailing full stop.

## Issues and the review loop

Use the issue template. Give the exact string you typed or the game, the
machine, and the log ([docs/DEBUGGING.md](docs/DEBUGGING.md) says where).

Many pull requests here are opened by Claude Code working from an issue. A
second agent run leaves a review comment, then a person reviews the pull
request. Nothing merges until that person enables it, and a merge is released
automatically. A pull request from you gets the same CI, staleness check and
review comment. [docs/AUTOMATION.md](docs/AUTOMATION.md) describes the loop.
`CLAUDE.md` is the agent's brief and holds the same rules as this file.
