# From "that's broken" to "it updated itself"

Marquee is maintained by one person and a lot of automation. This is what the
automation does, what it needs from you, and what to check when it stops.

The short version: **you write down what is broken, read a pull request, and
click auto-merge.** An agent writes the fix, CI checks it on three platforms,
a second agent reviews it, the merge lands itself, the release builds itself,
and the machine in the lounge installs it.

Everything below lives in `.github/workflows/`. Each file opens with a comment
saying what it is for and which failure it exists because of, and those
comments are the authority when this page and a file disagree.

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

  ┌────────────────┐
  │  Todo (Human)  │  a no-ai issue nobody has picked up yet. It moves through
  ├────────────────┤  the same columns as any other once a person is working
  │     no-ai      │  on it.
  └────────────────┘
```

Two columns want you. Everything else moves on its own.

**The labels and the issue's real state are the source of truth; the column
follows them.** `board.yml` reads what is true about an issue — open or
closed, which pull requests close it, whether their checks pass, which labels
it carries — and writes the label and the card in the same run. Drag a card by
hand and the next sweep puts it back, which is the right way round: a board
that disagrees with the labels is a board nobody trusts.

It works this way because the first version did not. Three workflows shared
the job and chained through label events, and **GitHub will not run a workflow
off an event that `GITHUB_TOKEN` caused.** A label written by one was
invisible to the next, the card never moved, and nothing failed anywhere. One
workflow reading facts depends on no second trigger, so nothing can be
suppressed; and it sweeps hourly as well as running on events, so a dropped
event costs a delay rather than a permanently wrong board.

**Only issues are cards.** A pull request speaks for the issues it closes.
Putting both on the board meant thirty-four pull request cards beside thirteen
issues, which is a board nobody reads.

The rules are `.github/scripts/board.mjs`, pure functions over plain data,
tested without a network by `board.test.mjs`. `pnpm test` runs them.

## The loop

### 1. File an issue

**Issues → New issue → Bug.** The template asks for the things that decide
whether you get a real fix or a confident wrong one:

- **What you did, what happened, what you expected.** In that order.
- **The exact string you typed** if it involves search, and **the game** if it
  involves artwork. "Rocket League returns nothing" is a bug report; "search is
  broken" is a mood.
- **Which machine.** Windows and macOS diverge here more than anywhere else,
  and a tenth of the Rust never compiles on the development machine.
- **The log.** Most of this app's failures are silent on screen and loud in
  the file; that is deliberate, so use it. [DEBUGGING.md](DEBUGGING.md) says
  where it is on each platform.

A rough issue with a log beats a beautiful one without.

### 2. It is handed over, or not

`triage.yml` runs once when the issue opens and answers one question: whose
is it. The template's dropdown asks who should fix it, and for an issue filed
by the repository owner that answer becomes the label — **`claude`** to hand
it over, or **`no-ai`** for "me, do not touch it". Filing the issue is the
trigger; there is nothing to remember.

An issue filed by anyone else gets `no-ai` whatever the dropdown said, with a
comment saying so. The agent runs with the owner's credentials and a checkout
of the repository, and its brief is the issue text, so who wrote that text
matters. Swapping the label for `claude` is the maintainer's decision, and it
takes one click.

The explicit routes still exist, for an issue filed before you wanted it worked
on or to send one back round: add the `claude` label, or write `@claude` in a
comment or a pull request review. On a `needs-decision` issue a plain reply is
enough; the answer is the restart and it does not need a magic word.

### 3. The agent works

`claude.yml` checks out the repository with full history, installs the Rust
and Node toolchains, and runs Claude Code with the issue thread as its brief.
It reads `CLAUDE.md` first, so it works to this project's conventions rather
than generic ones, including the one that matters most here: **a fix is not
finished until something fails when it regresses.**

It labels the issue `claude-working` (*In Progress*), ticks a checklist in the
issue thread as it goes, and works on a branch named `claude/issue-<number>-…`.
It cannot touch `main`: a repository ruleset refuses direct pushes from
anyone, which is enforcement rather than etiquette. It runs `pnpm test` and
clippy before claiming to be done, and is told to say so plainly if either
failed.

A run costs a few minutes and counts against the Claude subscription, not API
credits.

### 4. One of three things happens

**A pull request** with `Closes #<n>` in the body. The issue moves to *In
Review* once CI is green on it; while CI is red the card stays in *In
Progress*, because a pull request that does not build is not yours to read
yet.

