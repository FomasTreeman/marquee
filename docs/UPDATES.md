# Updates

How Marquee updates itself and how releases are signed. How a merge becomes a
release is in [AUTOMATION.md](AUTOMATION.md). A launcher lives on a television
and nobody walks to the lounge to download a build, so without an updater every
install stays on the version it shipped with.

## How it works

```
release.yml (on merge, once CI is green on main)
  build installers → sign each with the PRIVATE key → write latest.json
  → attach to a draft release → publish when every platform is attached

a running Marquee
  fetch latest.json → compare versions → download the bundle for this OS
  → verify against the PUBLIC key compiled in → install, or refuse
```

**The public key is compiled into the binary that is already running.** Whoever
controls the release host or the network can serve any bytes, and without the
private key every one of them fails the signature check.

## The keypair

```bash
pnpm tauri signer generate -w ~/.tauri/marquee.key
```

| File | What it is | Where it goes |
|---|---|---|
| `~/.tauri/marquee.key` | the **private** key | a password manager, and the `release` environment's secrets. Never the repository. |
| `~/.tauri/marquee.key.pub` | the **public** key | `tauri.conf.json` → `plugins.updater.pubkey`, committed |

This is done. **Back up the private key**: each installed copy trusts only the
key it was compiled with, so a new keypair silently and permanently stops every
existing install updating, and each user has to reinstall by hand.

The key has an empty password, because an encrypted key's password would sit
beside it in CI anyway. To give it a real password, regenerate it before
anything ships and set both secrets together.

### The empty-password gotcha

**A passwordless key still needs the password secret to be the empty string.**
Only one of three cases works:

| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | What happens |
|---|---|
| **empty string** | signs correctly |
| absent entirely | `incorrect updater private key password: Device not configured`. The CLI tries to prompt and there is no terminal |
| any other value | `incorrect updater private key password: Wrong password for that key` |

So **delete the secret** rather than putting a placeholder in it. An absent
secret makes `${{ secrets.X }}` evaluate to the empty string, which works.

The `key` job in `release.yml` decodes the key against a scratch file before
the build, so a key problem fails in a minute and says which case you are in.

## Where the private key lives

| | Repository secret | Environment secret |
|---|---|---|
| Where | Settings → Secrets and variables → Actions | Settings → Environments → *name* → Secrets |
| Who can read it | **every workflow in the repository** | only a job with `environment: <name>` |
| Gates | none | required reviewers, wait timer, allowed branches and tags |
| Shows up as | nothing | a deployment, with an approval step if you ask for one |

**Use an environment.** A repository secret is readable by any workflow,
including one added by a pull request. Fork pull requests get no secrets, but
a branch in this repository is not a fork, so a `pull_request` job with
secrets, or a workflow edit that reached `main`, could read it. Log masking is
no defence: anything that can read a value can encode it.

1. **Settings → Environments → New environment**, named `release`.
2. Add `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
   here, **not** to repository secrets.
3. Under **Deployment branches and tags**, choose *Selected* and add **`main`**,
   the branch, not a tag pattern. GitHub matches the ref the workflow runs on,
   which is `refs/heads/main`, not the tag the job builds. A tag pattern fails
   with *"Branch main is not allowed to deploy to release due to environment
   protection rules"*. Pull requests run on `refs/pull/<n>/merge`, so a
   workflow added or edited in one still cannot reach the key.
4. Optionally add yourself as a **required reviewer**, so signing pauses for a
   click.

`release.yml` already declares `environment: release`. A job with an
environment also sees repository secrets, so this setup only tightens things.
`CLAUDE_CODE_OAUTH_TOKEN` stays a repository secret, for the reason in
[AUTOMATION.md](AUTOMATION.md).

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

- **`/releases/latest/download/`** points at the newest published release.
  Drafts are invisible to it, so the release stays a draft until every
  platform's bundle is attached; otherwise machines are told they are up to
  date while their platform is still building.
- **The endpoint must be publicly readable.** A private repository's release
  assets need a token, and a desktop app has nowhere safe to keep one. This is
  one reason the repository is public.
- **`installMode: "passive"`** shows a progress bar and no wizard. `"quiet"` is
  fully silent, which is wrong for something that replaces an executable.

`src-tauri/capabilities/default.json` grants `updater:default` and
`process:allow-restart`: check for an update and restart after one.

## The policy

`src/update.ts` decides when to ask; the plugin fetches, verifies and installs.
**Never interrupt.** The check runs **20 seconds after launch**. The offer
appears **only when the library is idle** (no menu, settings, details, picker
or on-screen keyboard), judged **when the answer arrives**, since a game may
have started. If the screen is busy, the offer is **dropped for the session**.

**Say what changed, and accept no.** The version is named, "Not now" is a real
option, and **a refusal is remembered for that version**. Failures are quiet: offline, rate-limited or a malformed manifest means "no
update" and a log line. **Settings → Updates → Check for updates** is the
exception and reports every outcome, including "up to date".

## Release rules

- **It never writes to the repository.** The version is injected into the
  working copy and the tag comes from the release, so `main` needs no
  exception to branch protection.
- **It is one workflow.** A tag pushed with `GITHUB_TOKEN` triggers no other
  workflow, so a build split off behind a tag never runs.
- **The version is computed**, from whichever is higher of the files' version
  and the newest tag, so it cannot produce an existing tag.
- **The version in the files is not the version.** `tauri.conf.json`,
  `package.json` and `Cargo.toml` stay at `0.2.2` because nothing commits the
  bump. The tags are the record: `git tag -l 'v*'`. Editing the files only
  moves the floor the next version starts from.
- **`bundle.createUpdaterArtifacts` must stay `true`.** Without it there are no
  `.sig` files or `latest.json`, the release page looks fine, and no installed
  copy finds an update.

## Still open

- **Code signing.** The update signature does not satisfy SmartScreen or
  Gatekeeper, which want a certificate from Microsoft or Apple. Unsigned
  installers work after a warning; on macOS the first launch needs
  right-click → Open.
- **A bad update** that will not start is the worst case. Next step: run the
  self-check on the first launch after an update and keep the previous version
  until it passes.

## Testing

A full test needs a published manifest. **Settings → Check for updates**
exercises the client (endpoint, manifest parse, version compare). **Actions →
Release → Run workflow** publishes a real release from `main`, which installed
copies will take. To test refusal, point `endpoints` at a local server with a
hand-written `latest.json`: a bundle signed with the wrong key must fail to
install, and the user must see the error.
