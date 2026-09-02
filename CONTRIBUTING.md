# Contributing

Marquee is small and deliberately so. Contributions are welcome; the notes
below are what a reviewer here will look for, and most of them exist because
of something that went wrong once.

## Before you open a pull request

```bash
pnpm test          # every check CI runs
cd src-tauri && cargo clippy --all-targets -- -D warnings
```

CI runs both on Linux, Windows and macOS with warnings as errors. Roughly a
tenth of the Rust is behind `#[cfg(target_os)]` that a Mac never compiles, so
a lint can be clean locally and red in CI; `tools/build-windows.sh` lints the
Windows target if you have the toolchain, and CI will tell you otherwise.

## The one rule that is unusual

**Every hard bug in this project has been silent.** A clipped focus ring, an
invisible cover, a stale frontend embedded in the binary, artwork that was a
grey placeholder rather than a 404. None of them threw, and conventional
error handling caught none of them. So:

- **A discarded failure needs a stated reason.** `let _ =` and `catch {}`
  are allowed, but each carries a log call or a comment saying why nobody
  needs to know. `tools/check-silence.sh` enforces it.
- **Prefer an assertion over a comment.** If an invariant matters, make it
  fail loudly: a test, a `const _: () = assert!(...)`, or a check in
  `src/selfcheck.ts`, which hit-tests what is actually painted.
- **Prove a test bites.** Reintroduce the bug, watch the test fail, put the
  fix back, and say in the pull request that you did. A test that passes
  against the broken code is worse than no test.

[docs/DEBUGGING.md](docs/DEBUGGING.md) tells the stories behind each of these.

## Style

- Comments say **why**, never what. If a line needs a comment to explain what
  it does, rewrite the line. Most comments here name the real failure that
  made them necessary.
- British English, in comments, identifiers and user-facing text.
- No new dependencies without a reason in the commit message. The list is
  short on purpose; [docs/PLAN.md](docs/PLAN.md) §3 says why.
- Rust is `cargo fmt`. Match the surrounding code's density otherwise.
- Tests are named as sentences about behaviour:
  `a_blank_custom_title_clears_rather_than_storing_nothing`. Pure logic lives
  in modules that need no DOM; there is no jsdom, so if something needs the
  DOM to test, extract the decision.
- Commit messages are prose: what changed, and why it was wrong before. A
  reader in six months needs the reasoning; git already has the diff.
  Imperative subject, no prefix tags, no trailing full stop.

## Filing an issue

Use the template. The things that turn a report into a fix are the exact
string you typed or the game involved, which machine, and the log —
[docs/DEBUGGING.md](docs/DEBUGGING.md) says where it is. Most of this app's
failures are silent on screen and loud in the file.

## How the repository runs itself

Most pull requests here are opened by an agent working from an issue, reviewed
by a second agent and then by a person, merged through a queue and released
automatically. If you file an issue it will be routed by that machinery, and
the maintainer decides whether an agent or a person picks it up. If you open
a pull request, CI, the staleness check and the review comment will run on it
like any other. [docs/AUTOMATION.md](docs/AUTOMATION.md) describes the whole
loop, including what the agent can and cannot do — it cannot merge, cannot
push to `main`, and cannot start a release.

`CLAUDE.md` at the root is the brief that agent reads first. It is the same
set of rules as this file, addressed to a different reader.
