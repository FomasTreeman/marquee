# DevSecOps: what is in place, and what is left

A working list. Each entry says what the repository does today, what to do
about it, and what the technique buys and costs, because a control adopted
without its costs written down is one somebody removes the first time it is in
the way.

It came out of an audit on 4 October 2026 of the workflows, the repository
settings as the API reports them, and the release chain. Settings drift without
a commit, so check an entry's "today" before acting on it.

Effort is **S** for a setting or a few lines, **M** for an evening, **L** for
something that reworks a workflow.

## Already in place

| Technique | Where | What it costs |
|---|---|---|
| Actions pinned to a commit SHA, and a lint that refuses a tag | `tools/check-workflows.py` | A pin goes stale unless something bumps it, which is what `dependabot.yml` is for |
| Every job declares `permissions` and `timeout-minutes` | `tools/check-workflows.py` | Nothing; the lint is the reminder |
| Event data reaches a script through `env:`, never `${{ }}` in `run:` | `tools/check-workflows.py` | The lint sees `run:` only, see item 6 |
| Signing key in the `release` environment, deployable from `main` only | `release.yml`, environment settings | A pull request cannot test the signing path |
| Draft release, verified, then published | `release.yml`, `verify` job | Four serial builds, about half an hour |
| Release waits for green CI on the exact commit | `release.yml`, `ci` job | A slow CI queue delays a release |
| Secret scanning with push protection | repository setting | None |
| Private vulnerability reporting | repository setting, `docs/SECURITY.md` | None |
| Dependabot security updates for cargo and npm | repository setting | Opens a pull request only when an advisory has a fix |
| `pull_request_target` checks out the base branch only | `board.yml` | The script cannot see the branch it is reconciling |
| Agent starts only for a maintainer, with a named tool list | `claude.yml` | See item 1 for what the list does not cover |
| A tight CSP and four Tauri permissions | `tauri.conf.json`, `capabilities/default.json` | `style-src 'unsafe-inline'`, argued in `docs/SECURITY.md` |
| No shell on any launch path, and a URI allowlist behind it | `run.rs` | None |

## A suggested order

Settings first, because they are reversible in a click and several are free:
items 3, 5, 9, 10, 12 and 14. Then the checks that live in CI: 6, 7, 11, 13,
15, 16. Then the two that change how the project works: 1 and 8.

---

## Who can change `main`, and what a release is

### 1. A second identity for the agent, and one required approval — L

- [ ] Done

**Today.** The ruleset on `main` requires a pull request and three green
builds, and zero approvals. The agent acts through `CLAUDE_WORKFLOW_TOKEN`, a
personal access token, so GitHub sees its pull requests as yours. What stops it
merging is its instructions and its tool list. Neither is enforced by the
platform, and merging is releasing.

**Do.** Register a GitHub App with the permissions in
`docs/AUTOMATION.md`, mint its token per run with
`actions/create-github-app-token`, and retire the personal token. Set
`required_approving_review_count` to 1. Give the admin role a bypass on the
ruleset so your own pull requests still merge. Add `.github/CODEOWNERS` covering
`.github/`, `src-tauri/tauri.conf.json` and `src-tauri/capabilities/`, and turn
on `require_code_owner_review`.

**For.** Separation of duties that GitHub enforces: the author of a change
cannot approve it, and the agent is now a different author from you. App tokens
last an hour, against a personal token that lasts until it is revoked. Events
from an App token still start workflows, which is the property the personal
token was chosen for.

**Against.** The largest change on this list, touching every workflow that
names the token. The App's private key is a new long-lived secret. Each agent
pull request needs an approval as well as the auto-merge click. A session on
your own machine still opens pull requests as you, so the bypass covers it: the
control binds the unattended agent, not the attended one.

### 2. Protect `v*` tags — S

- [ ] Done

**Today.** One ruleset, and it targets branches. Any token with Contents write
can move or delete a `v*` tag, and `release.yml` reads the newest tag as the
floor for the next version.

**Do.** Add a tag ruleset on `refs/tags/v*` that blocks update and deletion.
Leave creation open, because the release workflow creates the tag when it
publishes.

**For.** A tag that cannot move is the property a reader assumes a version
already has.

**Against.** Creation stays open, so a stray `v99.0.0` can still push the
version floor up. A mistaken tag can only be removed by switching the rule off.

### 3. Immutable releases — S

- [ ] Done

**Today.** Off. The assets on a published release, `latest.json` among them,
can be replaced afterwards. The bundles are signed, but the version number in
`latest.json` is not, so a manifest claiming a higher version and pointing at
an older signed bundle would verify.

