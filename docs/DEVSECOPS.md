# DevSecOps: what is in place and what is left

A working list. The first table is what the repository already does. After
that are twenty things it does not do yet, each with the current state, the
change, and the pros and cons.

It comes from a review on 4 October 2026 of the workflows, the repository
settings and the release process. Settings can change without a commit, so
check the "Now" line before starting an item.

Effort: **S** is a setting or a few lines, **M** is an evening, **L** reworks a
workflow.

## Already in place

| Technique | Where | Cost |
|---|---|---|
| Actions pinned to a commit SHA, with a lint that rejects a tag | `tools/check-workflows.py` | Pins go stale unless Dependabot bumps them |
| Explicit `permissions` and `timeout-minutes` on every job | `tools/check-workflows.py` | None |
| Event data passed to scripts through `env:`, not `${{ }}` | `tools/check-workflows.py` | The lint only checks `run:` steps (item 6) |
| Signing key in a `release` environment that only `main` can use | `release.yml` | A pull request cannot test signing |
| Release built as a draft, checked, then published | `release.yml` | Four builds in series, about half an hour |
| Release waits for green CI on the exact commit | `release.yml` | A slow CI queue delays a release |
| Secret scanning with push protection | Repository setting | None |
| Private vulnerability reporting | Repository setting | None |
| Dependabot security updates for cargo and npm | Repository setting | None |
| `pull_request_target` only checks out the base branch | `board.yml` | The script cannot see the pull request's code |
| Agent runs start only for the maintainer, with a fixed tool list | `claude.yml` | See item 1 |
| Strict CSP and four Tauri permissions | `tauri.conf.json`, `capabilities/default.json` | Inline styles are allowed |
| No shell on any launch path, plus a URI allowlist | `run.rs` | None |

## Suggested order

1. Settings, which are quick and easy to undo: items 2, 3, 5, 9, 10, 12, 14.
2. Checks that run in CI: items 6, 7, 11, 15, 16.
3. The application and its security document: items 17 to 20.
4. The larger changes: items 1, 8 and 13.
5. Item 4, if at all.

---

## Who can change `main`

### 1. Give the agent its own identity and require one approval (L)

- [ ] Done
- **Now:** `main` needs a pull request and green CI but zero approvals. The
  agent uses a personal access token, so GitHub sees its pull requests as the
  maintainer's. The human review happens, but GitHub does not enforce it.
- **Do:** Create a GitHub App for the agent and mint its token per run with
  `actions/create-github-app-token`. Require one approving review. Let the
  admin role bypass, so the maintainer's own pull requests still merge. Add
  `CODEOWNERS` for `.github/`, `tauri.conf.json` and `capabilities/`.
- **Pros:** The author of a change cannot approve it, and GitHub enforces that.
  App tokens expire after an hour. This is also the base for giving separate
  agent roles separate permissions.
- **Cons:** The biggest change here, since every workflow that uses the token
  changes. The App's private key is a new secret to look after. A session on
  the maintainer's own machine still acts as the maintainer.

### 2. Protect `v*` tags (S)

- [ ] Done
- **Now:** The only ruleset covers branches. A token with write access can move
  or delete a version tag.
- **Do:** Add a tag ruleset for `v*` that blocks update and deletion. Leave
  creation open, because the release workflow creates the tag.
- **Pros:** A version always points at the same commit.
- **Cons:** A stray tag can still be created. Removing a mistaken tag means
  switching the rule off first.

### 3. Immutable releases (S)

- [ ] Done
- **Now:** Off. Files on a published release, including the update manifest,
  can be replaced later. The bundles are signed but the version number in the
  manifest is not, so an older signed build could be offered as a newer one.
- **Do:** Settings → General → Releases → enable release immutability.
- **Pros:** One setting, no workflow change. The release already goes
  draft-then-publish, which is what this needs.
- **Cons:** A bad release cannot be fixed in place, only replaced by a new
  version. Anything else attached to a release must be added while it is a
  draft.

### 4. Signed commits on `main` (S)

- [ ] Done
- **Now:** Not required.
- **Do:** Allow squash merges only, then require signatures in the ruleset.
- **Pros:** Every commit on `main` shows as verified.
- **Cons:** With squash merges the signature is GitHub's, so it says little
  about who wrote the change. Low value; do it last.

---

## The pipeline

### 5. Static analysis with CodeQL (S)

- [ ] Done
- **Now:** Not configured. CodeQL supports all four languages here: Rust,
  TypeScript, Python and Actions workflows.
