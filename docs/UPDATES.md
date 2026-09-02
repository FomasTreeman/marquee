# Over-the-air updates

How Marquee updates itself, why each piece is there, and what to do when it is
time to actually cut a release.

Written for a developer reading this cold — including whoever picks it up in
six months, which is probably us. How a merge becomes a release is in
[AUTOMATION.md](AUTOMATION.md); this is the updater's side of it.

## Why this exists at all

A launcher lives on a television. Nobody walks to the lounge to download a new
build, which means without an updater **every install is frozen at whatever
version it shipped with** — including the ones carrying the bug you fixed
weeks ago. For most desktop apps an updater is a convenience. For this one it
is the difference between a program and a thing you have to maintain by hand,
one machine at a time.

## The shape of it

Five pieces. Four of them are configuration; only one is code we wrote.

```
  you                     GitHub                      a running Marquee
  ───                     ──────                      ─────────────────
  merge a pull request
        │
        └──► release.yml, once CI is green on main
               decides the version from the PR's labels
               builds .msi / .dmg / .AppImage / .deb / .rpm
               signs each with the PRIVATE key
               writes latest.json
               attaches all of it to a draft, then publishes
                              │
                              │   latest.json
                              └──────────────────────►  check()
                                                          compares versions
                                                          │
                                 the bundle for this OS    │
                              ◄───────────────────────────┘
                                                        verify signature
                                                        against the PUBLIC key
                                                        │
                                                        ├─ matches → install
                                                        └─ does not → refuse
```

The important property: **the public key is compiled into the binary that is
already running.** An attacker who takes over the release host, or the network
between it and the user, can serve any bytes they like — and every one of those
bytes fails the signature check on a machine they do not have the private key
for. The download is untrusted; the verification is not.

## The keypair

Generated once, with:

```bash
pnpm tauri signer generate -w ~/.tauri/marquee.key
```

That writes two files:

| file | what it is | where it goes |
|---|---|---|
| `~/.tauri/marquee.key` | the **private** key | a password manager, and the `release` environment's secrets. Never the repo. |
| `~/.tauri/marquee.key.pub` | the **public** key | `tauri.conf.json` → `plugins.updater.pubkey`, committed |

This has already been done for Marquee; the public half is in the config.

**Back the private key up today, not on release day.** Losing it does not mean
"generate a new one": every installed copy of Marquee only trusts bundles
signed by the key whose public half it was compiled with. A new keypair means
every existing install stops accepting updates *silently and permanently*, and
the only fix is for each user to download and install by hand. It is the one
mistake in this whole document you cannot undo.

The key generated here has an empty password, which is a deliberate trade: an
encrypted key needs its password stored beside it in CI anyway, so the
encryption protects nothing the secret store was not already protecting.

**A passwordless key still needs the password secret to be the empty string.**
This is worth stating precisely because all three cases behave differently and
only one of them works:

| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | What happens |
|---|---|
| **empty string** | signs correctly |
| absent entirely | `incorrect updater private key password: Device not configured` — the CLI tries to prompt, and there is no terminal |
| any other value | `incorrect updater private key password: Wrong password for that key` |

So **delete the secret** rather than putting a placeholder in it. An absent
secret makes `${{ secrets.X }}` evaluate to the empty string, which is exactly
the case that works — while a placeholder is the case that fails.

That failure used to arrive at the very end of a nine-minute build, because the
bundler signs after building everything. The `key` job in `release.yml` now
does the same decode against a scratch file first, so a key problem costs a
minute and prints which of the three cases you are in.

If you would rather the key had a real password, regenerate now — before
anything ships — and set both secrets together.

## Where to put the private key: repository or environment?

Both work. They differ in who can read the secret.

| | Repository secret | Environment secret |
|---|---|---|
| Where | Settings → Secrets and variables → Actions | Settings → Environments → *name* → Secrets |
| Who can read it | **every workflow in the repository** | only a job with `environment: <name>` |
| Gates | none | required reviewers, wait timer, allowed branches and tags |
| Shows up as | nothing | a deployment, with an approval step if you ask for one |

