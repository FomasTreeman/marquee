# Automation

Development on Marquee runs as a loop with a person at the review step:

1. A person files an issue.
2. Claude Code works on it and opens a pull request, or asks a question with
   the `needs-decision` label.
3. CI builds and tests it on Linux, Windows and macOS. A red run is repaired
   automatically, up to three attempts.
4. A second agent run leaves a review comment.
5. **A person reviews the pull request** and enables auto-merge.
6. The merge queue brings it up to date and merges it.
7. The merge is released, and installed copies update themselves.

Workflows in `.github/workflows/` each open with a comment saying what they are
for. Where this page and a workflow disagree, the workflow is right.

## The board

```
  ┌────────┐  ┌──────────────┐  ┌────────────┐  ┌────────────────┐  ┌──────┐
  │  Todo  │  │ In Progress  │  │ In Review  │  │ Needs Decision │  │ Done │
  ├────────┤  ├──────────────┤  ├────────────┤  ├────────────────┤  ├──────┤
  │ issue  │─►│claude-working│─►│ in-review  │─►│ needs-decision │  │closed│
  │ filed  │  │ or a red PR  │  │ a green PR │  │                │  │      │
  │        │  │              │  │ ← YOUR     │  │ ← YOUR TURN    │  │      │
  │        │  │              │  │    TURN    │  │                │  │      │
  └────────┘  └──────────────┘  └────────────┘  └────────────────┘  └──────┘
```

A sixth column, **Todo (Human)**, holds `no-ai` issues until a person starts.

`board.yml` sets the column from the issue's real state: open or closed, which
pull requests close it, whether their checks pass, and its labels. It writes
the label and the card in one run, on events and in an hourly sweep, so a card
dragged by hand is put back. It is one workflow because GitHub does not run a
workflow from an event `GITHUB_TOKEN` caused, so chained workflows stalled
silently. Only issues are cards. The rules are pure functions in
`.github/scripts/board.mjs`, tested by `board.test.mjs` in `pnpm test`.

## The loop

**1. File an issue.** **Issues → New issue → Bug.** Give what you did, what
happened and what you expected; the exact search string or the game; which
machine; and the log ([DEBUGGING.md](DEBUGGING.md) says where it is).

**2. Triage.** `triage.yml` runs when an issue opens. For an issue the owner
filed, the template's "who should fix it" answer becomes the label: `claude`
for the agent, `no-ai` for a person. Anyone else's issue gets `no-ai` with a
comment, because the agent runs with the owner's credentials and takes the
issue as its brief. The maintainer can change the label. To start or restart a
run by hand, add `claude` or write `@claude` in a comment or review. On a
`needs-decision` issue a plain reply is enough.

**3. The agent works.** `claude.yml` checks out the repository, installs Rust
and Node, and runs Claude Code with the issue thread as its brief and
`CLAUDE.md` as its conventions. It labels the issue `claude-working`, ticks a
checklist in the thread, and works on `claude/issue-<number>-…`. A ruleset
refuses direct pushes to `main` from anyone. It runs `pnpm test` and clippy
before finishing and reports if either failed. A run uses the Claude
subscription, not API credits.

**4. The outcome** is a pull request with `Closes #<n>` (*In Review* once CI is
green); a question labelled `needs-decision`, when the issue is ambiguous,
cannot be reproduced or needs a decision, answered by replying in the thread;
or the issue closed with nothing to do. A run that ends any other way, such as
running out of turns, has whatever it pushed opened as a salvaged pull request.
After three runs without an outcome, the issue is labelled `needs-decision`.

**5. Review.** `review.yml` leaves a comment from a fresh agent run that sees
only the diff. It neither approves nor blocks. If it cannot post its review, it
comments to say so. CI runs on three platforms with warnings as errors, plus
the silence check, the workflow lint and every test suite. Green means it
builds and passes, not that it is right. Check that the new test fails
without the fix (the pull request should say so), that the failure is now
visible in the log, that the change is the smallest that works, and that
comments say why. For changes, write `@claude` in a review comment.