**Do.** Settings → General → Releases → enable release immutability. The
workflow already builds a draft and publishes last, which is the shape
immutability wants.

**For.** Closes the rollback and locks the tag in one setting. No workflow
change. GitHub records a release attestation as a side effect.

**Against.** A bad release cannot be repaired in place, only superseded.
Anything added to a release, item 8's attestations or an SBOM, has to be
attached while it is still a draft.

### 4. Signed commits on `main` — S

- [ ] Done

**Today.** Not required. Merge, squash and rebase are all allowed.

**Do.** Restrict the merge method to squash, then add `required_signatures` to
the ruleset.

**For.** Every commit on `main` carries a verified signature.

**Against.** With squash, the signature is GitHub's, so it proves GitHub made
the commit and says nothing about who wrote the change. Worth less than it
looks; do it last.

---

## The pipeline

### 5. Static analysis with CodeQL — S

- [ ] Done

**Today.** Not configured. The repository's languages are Rust, TypeScript,
Python and Actions, and CodeQL covers all four.

**Do.** `gh api -X PATCH repos/FomasTreeman/marquee/code-scanning/default-setup -f state=configured`.

**For.** Free on a public repository, no workflow file to maintain, results in
the Security tab and on pull requests. The Actions pack reads workflows for
injection and excess permissions.

**Against.** Default setup is not a file in the repository, so it is a control
nobody can read in a diff; an advanced setup is, at the price of another
workflow to pin. Rust support is the youngest of the four. Expect false
positives, and each dismissal needs its reason.

### 6. A workflow linter that knows more than ours — M

- [ ] Done

**Today.** `tools/check-workflows.py` checks schema, pins, permissions,
timeouts, and `${{ }}` in `run:` for three contexts. It does not look inside
`script:` or `with:`, and knows nothing of cache poisoning or credential
persistence.

**Do.** Run `zizmor` over `.github/workflows` and upload its SARIF, and
`actionlint` for the shell inside `run:`. Keep the Python check for the rules
that are this repository's own.

**For.** Two maintained rule sets written by people who study workflow attacks.
`actionlint` runs shellcheck over every script in the release workflow.

**Against.** A first run will be noisy: `pull_request_target`, the cache in the
release job and `checkout` without `persist-credentials: false` all get
flagged. Every exception needs a line in a config file. Two more tools to
install or pin, overlapping one that already exists.

### 7. Dependency audit and policy with cargo-deny — M

- [ ] Done

**Today.** Nothing in CI reads the 531 crates in `Cargo.lock` or the npm tree
against an advisory database. Dependabot alert #1 has been open since 2
September with no decision recorded: `glib` 0.18.5, GHSA-wrw7-89jp-8q8g, which
arrives through Tauri's GTK stack on Linux and cannot be bumped from here.

**Do.** Add `src-tauri/deny.toml` with the advisories, licences, bans and
sources checks, and run `cargo deny check` in the Ubuntu leg of CI and on a
weekly schedule. Add `pnpm audit --prod` beside it. Record the `glib` decision
as an `ignore` with its reason, and dismiss the alert with the same words.

**For.** An ignored advisory with a reason is this project's silence rule
applied to dependencies. The licence check is real for a PolyForm project that
links a few hundred crates. The sources check refuses a crate from anywhere but
crates.io.

**Against.** Tauri on Linux pulls in the unmaintained GTK3 bindings, so expect
a dozen "unmaintained" advisories to ignore on day one. An advisory published
overnight turns CI red on a pull request that did nothing; the schedule is what
keeps that from being the first anyone hears of it. A new job is not in the
required-checks list, so make it a step in the existing one. `CI` is not among
the workflows `automation-broken.yml` watches, so a red scheduled run is silent
unless it is added.

### 8. Provenance and an SBOM for each release — M

- [ ] Done

**Today.** A release carries the updater's `.sig` files and nothing else. The
`.dmg` files have no signature of any kind. Nothing ties a bundle to the commit
and workflow that built it, and there is no list of what went into it.

**Do.** After the bundle step, run `actions/attest-build-provenance` over the
bundles, with `id-token: write` and `attestations: write` on the build job.
Generate a CycloneDX SBOM with `cargo cyclonedx`, attach it to the draft and
attest it. Put `gh attestation verify <file> --repo FomasTreeman/marquee` in
the README.