**A question**, labelled `needs-decision`. Stopping is a valid outcome and the
agent is told so: if the issue is ambiguous, cannot be reproduced, or needs a
decision that is not its to make, it says what it found, asks one specific
question, and stops rather than opening a speculative pull request. Reply in
the thread and it picks up with your answer as context. **Filter the board by
`needs-decision` to see everything waiting on you.**

**The issue closed**, because there was nothing to do.

A run that ends anywhere else — out of turns, a tool it was not allowed — has
whatever it pushed turned into a pull request marked as salvaged, so the work
is somewhere you can see it rather than gone. An issue that has had three runs
without reaching one of the three outcomes is labelled `needs-decision` and
left alone.

### 5. Review

Two things have already happened by the time you open the pull request.

`review.yml` has left a comment: a fresh agent run with no memory of writing
the change, reading only the diff. It does not approve or block; it tells you
where to look, so you do not arrive at three hundred lines cold at eleven at
night.

CI has run on Linux, Windows and macOS with warnings as errors, plus the
silence check, the workflow lint and every test suite. **Green means it
compiles and the tests pass. It does not mean the fix is right.** What to look
at, in the order these have actually gone wrong here:

1. **Does the new test fail without the fix?** The pull request should say
   so. A test that passes against the broken code is worse than no test, and
   that has happened more than once.
2. **Is the failure audible now?** Silent degradation is this project's whole
   disease. A fix that leaves the next occurrence invisible is half a fix.
3. **Is it the smallest change that works?** Look for scope that crept in.
4. **Does the comment say why, not what?**

Want changes? `@claude` in a review comment, and it picks up from there with
the review as context.

**If CI goes red on the pull request, it is fixed without being asked.**
`ci-repair.yml` watches CI finish and, on a failing run for an open pull
request, starts an agent run whose brief is the failing log. Three attempts,
each announced in a comment; after the third it labels the pull request
`needs-decision` and stops, because an agent that has not fixed something in
three goes will not find it on the ninth.

**A pull request that would undo work is refused.** `staleness.yml` compares
the branch's own change with its diff against today's `main`. A branch cut
from an old `main` passes its own CI while its merge silently removes
everything landed since — five branches were one click from doing exactly
that. A removal that is the point of the change can carry the label
`deliberate-deletion` to stand the rule aside.

### 6. Merge

When it is right, **enable auto-merge** — the button on the pull request, or
`gh pr merge <n> --squash --auto`. That is the whole of the merge step.

`main` requires a branch to be up to date before it merges, so every merge
puts every other open pull request behind. `merge-queue.yml` brings the oldest
queued one up to date each time `main` moves, CI reruns on it, and auto-merge
lands it. Queue four and they land one after another without further clicks.
A branch that conflicts is handed back to the agent to resolve, once per head
commit, and stays in the queue.

They land oldest first. If the order matters — a one-line fix that should not
wait behind a refactor — set the repository variable `MERGE_QUEUE_ORDER` to
`clicked` and they land in the order auto-merge was enabled. Delete the
variable to go back.

Merging closes the issue and moves the card to *Done*.

### 7. The release happens by itself

`release.yml` waits for CI to be green on the merge commit — the bundler only
compiles, and before this wait a merge that built and broke the suite was
signed and shipped to every installed copy — then decides the version from
the labels on the pull request that was merged:

| Label on the pull request | Bump | 1.4.2 becomes |
|---|---|---|
| `breaking` | major | `2.0.0` |
| `enhancement` or `feature` | minor | `1.5.0` |
| anything else | patch | `1.4.3` |
| `no-release` | — | nothing happens |

It injects that version into the working copy, builds and signs installers
for Apple silicon, Intel Mac, Linux and Windows, writes `latest.json`, and
attaches everything to a draft release that is published only once every
platform's bundle is on it. Before that it published as it went, and for the
twenty-five minutes Windows took to build, Windows machines were told they
were up to date. The release notes are the pull request's title.

**There is no version number for anyone to type**, and nothing is committed:
the next version is whichever is higher, the version in the files or the
newest tag, so it cannot collide with a tag that exists. That means the
version in `tauri.conf.json` is not the version; the tags are. To force a
release, **Actions → Release → Run workflow** and pick a bump.

What lands on the releases page:

```
marquee_1.4.3_x64-setup.exe        Windows installer
marquee_1.4.3_x64_en-US.msi        Windows, the other kind
marquee_1.4.3_aarch64.dmg          macOS, Apple silicon
marquee_1.4.3_x64.dmg              macOS, Intel
marquee_1.4.3_amd64.AppImage       Linux, any distribution
marquee_1.4.3_amd64.deb            Linux, Debian and Ubuntu
marquee-1.4.3-1.x86_64.rpm         Linux, Fedora and friends
*.app.tar.gz                       what the macOS updater downloads
*.sig                              a signature per bundle
latest.json                        what the updater reads
```

The `.sig` files and `latest.json` exist because `bundle.createUpdaterArtifacts`
is `true`. Without it Tauri builds perfectly good installers and no updater
artifacts, and the symptom is an app that never finds an update while the
release page looks fine. [UPDATES.md](UPDATES.md) has the updater's side.

### 8. The machine in the lounge updates itself

Either wait — Marquee checks about twenty seconds after launch and offers the
update when nothing else is open, never over a running game, and "Not now" is
remembered for that version — or ask, with **Settings → Updates → Check for
updates**, which says what it found including "up to date". Every bundle is
verified against the public key compiled into the copy already running.

### 9. When the fix did not work

Nothing broke, CI stayed green, the release installed, and the thing the issue
described is still happening. No workflow can notice that; you do.

**Reopen the issue and say in a comment what is still wrong.** Reopening
starts a run, and because the issue already has a merged pull request the
brief says so: start from that diff rather than the issue text, and amend it
rather than revert it. Do not file a new issue — it loses the link to the fix
that did not work, and the agent starts from scratch and, as often as not,
rediscovers the same fix. If the fix made things worse, say so and ask for the
revert; that is the one case where the agent is told not to guess.

## The safety nets

Each of these exists because the thing it catches happened.

**`pick-up-todo.yml`.** An issue in *Todo* has, by definition, already spent
its trigger — a label event fires once. Four issues sat there for hours while
the card said "queued". This sweeps after every agent run and hourly, and
hands the oldest waiting issue over with an `@claude` comment. One per sweep,
an hour's cooldown per issue, three attempts in total.

**`automation-broken.yml`.** A workflow failing on `main` has no branch and no
pull request, so there was nowhere for a repair to go, and the board failed
every run for half an hour with the only sign a cross on a tab nobody had
open. This files an issue with `@claude` in the body, once per workflow, and
the ordinary loop takes it from there.

**`token-check.yml`.** A token short of one permission does not fail loudly:
the board moves cards but never touches a label, or the agent opens a pull
request but cannot comment, and each looks like a different bug. This tries
each token's job for real, weekly and on demand, and prints which permission
is missing. Read-only except for one label added and removed.

## Setting it up

Everything is a secret or a variable under **Settings → Secrets and variables
→ Actions**, except where it says otherwise.

**`CLAUDE_CODE_OAUTH_TOKEN`** — from `claude setup-token`, which authorises
against a Claude subscription and prints a long-lived token. A repository
secret, not an environment one: the workflow fires on comments, and an
environment with a required reviewer would mean approving every run. It is a
credential for the account; never put it in an issue, a commit or a chat
window.

**`CLAUDE_WORKFLOW_TOKEN`** — a fine-grained personal access token scoped to
this repository alone. It is what the agent acts as, and it is why anything
cascades: GitHub will not run a workflow off an event `GITHUB_TOKEN` caused,
so a label or a comment written by the workflow's own token wakes nothing.
Every workflow falls back to `GITHUB_TOKEN` when it is unset and says on the
issue that nothing will follow.

| Permission | Why |
|---|---|
| Contents: read and write | push branches and commits |
| Pull requests: read and write | open pull requests, comment, read diffs |
| Issues: read and write | comment, label, read the thread |
| Actions: read | read the failing run it is repairing — read, not write, because write could start `release.yml` |
| Workflows: read and write | a commit touching `.github/workflows/` is refused without it, with a message that reads like a bug in the action |

**`PROJECT_TOKEN`** — a **classic** token with the `project` scope and nothing
else. A user-owned Projects board has no fine-grained permission, so classic
is the only kind that reaches it, and classic scopes are coarse; keeping it to
`project` means a token whose job is moving cards cannot reach a repository.
Labels and issues are handled by the workflow's own `GITHUB_TOKEN`, which
cannot see the board and does not need to.