`ci-repair.yml` repairs a red pull request with the failing log as the brief:
three attempts, each announced in a comment, then `needs-decision`.

`staleness.yml` refuses a pull request that would undo work: it compares the
branch's own change with its diff against current `main`, so a branch cut from
an old `main` cannot remove what merged since. Label it `deliberate-deletion`
when the removal is the point.

**6. Merge.** Enable auto-merge on the pull request, or run
`gh pr merge <n> --squash --auto`. `main` requires branches to be up to date,
so `merge-queue.yml` updates the oldest queued pull request each time `main`
moves, CI reruns, and auto-merge lands it. A conflict goes back to the agent,
once per head commit. To land in the order auto-merge was enabled rather than
oldest first, set the repository variable `MERGE_QUEUE_ORDER` to `clicked`.
Merging closes the issue.

**7. Release.** `release.yml` waits for CI to pass on the merge commit, then
picks the version from the merged pull request's labels:

| Label on the pull request | Bump | 1.4.2 becomes |
|---|---|---|
| `breaking` | major | `2.0.0` |
| `enhancement` or `feature` | minor | `1.5.0` |
| anything else | patch | `1.4.3` |
| `no-release` | — | nothing happens |

It builds and signs installers for Apple silicon, Intel Mac, Linux and
Windows, writes `latest.json`, and publishes the draft release only once every
platform's bundle is on it. Release notes are the pull request's title. The
release holds the `.exe` and `.msi`, a `.dmg` per Mac architecture, the
`.AppImage`, `.deb` and `.rpm`, the macOS updater's `.app.tar.gz`, a `.sig` per
bundle, and `latest.json`.

Nothing is committed. The version is the higher of the files' version and the
newest tag, so the tags are the real version, not `tauri.conf.json`. To force a
release, **Actions → Release → Run workflow** and pick a bump.

**8. Update.** Installed copies check about twenty seconds after launch; see
[UPDATES.md](UPDATES.md).

**9. If the fix did not work, reopen the issue** and say what is still wrong.
The run amends the merged diff; a new issue would lose that link. If the fix
made things worse, ask for the revert.

## Safety nets

- **`pick-up-todo.yml`** hands the oldest *Todo* issue over with an `@claude`
  comment, after every agent run and hourly, because a label event fires only
  once. One issue per sweep, an hour's cooldown per issue, three attempts in
  total, and a few minutes' grace after the `claude` label so it does not start
  a second run.
- **`automation-broken.yml`** files an `@claude` issue, once per workflow, when
  a workflow fails on `main`, where there is no pull request to repair.
- **`token-check.yml`** exercises each token's job weekly and on demand, and
  prints any missing permission. It only adds and removes one label.

## Setup: Settings → Secrets and variables → Actions

**`CLAUDE_CODE_OAUTH_TOKEN`**: from `claude setup-token`, a long-lived token
for a Claude subscription. A repository secret, not an environment one, since
a required reviewer would mean approving every run. Never put it in an issue,
a commit or a chat.

**`CLAUDE_WORKFLOW_TOKEN`**: a fine-grained personal access token for this
repository only, which the agent acts as. Events caused by `GITHUB_TOKEN` start
no workflows, so without it nothing cascades; each workflow falls back to
`GITHUB_TOKEN` and says on the issue that nothing will follow.

| Permission | Why |
|---|---|
| Contents: read and write | push branches and commits |
| Pull requests: read and write | open pull requests, comment, read diffs |
| Issues: read and write | comment, label, read the thread |
| Actions: read | read the failing run it is repairing. Not write, because write could start `release.yml` |
| Workflows: read and write | a commit touching `.github/workflows/` is refused without it |