**For.** Anyone can check that a download was built by `release.yml` at a named
commit, which covers the `.dmg` and the installers the updater signature does
not. The signing uses a short-lived certificate, so there is no new key to
keep. An SBOM answers "am I affected" for a release already shipped.

**Against.** Provenance says where a bundle was built, not that the source was
sound. `id-token: write` lands in the one job that holds the signing key. The
version is written into the working copy before the build, so the source built
is the commit plus that edit. Nobody verifies unless told how.

### 9. Workflow token read-only by default — S

- [ ] Done

**Today.** The repository default is `write`. Every job declares its own
permissions, so the default is only reached by a job the lint missed.

**Do.** `gh api -X PUT repos/FomasTreeman/marquee/actions/permissions/workflow -f default_workflow_permissions=read`,
then run Board by hand and watch it write a label.

**For.** The lint's guarantee becomes the platform's.

**Against.** The comment at the top of `ci.yml` says a read default caps what a
`permissions:` block can ask for. GitHub documents it as a default, not a cap,
so that comment is probably recording a different failure, but it was written
from something that happened. Test it, and correct whichever is wrong.

### 10. Let GitHub enforce the pins — S

- [ ] Done

**Today.** `allowed_actions` is `all` and `sha_pinning_required` is false. The
pinning is enforced by our own lint, in a job a pull request can edit.

**Do.** Settings → Actions → General: allow selected actions only, list the
six owners in use, and require a full-length SHA.

**For.** A pull request cannot weaken a repository setting. Adding an action
becomes a deliberate act in two places.

**Against.** Adding an action now needs a settings change before the pull
request can go green. Check whether the requirement reaches into the `uses:`
lines inside composite actions, because a pinned action that calls an unpinned
one would then fail.

### 11. Pin the toolchains — M

- [ ] Done

**Today.** Rust is whatever `stable` is on the day. pnpm is `version: 9` with
no `packageManager` field. Node is 20, which has been end of life since April
2026. No cargo command passes `--locked`. pnpm 9 runs dependency install
scripts by default.

**Do.** Add `rust-toolchain.toml` with an exact channel. Add `packageManager`
with an exact pnpm version and drop `version:` from the workflows. Move to a
supported Node LTS through `.nvmrc` and `node-version-file`. Pass `--locked` to
clippy and test in CI. Move to pnpm 10, which runs no dependency script unless
it is named in `onlyBuiltDependencies`.

**For.** A build from the same commit uses the same compiler next month. A new
clippy lint arrives in a pull request that bumps the toolchain, not in whichever
one happened to be open. `--locked` turns a stale lockfile from a silent
re-resolve into a failure.

**Against.** Pins go stale, so each needs something to bump it. The release job
rewrites the version in `Cargo.toml`, which makes `Cargo.lock` stale by design:
`--locked` there needs the same edit made to the lock first. pnpm 10 may need
`esbuild` allowed by name.

### 12. A cooldown on Dependabot — S

- [ ] Done

**Today.** Weekly, for `github-actions` only, with no cooldown. A release of
`tauri-action` published on a Sunday is a pull request against the signing job
on Monday.

**Do.** Add `cooldown: { default-days: 7 }` to the entry in
`.github/dependabot.yml`.

**For.** Most compromised releases are found and pulled within days. One line.

**Against.** A real fix waits the same week. Security updates are exempt, which
is the case that matters.

### 13. Keep the signing key away from the build — L

- [ ] Done

**Today.** The key has no password, a trade argued in `docs/UPDATES.md`. It is
in the environment of the whole bundling step, which runs vite, every build
script and every proc macro in the tree. The same job restores a build cache.
`docs/UPDATES.md` has no procedure for a key that is lost or leaked.

**Do.** In order of cost. Write the rotation procedure, including the release
signed with the old key that ships the new public key, without which every
installed copy is stranded. Drop the cache from the release job. Then split the
job: build with no secrets, upload the bundles, and sign them in a second job
that runs nothing but `tauri signer sign`.

**For.** The key is then visible only to a job that executes no dependency
code. The runbook is the part most likely to be needed.

**Against.** The split reworks the most fragile workflow here. The bundler
refuses to produce updater artefacts without the key, and `tauri-action` writes
`latest.json` from the signatures, so both need replacing by hand. Dropping the
cache adds minutes to each of four serial builds.

### 14. Wider secret scanning, and a check for the key itself — S

- [ ] Done

**Today.** Provider patterns and push protection are on. Non-provider patterns
and validity checks are off. `docs/SECURITY.md` says a ruleset refuses `*.key`;
no such rule exists, and the protection is `.gitignore`.