- **Do:** `gh api -X PATCH repos/FomasTreeman/marquee/code-scanning/default-setup -f state=configured`
- **Pros:** Free for a public repository. Results show on pull requests and in
  the Security tab. It also scans the workflows.
- **Cons:** Default setup is a setting, not a file, so it does not show in the
  repository. Rust support is the newest. False positives need triaging.

### 6. A dedicated workflow linter (M)

- [ ] Done
- **Now:** `tools/check-workflows.py` checks pins, permissions, timeouts and
  script injection in `run:` steps. It does not look inside `script:` or
  `with:` blocks.
- **Do:** Add `zizmor` for security checks and `actionlint` for the shell
  scripts. Keep the Python lint for project-specific rules.
- **Pros:** Maintained rule sets that cover far more than a home-made check.
- **Cons:** The first run will be noisy and each exception needs recording. Two
  more tools that overlap an existing one.

### 7. Dependency auditing with cargo-deny (M)

- [ ] Done
- **Now:** Nothing in CI checks the 531 crates or the npm packages against an
  advisory database. One Dependabot alert has been open since 2 September with
  no decision: `glib` 0.18.5 (GHSA-wrw7-89jp-8q8g), which comes in through
  Tauri on Linux and cannot be upgraded from here.
- **Do:** Add `src-tauri/deny.toml` and run `cargo deny check` in CI and on a
  weekly schedule. Add `pnpm audit --prod`. Record the `glib` decision as an
  ignore with a reason and dismiss the alert.
- **Pros:** Covers advisories, licences and where crates come from in one tool.
  Accepted risks are written down with a reason.
- **Cons:** Tauri's Linux dependencies will raise about a dozen "unmaintained"
  warnings to ignore on day one. A new advisory can turn CI red on an unrelated
  pull request.

### 8. Build provenance and an SBOM (M)

- [ ] Done
- **Now:** Releases carry the updater's signature files only. The `.dmg` files
  have no signature at all. Nothing links a download to the commit and workflow
  that built it.
- **Do:** Add `actions/attest-build-provenance` after the build, generate a
  CycloneDX SBOM with `cargo cyclonedx`, and attach both to the draft release.
  Document `gh attestation verify` in the README.
- **Pros:** Anyone can verify a download was built by this repository's release
  workflow. No new key to manage. An SBOM shows what went into each release.
- **Cons:** It proves where a file was built, not that the code is safe. It
  adds `id-token: write` to the job that holds the signing key. Few users will
  verify.

### 9. Read-only workflow token by default (S)

- [ ] Done
- **Now:** The repository default is `write`. Every job sets its own
  permissions, so the default only applies if the lint misses one.
- **Do:** `gh api -X PUT repos/FomasTreeman/marquee/actions/permissions/workflow -f default_workflow_permissions=read`,
  then run the Board workflow by hand to confirm it can still write.
- **Pros:** Least privilege even when a job forgets to declare it.
- **Cons:** A comment in `ci.yml` says a read default stops jobs asking for
  write. GitHub's documentation says otherwise, but test it and fix whichever
  is wrong.

### 10. Let GitHub enforce action pinning (S)

- [ ] Done
- **Now:** Any action is allowed and GitHub's own SHA-pinning requirement is
  off. Pinning is enforced by the project's lint, which a pull request could
  edit.
- **Do:** Settings → Actions → General: allow selected actions only, list the
  six owners in use, and require a full SHA.
- **Pros:** A pull request cannot weaken a repository setting.
- **Cons:** Adding an action needs a settings change first. Check whether the
  rule also applies to actions called from inside other actions.

### 11. Pin the toolchains (M)

- [ ] Done
- **Now:** Rust uses whatever `stable` is that day, pnpm is "9", and Node is
  20, which reached end of life in April 2026. Cargo never runs with
  `--locked`. This has already caused a failure: CI on the pull request that
  added this file went red because a new Rust release deprecated a function.
- **Do:** Add `rust-toolchain.toml` with an exact version, a `packageManager`
  field for pnpm, and a current Node LTS through `.nvmrc`. Pass `--locked` to
  cargo in CI. Move to pnpm 10, which does not run dependency install scripts
  unless they are listed.
- **Pros:** The same commit builds the same way next month. Toolchain upgrades
  arrive as their own pull request.
- **Cons:** Pins need something to bump them. The release job edits the version
  in `Cargo.toml`, so `--locked` there needs the lock file edited too.

### 12. A Dependabot cooldown (S)

- [ ] Done
- **Now:** Action updates are proposed weekly with no waiting period, so a
  release from yesterday can be proposed for the signing job today.