**Put the signing key in an environment.** A repository secret is readable by
any workflow in the repository — including one added by a pull request, and
pull requests here are increasingly written by a machine. Fork PRs get no
secrets at all, but a branch in this repository is not a fork, so a workflow
edit that reached `main`, or a `pull_request` job that runs with secrets, could
read a repository-level key. Masking in logs is not a defence; anything that
can read a value can encode it.

An environment secret is unreachable unless a job names the environment, and
GitHub will not start that job until the environment's rules pass. Set it up
once:

1. **Settings → Environments → New environment**, called `release`.
2. Add `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
   to it — **not** to repository secrets.
3. Under **Deployment branches and tags**, choose *Selected* and add
   **`main`** — the branch, not a tag pattern.

   This is the rule that catches people, and it caught us. GitHub checks the
   pattern against **the ref the workflow is running on**, not against whatever
   the job later checks out. Releasing is triggered by a push to `main`, so the
   workflow's ref is `refs/heads/main` even though the build then checks out
   the `v0.2.1` tag. A `v*` tag pattern therefore blocks the release with
   *"Branch main is not allowed to deploy to release due to environment
   protection rules"*, which reads like a permissions problem and is not one.

   Allowing `main` keeps the protection that matters. A pull request runs on
   `refs/pull/<n>/merge`, which does not match `main`, so a workflow added or
   edited in a pull request still cannot reach the signing key. That was the
   threat; the tag pattern was never what stopped it.
4. Optionally add yourself as a **required reviewer**, so signing a release
   pauses for a click.

`release.yml` already declares `environment: release`. If you skip all of this
and use a repository secret, it still works — a job with an environment sees
repository secrets too — so this only ever tightens.

**`CLAUDE_CODE_OAUTH_TOKEN` stays a repository secret.** It is needed by a
workflow that fires on issue comments; behind a required-reviewer environment
you would be approving every single run, which defeats the point. What protects
it is the action's own rule that the triggering user must have write access.

## Configuration

`src-tauri/tauri.conf.json`:

```jsonc
"plugins": {
  "updater": {
    "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6...",   // the public half, verbatim
    "endpoints": [
      "https://github.com/FomasTreeman/marquee/releases/latest/download/latest.json"
    ],
    "windows": { "installMode": "passive" }
  }
}
```

Three notes:

- **`/releases/latest/download/`** always resolves to the newest published
  release, so the endpoint never needs editing. Draft releases are invisible to
  it, and `release.yml` leans on that: the release is a draft until every
  platform's bundle is attached, and a final job publishes it. Before that it
  published as it went, so for the twenty-five minutes Windows took to build
  the manifest listed one platform and Windows machines were told they were up
  to date.
- **The endpoint must be publicly readable.** A private repository's release
  assets need a token, and there is nowhere safe to put one in a desktop app.
  That is one of the reasons the repository is public.
- **`installMode: "passive"`** shows a progress bar and no wizard. The
  alternative, `"quiet"`, is fully silent, which is the wrong default for
  something that replaces an executable on your machine.

`src-tauri/capabilities/default.json` grants `updater:default` and
`process:allow-restart`. Nothing more: the frontend can ask whether there is an
update and restart after one, and that is all.

## The code

`src/update.ts`, and it is deliberately small. The plugin does everything
dangerous — fetching, verifying, installing. What we wrote is *policy*: when to
ask, and what the person is told. Two rules:

**1. Never interrupt.** A launcher's whole job is the four seconds between
deciding to play something and the game starting. An update prompt in that gap
is the single most irritating thing this class of app does. So:

- the check fires **20 seconds after launch**, well behind artwork resolution,
  which is what the user is actually looking at;
- it is offered **only when the library is idle** — no menu, no settings, no
  details, no picker, no on-screen keyboard;
- idleness is checked **when the answer arrives**, not when the timer is set,
  because twenty seconds is plenty of time to have started a game;
- if the screen is busy the offer is **dropped for the session**, not retried.
  An app that keeps trying to interrupt you is worse than one that waits until
  tomorrow.

**2. Say what changed, and take no for an answer.** A binary that silently
replaces itself is indistinguishable from malware from the user's side, and
Marquee already asks for a lot of trust by launching executables. So the
version is named, "Not now" is a real option, and **a refusal is remembered for
that version** — the same prompt does not reappear on every launch. Asking
repeatedly is how people learn to dismiss prompts without reading them, which
is exactly what makes the important prompt dangerous.

Failures are quiet by design. Being offline, a rate-limited host, a malformed
manifest — all of them return "no update" and write a line to the log. The user
did not ask for the check, so they do not get told it failed. The one exception
is **Settings → Updates → Check for updates**, which was asked for explicitly
and therefore reports whatever happens, including "up to date".

## Cutting a release

You do not. Merging a pull request is the release.

The Release workflow waits for CI to pass on the merge commit, decides the
version from the merged pull request's labels (`breaking` major, `enhancement`
or `feature` minor, otherwise patch, `no-release` to skip), injects it into
the working copy, builds all four targets, signs them, writes `latest.json`
and publishes once every bundle is attached. [AUTOMATION.md](AUTOMATION.md)
walks it through.

Two things about the shape of that workflow, both learned by getting them
wrong:

**It never writes to the repository.** The version is injected into the working
copy at build time and the tag comes from the release itself. An earlier
version committed the bump to `main`, which meant the automation needed write
access to the one branch that should only change through a reviewed pull
request -- so protecting `main` would have needed an exception carved out for
it. There is nothing to carve now.

**It is one workflow, not two.** Bumping the version and building used to be
separate, joined by a pushed tag -- and **a tag pushed with `GITHUB_TOKEN` does
not trigger another workflow.** GitHub blocks that so workflows cannot loop.
The tag landed, the build never ran, and the only thing on the releases page
was a source archive. If you split this up again, that is what happens.

**The version is computed, never typed.** It starts from whichever is higher,
the version in the file or the newest tag, so it cannot produce a tag that
already exists. The first attempt trusted a hand-typed tag and immediately
produced `v0.2.0` against a `tauri.conf.json` saying `0.0.1`.

A consequence worth knowing before it surprises you: **the version in the
files is not the version.** `tauri.conf.json`, `package.json` and `Cargo.toml`
say `0.2.2` and will go on saying it, because nothing commits the bump; the
tags are the record, and `git tag -l 'v*'` is where to look. Bumping the files
by hand does nothing except move the floor the next computation starts from.

**`bundle.createUpdaterArtifacts` must stay `true`.** Without it Tauri builds
installers and no updater artifacts -- no `.sig` files, nothing for
`latest.json` to point at. The release page looks perfectly healthy and no
installed copy ever finds an update.

## Still open

Ordered by how annoying they are to fix later:

1. **Back up the private key.** See above. This is the irreversible one, and
   it does not stop being true after the thirtieth release.
2. **Code signing is a separate problem.** The update signature proves the
   bundle came from us; it does nothing about SmartScreen on Windows or
   Gatekeeper on macOS, which want a certificate from Microsoft or Apple. An
   unsigned installer still works — it just shows a frightening dialog first,
   and on macOS the first launch needs a right-click → Open.
3. **Consider what happens if an update is bad.** An update that installs and
   then will not start is the worst outcome, because the machine is in the
   lounge. The self-check already asserts the invariants that would catch it;
   running it on the first launch after an update, and keeping the previous
   version recoverable until it passes, is the obvious next step and is not
   built yet.

## Testing it without shipping anything

The honest answer is that you cannot fully test an updater without publishing
something, because the thing being tested is the manifest a real host serves.
What you can do:

- **Settings → Check for updates** exercises the whole client path — endpoint,
  manifest parse, version compare — and reports what it finds.
- **Actions → Release → Run workflow** with a bump chosen publishes a release
  from `main` as it stands, which is the way to watch an installed copy take
  an update without merging anything. It is a real release; the installed
  copies will take it.
- Point `endpoints` at a local file server serving a hand-written
  `latest.json` to test the refusal path: a bundle signed with the wrong key
  must fail to install, and the error must reach the user rather than
  disappearing.