**Do.** Turn on the two toggles if they are offered. Add a check to
`tools/` that fails on the base64 prefix every Tauri private key starts with,
`dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5`, whatever the
file is called. Correct the sentence in `docs/SECURITY.md`.

**For.** Catches the key pasted into a workflow, a doc or a test, which a
filename rule never would. No dependency.

**Against.** A check in CI runs after the push, and on a public repository that
is already too late: it shortens the exposure, it does not prevent it. Only a
local hook runs early enough, and a hook is per-clone and optional.

### 15. OpenSSF Scorecard — S

- [ ] Done

**Today.** Absent.

**Do.** Add the `ossf/scorecard-action` workflow on a schedule and on push to
`main`, publish the results, and put the badge in the README.

**For.** A public score from somebody else's rules, which is the point of a
showcase. It re-checks pins, token permissions and branch protection weekly.

**Against.** Several checks assume a team: code review will score low for a
solo maintainer whatever is done. One more third-party action, and a number on
the README that starts lower than the work deserves.

### 16. Egress monitoring on the release job — M

- [ ] Done

**Today.** A release build can reach any host.

**Do.** Add `step-security/harden-runner` as the first step of the build job
with `egress-policy: audit`, read a few runs, then move to `block` with the
hosts it found.

**For.** A build that only talks to crates.io, npm and GitHub cannot post the
signing key anywhere else. A cheaper answer to item 13's threat than the split.

**Against.** It puts a third-party agent in the most sensitive job to protect
it, and sends its findings to a hosted service. Block mode has been strongest
on Linux runners; check what it does on the macOS and Windows legs before
relying on it.

---

## The application

### 17. Bound what an artwork download can cost — S

- [ ] Done

**Today.** `usable()` in `art.rs` reads a response of any size and decodes it
with no limits. SteamGridDB artwork is uploaded by its users.

**Do.** Cap the body, decode through `image::ImageReader` with `Limits` set, and
log a refusal. Prove the test bites with an image over the cap.

**For.** A hostile or broken image costs a log line, not the process.

**Against.** A cap set too low drops real artwork, and a missing cover is the
failure this project sees least well, so the refusal has to be logged loudly
enough to find.

### 18. Fuzz the parsers that read other people's files — M

- [ ] Done

**Today.** `docs/SECURITY.md` calls the VDF and ACF parser "fuzz-shaped". There
is no fuzz target and no property test.

**Do.** Either `proptest` as a dev-dependency, with properties for the Steam
parsers, `SourceKey::parse` and `open_uri`; or `cargo fuzz` targets for the
same three.

**For.** `proptest` runs inside `cargo test` on stable, on all three platforms.
`cargo fuzz` is coverage-guided and finds what a property does not think to
ask.

**Against.** `proptest` is a new dependency and needs its reason in the commit
message. `cargo fuzz` needs nightly, does not run on Windows, and is not
something CI runs for long, so it is a tool for an afternoon and a corpus to
keep.

### 19. Decide what an imported profile is trusted to do — S

- [ ] Done

**Today.** `docs/SECURITY.md` says a manual game's executable is always a path
chosen in a file dialog. A profile import sets it from the file, and Play then
runs it.

**Do.** Decide between importing executables as they are, with the count shown
before the import is confirmed, and importing without them. Then make the
document say what the code does.

**For.** A profile from somebody else stops being a list of programs to run.

**Against.** Carrying the paths is what makes a profile work on a second
machine of your own, which is the case the feature exists for.

### 20. Bring `docs/SECURITY.md` back in step — S

- [ ] Done

**Today.** Four statements no longer match: the SteamGridDB key is said to be
in an exported profile, and `profile.rs` has left it out since
`a_profile_leaves_the_steamgriddb_key_behind`; a ruleset is said to refuse
`*.key` (item 14); the agent is said to be unable to merge (item 1); every
executable is said to come from a file dialog (item 19).

**Do.** Correct each as its item lands. For the two the code can check, the
permission list and the CSP, add a test that reads `docs/SECURITY.md` and
compares it with the configuration.

**For.** A security document that is wrong is worse than none, and a test is
this project's usual answer to a comment that drifts.

**Against.** A test over prose is brittle, and fails on a reworded sentence as
readily as on a real change.

---

## Deliberately not here

Code signing for Windows and notarisation for macOS. `docs/PLAN.md` and
`docs/UPDATES.md` already argue that one: both cost money every year, and the
update signature covers the path that matters most.
