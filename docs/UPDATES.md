# Over-the-air updates

How Marquee updates itself, why each piece is there, and what to do when it is
time to actually cut a release.

Written for a developer reading this cold — including whoever picks it up in
six months, which is probably us.

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
  git tag v0.2.0
  git push --tags
        │
        └──► release.yml
               builds .msi / .dmg / .AppImage
               signs each with the PRIVATE key
               writes latest.json
               attaches all of it to a Release
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
| `~/.tauri/marquee.key` | the **private** key | a password manager, and repository secrets. Never the repo. |
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
encryption protects nothing that the secret store was not already protecting.
If you would rather have one, regenerate now — before anything ships — and set
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

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
  it, which is why `release.yml` produces a draft — nothing reaches any user
  until a human presses publish.
- **The endpoint must be publicly readable.** A private repository's release
  assets need a token, and there is nowhere safe to put one in a desktop app.
  This is the constraint that ties updates to the repository being public; the
  alternatives are publishing releases from a private repo, or hosting the
  manifest and bundles in a bucket.
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

```bash
# 1. Bump the version. The tag and this file must agree; CI checks.
#    Edit "version" in src-tauri/tauri.conf.json.

# 2. Commit it.
git commit -am "Marquee 0.2.0"

# 3. Tag and push.
git tag v0.2.0
git push && git push --tags
```

`release.yml` then builds four targets — Apple silicon, Intel Mac, Linux x64,
Windows x64 — signs each bundle, writes `latest.json`, and creates a **draft**
release. Review it, write real notes, press publish. Existing installs will
offer it shortly after their next launch.

`workflow_dispatch` runs the same pipeline without a tag, so the whole thing
can be proven before it is trusted with a real release. Do that first.

## Before the first real release

Ordered by how annoying they are to fix later:

1. **Back up the private key.** See above. This is the irreversible one.
2. **Make the repository, or at least its releases, public.** The endpoint
   cannot authenticate.
3. **Decide on `0.1.0`.** The version has been `0.0.1` since the first commit
   because nothing depended on it. The updater compares versions, so it becomes
   real state the moment this ships.
4. **Code signing is a separate problem.** The update signature proves the
   bundle came from us; it does nothing about SmartScreen on Windows or
   Gatekeeper on macOS, which want a certificate from Microsoft or Apple. An
   unsigned installer still works — it just shows a frightening dialog first.
   Phase 4 in `docs/PLAN.md`.
5. **Consider what happens if an update is bad.** An update that installs and
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
- Publish a `v0.0.2` from a scratch branch with `workflow_dispatch`, install
  `v0.0.1` locally, and watch it offer the upgrade. This is worth doing once.
- Point `endpoints` at a local file server serving a hand-written
  `latest.json` to test the refusal path: a bundle signed with the wrong key
  must fail to install, and the error must reach the user rather than
  disappearing.