**`PROJECT_NUMBER`** — a repository variable, the number in the board's URL.
Defaults to 8. The board needs six Status options: `Todo (Human)`, `Todo`,
`In Progress`, `Needs Decision`, `In Review`, `Done`. If one is missing the
automation fails naming the ones it found.

**Settings → Actions → General → Workflow permissions:** tick *Allow GitHub
Actions to create and approve pull requests*. Without it a run does the work
and fails at the last step.

**The signing key** goes in the `release` environment, not in repository
secrets. [UPDATES.md](UPDATES.md) explains why and what to do about the
password. Nothing produces a usable release without it.

Then **Actions → Token check → Run workflow** proves all of it rather than
guessing.

## Who can start a run

The repository is public, so it is worth being precise about who can spend
the subscription and put the owner's credentials to work.

- `triage.yml` hands over only issues the owner filed. Everyone else's get
  `no-ai` until a maintainer changes it.
- `claude.yml` acts on a `claude` label only when the owner added it, and on
  `@claude` only from someone with write access, checked on issues, comments
  and reviews. Two action inputs disable that check — `allowed_bots` and
  `allowed_non_write_users` — and neither is set. Do not set them without
  reading [the action's security notes](https://github.com/anthropics/claude-code-action/blob/main/docs/security.md).
- Nothing runs against a pull request from a fork. `ci-repair.yml` fires from
  `workflow_run`, which carries secrets whatever the triggering run had, so it
  checks the head repository before doing anything, and `claude.yml` refuses
  a cross-repository pull request outright.

Issue text is still untrusted input being read by an agent with a checkout of
the repository. That is the residual risk, and it is why the loop ends in a
pull request a person reads rather than a push to `main`. The agent cannot
merge, cannot push to `main`, and cannot start a release.

## The labels

| Label | Means | Whose turn |
|---|---|---|
| `claude` | hand this over | — (starts the run) |
| `claude-working` | picked up, running | nobody, wait |
| `in-review` | pull request open and green | **yours** |
| `needs-decision` | blocked on a question, or three runs got nowhere | **yours** |
| `ci-failing` | the pull request is red and being repaired | nobody, wait |
| `no-ai` | keep the agent off this issue | **yours** — sits in *Todo (Human)* |
| `wont-fix-yet` | real, deliberately parked | — |
| `bug` | patch release on merge | — |
| `enhancement`, `feature` | minor release on merge | — |
| `breaking` | major release on merge | — |
| `no-release` | merge without releasing | — |
| `deliberate-deletion` | the staleness check should stand aside | — |

## When it goes wrong

| Symptom | Cause |
|---|---|
| Nothing happens on `@claude` | `CLAUDE_CODE_OAUTH_TOKEN` missing, or the writer has no write access |
| An issue opens and nothing happens, with a comment saying so | `CLAUDE_WORKFLOW_TOKEN` is not set, so the `claude` label was written by a token whose events wake nothing |
| Run works, then fails at the end | Actions are not allowed to create pull requests (see above) |
| A commit is refused mentioning `workflow` permission | `CLAUDE_WORKFLOW_TOKEN` lacks Workflows: read and write |
| Cards never move at all | `PROJECT_TOKEN` missing, or `PROJECT_NUMBER` is not your board's number |
| Board fails naming a Status | the board has no option with that exact name; the error lists the ones it has |
| Release builds but will not sign | the key is not in the `release` environment; [UPDATES.md](UPDATES.md) |
| "Wrong password for that key" | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` has a placeholder in it. The key has no password, so **delete the secret** |
| "Branch main is not allowed to deploy to release" | the `release` environment's deployment rule must allow the branch `main`, not a tag pattern |
| No release after a merge | the pull request was labelled `no-release`, or CI is red on `main` |
| Release stays a draft | one platform's build failed; open the run. Drafts are invisible to the updater |
| App never offers an update | no `latest.json` on the release: `createUpdaterArtifacts` is off or the build did not finish |
| An automation workflow is red on `main` | an issue has been filed for it; look for `claude` issues titled after the workflow |

## What this loop is not

It is not a licence to skip review. The arrangement is one where a machine
writes and a person decides, and the person is the part that makes it safe.
Marquee launches executables on your machine and updates itself; a patch
nobody read is a patch nobody read, whoever wrote it.