**`PROJECT_TOKEN`**: a **classic** token with only the `project` scope, since a
user-owned board has no fine-grained permission.

**`PROJECT_NUMBER`**: a variable, the number in the board's URL, default 8. The
board needs the Status options `Todo (Human)`, `Todo`, `In Progress`,
`Needs Decision`, `In Review` and `Done`.

Also tick **Settings → Actions → General → Workflow permissions → Allow GitHub
Actions to create and approve pull requests**, and put the signing key in the
`release` environment ([UPDATES.md](UPDATES.md)). Then run **Actions → Token
check → Run workflow**.

## Who can start a run

- `triage.yml` hands over only issues the owner filed.
- `claude.yml` acts on a `claude` label only when the owner added it, and on
  `@claude` only from someone with write access. The inputs `allowed_bots` and
  `allowed_non_write_users` would bypass that; neither is set. Read
  [the action's security notes](https://github.com/anthropics/claude-code-action/blob/main/docs/security.md)
  before setting them.
- Nothing runs for a fork's pull request. `ci-repair.yml` runs from
  `workflow_run`, which has secrets regardless, so it checks the head
  repository first. `claude.yml` refuses cross-repository pull requests.

Issue text is untrusted input to an agent with a checkout, so the loop ends in
a pull request a person reviews. The agent cannot merge, cannot push to
`main`, and cannot start a release.

## Labels

| Label | Means | Whose turn |
|---|---|---|
| `claude` | hand this over | — (starts the run) |
| `claude-working` | picked up, running | nobody, wait |
| `in-review` | pull request open and green | **yours** |
| `needs-decision` | blocked on a question, or three runs got nowhere | **yours** |
| `ci-failing` | the pull request is red and being repaired | nobody, wait |
| `no-ai` | keep the agent off this issue | **yours**; sits in *Todo (Human)* |
| `wont-fix-yet` | real, deliberately parked | — |
| `bug` | patch release on merge | — |
| `enhancement`, `feature` | minor release on merge | — |
| `breaking` | major release on merge | — |
| `no-release` | merge without releasing | — |
| `deliberate-deletion` | the staleness check stands aside | — |

## Troubleshooting

| Symptom | Cause |
|---|---|
| Nothing happens on `@claude` | `CLAUDE_CODE_OAUTH_TOKEN` missing, or the writer has no write access |
| An issue opens and nothing happens, with a comment saying so | `CLAUDE_WORKFLOW_TOKEN` is not set, so the `claude` label was written by a token whose events wake nothing |
| Run works, then fails at the end | Actions are not allowed to create pull requests (see Setup) |
| A commit is refused mentioning `workflow` permission | `CLAUDE_WORKFLOW_TOKEN` lacks Workflows: read and write |
| Cards never move | `PROJECT_TOKEN` missing, or `PROJECT_NUMBER` is not your board's number |
| Board fails naming a Status | the board has no option with that exact name; the error lists the ones it has |
| Release builds but will not sign | the key is not in the `release` environment; see [UPDATES.md](UPDATES.md) |
| "Wrong password for that key" | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` has a placeholder in it. The key has no password, so **delete the secret** |
| "Branch main is not allowed to deploy to release" | the `release` environment's deployment rule must allow the branch `main`, not a tag pattern |
| No release after a merge | the pull request was labelled `no-release`, or CI is red on `main` |
| Release stays a draft | one platform's build failed; open the run. Drafts are invisible to the updater |
| App never offers an update | no `latest.json` on the release: `createUpdaterArtifacts` is off or the build did not finish |
| An automation workflow is red on `main` | an issue has been filed; look for `claude` issues titled after the workflow |
| A green Review check and no review comment | the reviewer could not post and should have commented so; if that is missing too, `pull-requests: write` has gone from `review.yml` |
| Agent runs *cancelled* in pairs | two triggers reached the same issue within a minute. The `claude-<number>` concurrency group keeps one; the cancelled run did no work |