- **Do:** Add `cooldown: { default-days: 7 }` in `.github/dependabot.yml`.
- **Pros:** One line. Most compromised releases are caught within days.
- **Cons:** Ordinary fixes also wait a week. Security updates are not delayed.

### 13. Keep the signing key away from the build (L)

- [ ] Done
- **Now:** The key has no password, which `docs/UPDATES.md` explains. It is
  present for the whole build step, which runs every dependency's build code.
  There is no written procedure for a lost or leaked key.
- **Do:** In order of cost: write the key rotation procedure; stop restoring a
  build cache in the release job; then split the job so one builds with no
  secrets and another only signs.
- **Pros:** Dependency code never runs alongside the key. The rotation
  procedure is useful whatever else happens.
- **Cons:** The split reworks the most fragile workflow in the repository, and
  the Tauri bundler expects the key at build time. No cache means slower
  releases.

### 14. Wider secret scanning (S)

- [ ] Done
- **Now:** Provider patterns and push protection are on. Generic patterns and
  validity checks are off. `docs/SECURITY.md` says a ruleset blocks `*.key`
  files, but no such rule exists; only `.gitignore` does that.
- **Do:** Turn on the two settings if they are offered. Add a check under
  `tools/` for the prefix every Tauri private key starts with
  (`dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5`). Correct the
  document.
- **Pros:** Catches the key under any filename. No new dependency.
- **Cons:** A CI check runs after the push, which on a public repository is
  already too late. It shortens exposure but does not prevent it.

### 15. OpenSSF Scorecard (S)

- [ ] Done
- **Now:** Not present.
- **Do:** Add the `ossf/scorecard-action` workflow and put the badge in the
  README.
- **Pros:** An independent, public score that is re-checked weekly.
- **Cons:** Some checks assume a team, so a solo project scores low on code
  review whatever it does. One more third-party action.

### 16. Network monitoring on the release job (M)

- [ ] Done
- **Now:** A release build can connect to any host.
- **Do:** Add `step-security/harden-runner` in audit mode, review what the
  build contacts, then switch to blocking everything else.
- **Pros:** A build that can only reach crates.io, npm and GitHub cannot send
  the key anywhere else. Cheaper than item 13.
- **Cons:** It adds a third-party tool to the most sensitive job. Check how
  well blocking works on the macOS and Windows runners.

---

## The application

### 17. Limit artwork downloads (S)

- [ ] Done
- **Now:** `usable()` in `art.rs` downloads a response of any size and decodes
  it with no limits. SteamGridDB images are uploaded by its users.
- **Do:** Cap the download size, set `image::Limits` on the decoder, and log
  when something is refused. Add a test with an oversized image.
- **Pros:** A hostile or broken image cannot exhaust memory.
- **Cons:** A cap set too low silently drops real artwork, so the refusal must
  be logged.

### 18. Fuzz or property-test the parsers (M)

- [ ] Done
- **Now:** The Steam file parser is written defensively but has no fuzz target
  or property tests.
- **Do:** Add `proptest` tests, or `cargo fuzz` targets, for the Steam parsers,
  `SourceKey::parse` and `open_uri`.
- **Pros:** `proptest` runs in the normal test suite on every platform.
  `cargo fuzz` finds inputs nobody thought to try.
- **Cons:** `proptest` is a new dependency. `cargo fuzz` needs nightly Rust and
  does not run on Windows.

### 19. Decide how far to trust an imported profile (S)

- [ ] Done
- **Now:** A profile import sets each game's executable path from the file, and
  Play runs it. `docs/SECURITY.md` says an executable is always chosen in a
  file dialog.
- **Do:** Either show how many executables a profile sets before importing, or
  import without them. Update the document to match.
- **Pros:** A profile from someone else cannot quietly add programs to run.
- **Cons:** Carrying the paths is what makes a profile useful on your own
  second machine.

### 20. Bring `docs/SECURITY.md` up to date (S)

- [ ] Done
- **Now:** Four statements no longer match the code or settings: the
  SteamGridDB key being in an exported profile, a ruleset blocking `*.key`, the
  agent being unable to merge, and every executable coming from a file dialog.
- **Do:** Correct each one as items 1, 14 and 19 land. Add a test that compares
  the permissions and CSP in the document with the real configuration.
- **Pros:** A security document that is wrong is worse than none.
- **Cons:** Tests over prose break on rewording.

---

## Not planned

Windows code signing and macOS notarisation. Both cost money every year, and
`docs/UPDATES.md` explains why the update signature is enough for now.
