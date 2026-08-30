# The issue → PR → release loop

File a bug on the issues board, have Claude fix it, review the pull request,
merge, release, and take the update on the machine in the lounge. This is how
that is wired.

## Setup, once

**1. A token, not an API key.**

```bash
claude setup-token
```

That opens a browser, authorises against your Claude subscription, and prints a
long-lived token. Usage counts against the Pro or Max plan you already pay for
— there is no Anthropic API billing in this loop.

Paste it into **Settings → Secrets and variables → Actions** as
`CLAUDE_CODE_OAUTH_TOKEN`. It is a credential for your Claude account: never
put it in an issue, a commit, or a chat window.

**2. Let Actions open pull requests.**

**Settings → Actions → General → Workflow permissions →** tick *"Allow GitHub
Actions to create and approve pull requests"*. Without it the run does the work
and then fails at the last step, which is a confusing way to find out.

**3. The signing key, if you have not already.** `docs/UPDATES.md`. Nothing
below produces a usable release without it.

## Filing an issue Claude can act on

The failure mode is not Claude refusing — it is Claude confidently fixing the
wrong thing. What earns a good patch:

- **What you did, what happened, what you expected.** In that order.
- **The exact string you typed** if it involves search, and **the game** if it
  involves artwork. "Rocket League returns nothing" is a bug report; "search is
  broken" is a mood.
- **Which machine.** Windows and macOS diverge here more than anywhere else,
  and a tenth of the Rust never compiles on the development machine.
- **The log** when there is one, from `%LOCALAPPDATA%\Marquee\logs\marquee.log`
  or `~/Library/Logs/Marquee/marquee.log`. Most of this app's failures are
  silent on screen and loud in the log — that is deliberate, so use it.

Then either put `@claude` in the body, comment `@claude` on it later, or add
the **`claude`** label. Any of the three starts a run.

## What happens

`.github/workflows/claude.yml` checks out the repository with its full history,
installs the Rust and Node toolchains, and runs Claude Code with the issue as
its brief. It reads `CLAUDE.md` first, so it works to this project's
conventions rather than generic ones — including the one that matters most
here: **a fix is not finished until something fails when it regresses.**

It opens a branch and a pull request. It cannot merge, and it is not asked to.
Progress is ticked off in the issue thread as it goes.

You can keep talking to it. `@claude` in a review comment on the PR, and it
picks up from there with the review as context.

## Reviewing

CI runs on all three platforms with warnings as errors, plus the silence check,
the token check and the test suites. **A green CI means it compiles and the
tests pass; it does not mean the fix is right.** The things to look at, in the
order they have actually gone wrong here:

1. **Does the new test fail without the fix?** The PR should say so explicitly.
   A test that passes against the broken code is worse than no test, and this
   has happened more than once.
2. **Is the failure now audible?** Silent degradation is this project's whole
   disease. A fix that leaves the next occurrence invisible is half a fix.
3. **Is it the smallest change that works?** Look for scope that crept in.
4. **Does the comment say why, not what?**

## Releasing

**Actions → Release → Run workflow**, pick `patch`, `minor` or `major`.

That bumps the version in `tauri.conf.json`, `package.json` and `Cargo.toml`
together, commits it, and pushes a tag. **Build release** picks the tag up,
builds and signs an installer for each platform, writes the `latest.json`
manifest, and opens a **draft** release.

Write real notes on the draft — they are what the update prompt shows people —
then press publish. Nothing reaches any install until you do.

The version is bumped by a workflow rather than by hand because it stops being
decoration the moment an updater is live: every install compares its own
version against the manifest, so a `tauri.conf.json` that disagrees with the
tag ships an update that either never offers itself or offers itself forever.

## Taking the update

On the machine in the lounge, either:

- **Wait.** Marquee checks about twenty seconds after launch and offers the
  update on the library screen when nothing else is open. "Not now" is
  remembered for that version.
- **Ask.** **Settings → Updates → Check for updates** asks immediately and
  reports whatever it finds, including "up to date". This is also how you find
  out the pipeline works without waiting for a prompt.

Every bundle is verified against the public key compiled into the copy already
running, so a release that fails its signature check will not install.
`docs/UPDATES.md` has the detail.

## What this loop is not

**It is not a licence to skip review.** The whole arrangement is one where a
machine writes and a person decides, and the person is the part that makes it
safe. Marquee launches executables on your machine and updates itself; a patch
nobody read is a patch nobody read, whoever wrote it.
