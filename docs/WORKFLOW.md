# From "that's broken" to "it updated itself"

The whole loop, and what you actually have to do at each point. Short version:
you write down what's broken, tick a label, read a pull request, and press two
buttons.

## The board

```
  ┌────────┐  ┌──────────────┐  ┌────────────┐  ┌────────────────┐  ┌──────┐
  │  Todo  │  │ In Progress  │  │ In Review  │  │ Needs Decision │  │ Done │
  ├────────┤  ├──────────────┤  ├────────────┤  ├────────────────┤  ├──────┤
  │ issue  │─►│claude-working│─►│ in-review  │─►│ needs-decision │  │merged│
  │ filed  │  │              │  │            │  │                │  │      │
  │        │  │              │  │ ← YOUR     │  │ ← YOUR TURN    │  │      │
  │        │  │              │  │    TURN    │  │                │  │      │
  └────────┘  └──────────────┘  └────────────┘  └────────────────┘  └──────┘
```

Two columns want you. Everything else runs on its own.

The **labels are the source of truth** and the columns follow them, not the
other way round — `.github/workflows/project-automation.yml` recomputes the
column from the issue's current labels and state on every change. Drag a card
by hand and the next label change will put it back, which is the right way
round: a board that disagrees with the labels is a board nobody trusts.

**Setting it up** — one command, then two clicks:

```bash
gh auth refresh -s project        # your token cannot see Projects yet
gh project create --owner FomasTreeman --title Marquee
```

Or make it in the browser: **your profile → Projects → New project → Board**.

**Add the two Status options the default board does not have.** Project →
Settings → Fields → Status. It ships with `Todo`, `In Progress` and `Done`;
add **`In Review`** and **`Needs Decision`**. Capitals matter — the automation
throws with the list of names your board actually has if one does not match, so
a typo tells you what it is rather than quietly doing nothing.

Then **⋯ → Settings → Workflows** and switch on the three built-in ones:

| Workflow | What it does |
|---|---|
| *Item added to project* → Todo | new issues land in the first column |
| *Item closed* → Done | a merged fix leaves the board |
| *Pull request merged* → Done | same, from the PR side |

Finally **Settings → Manage access → link the `marquee` repository**, so issues
land on it automatically.

The labels do the rest, and Claude maintains them itself — see below.

## 1. You file an issue

**Issues → New issue → Bug.** The template asks for four things, and they are
the four that decide whether you get a real fix or a confident wrong one:

- **What you did, what happened, what you expected.** In that order.
- **The exact string you typed.** `rocket league` is a bug report. "Search is
  broken" is a mood.
- **Which machine.** Windows and macOS diverge here more than anywhere else —
  roughly a tenth of the Rust never compiles on the development machine.
- **The log.** Most of this app's failures are silent on screen and loud in
  the file. That's deliberate. Use it.

> Windows `%LOCALAPPDATA%\Marquee\logs\marquee.log`
> macOS `~/Library/Logs/Marquee/marquee.log`
> Linux `~/.local/state/marquee/marquee.log`

You do **not** have to write it up perfectly. A rough issue with a log beats a
beautiful one without.

## 2. You hand it over — actually, you don't

**Opening the issue is the trigger.** Claude picks up every new issue on its
own. Nothing to remember, nothing to click.

The explicit ways still work, for an issue filed before you wanted it worked
on, or to send one back round after a review:

- add the **`claude`** label
- write **`@claude`** in a comment, or in a pull request review

And to keep it off one: the **`no-ai`** label. Some issues are notes to self,
and a note to self does not need a patch.

## 3. Claude works

It checks out the repository with full history, installs the Rust and Node
toolchains, reads `CLAUDE.md`, and gets on with it. Progress appears as a
**ticked checklist in the issue thread**, so a long run is legible rather than
a spinner.

It labels the issue **`claude-working`** when it starts. On the board, that's
*In progress*.

Its work goes on a branch named `claude/issue-<number>-<what-it-is>`, so the
branch list reads like a queue rather than a pile of `patch-1`s. **It cannot
touch `main`** — a repository ruleset refuses any direct push, from anyone.
That is enforcement, not etiquette.

It runs `pnpm test` and clippy before claiming to be done, and is told to say
so plainly if either failed rather than describing the work as finished.

**Typical run: a few minutes.** It counts against your Claude subscription, not
API credits.

## 4. One of two things happens

### It opens a pull request → *In Review*

Linked to the issue with `Closes #12`, which is what closes the issue when you
merge and moves the card to Done. It swaps `claude-working` for `in-review`.

### It gets stuck → **`needs-decision`**, and that's your turn

It is explicitly told that stopping is a valid outcome. If the issue is
ambiguous, if it can't reproduce it, or if the fix needs a decision that isn't
its to make, it comments with what it found and **one specific question**, adds
`needs-decision`, and stops rather than opening a speculative PR.

Answer in the thread and say `@claude` again. It picks up with your answer as
context.

**Filter the board by `needs-decision` to see everything waiting on you.**

## 5. You review

CI runs on Linux, Windows and macOS with warnings as errors, plus the silence
check, the token check, and both test suites.

**Green CI means it compiles and the tests pass. It does not mean the fix is
right.** What to actually look at, in the order these have gone wrong here:

1. **Does the new test fail without the fix?** The PR should say so. A test
   that passes against the broken code is worse than no test — that has
   happened here more than once.
2. **Is the failure audible now?** Silent degradation is this project's whole
   disease. A fix that leaves the next occurrence invisible is half a fix.
3. **Is it the smallest change that works?** Look for scope that crept in.
4. **Does the comment say *why*, not *what*?**

Want changes? `@claude` in a review comment. It picks up from there.

Merge when happy. The issue closes itself, the card moves to Done.

## 6. The release happens by itself

**You do nothing.** Merging is the release.

The moment a pull request lands on `main`, the Release workflow reads the
labels on the pull request that was merged and decides the version from them:

| Label on the PR | Bump | 1.4.2 becomes |
|---|---|---|
| `breaking` | major | `2.0.0` |
| `enhancement` or `feature` | minor | `1.5.0` |
| anything else | patch | `1.4.3` |
| `no-release` | — | nothing happens |

Then it writes that version into `tauri.conf.json`, `package.json` and
`Cargo.toml`, commits, tags, builds and signs installers for Apple silicon,
Intel Mac, Linux and Windows, writes the `latest.json` manifest, and
**publishes** the release. The notes are the pull request's own title, which is
a real sentence about what changed.

**There is no version number for anyone to type**, which is the point. Typing
one is how the first attempt failed: a hand-made `v0.2.0` tag against a
`tauri.conf.json` that still said `0.0.1`, and a build that refused to run.

The next version comes from **whichever is higher, the version in the file or
the newest tag**, so it cannot collide with a tag that already exists however
the repository got into its current state.

Want to force one? **Actions → Release → Run workflow** and pick a bump. That
is an override, not the normal path.

### Why it publishes rather than drafting

The human gate moved earlier. You already read the change as a pull request,
which is a better place to catch something than a release page — and a draft
release is invisible to the updater, because `/releases/latest` ignores drafts.
That was the shape of the first bug: a release nothing could see.

If you want a pause anyway, put one on the `release` environment: **Settings →
Environments → release → Required reviewers**. The build then waits for your
click before it signs anything.

### What lands on the releases page

Real downloads, not `source_code.zip`:

```
marquee_1.4.3_x64-setup.exe        Windows installer
marquee_1.4.3_x64_en-US.msi        Windows, the other kind
marquee_1.4.3_aarch64.dmg          macOS, Apple silicon
marquee_1.4.3_x64.dmg              macOS, Intel
marquee_1.4.3_amd64.AppImage       Linux
marquee_1.4.3_amd64.deb            Linux, Debian and Ubuntu
latest.json                        what the updater reads
*.sig                              a signature per bundle
```

The `.sig` files and `latest.json` only appear because
`bundle.createUpdaterArtifacts` is `true` in `tauri.conf.json`. Without it Tauri
builds perfectly good installers and no updater artifacts at all — and the
symptom is an app that never finds an update while the release page looks
entirely fine.

## 7. Your Windows machine updates itself

Either:

- **Wait.** Marquee checks about twenty seconds after launch, and offers the
  update on the library screen when nothing else is open. Never over a running
  game, never between pressing A and a game starting. "Not now" is remembered
  for that version, so it won't nag.
- **Ask.** **Settings → Updates → Check for updates.** Immediate, and it says
  what it found including "up to date".

Every bundle is verified against the public key compiled into the copy already
running, so a release that fails its signature check will not install.

## The labels, in full

| Label | Means | Whose turn |
|---|---|---|
| `claude` | hand this over | — (starts the run) |
| `claude-working` | picked up, running | nobody, wait |
| `in-review` | pull request open | **yours** |
| `needs-decision` | blocked on a question | **yours** |
| `bug` | patch release on merge | — |
| `enhancement` | minor release on merge | — |
| `breaking` | major release on merge | — |
| `no-release` | merge without releasing | — |
| `no-ai` | keep Claude off this issue | — |
| `wont-fix-yet` | real, deliberately parked | — |

## Things worth knowing

**Only you can trigger it.** The action requires write access on the
repository, checked on issues, comments and reviews. Strangers writing
`@claude` on your public repo get nothing and spend none of your quota.

**It cannot merge, and it cannot push to `main`.** A ruleset refuses direct
pushes from anyone, so every change arrives as a pull request. The review is
the point — this app launches executables on your machine and updates itself,
so a patch nobody read is a patch nobody read, whoever wrote it.

**The release does not touch `main` either.** It works out the version, injects
it into the build, tags and publishes, without committing anything. That is why
`main` needs no exception carved into its protection — and an exception is the
part of a protection that eventually gets used for something else.

**It won't fold two fixes into one PR.** If it notices something else wrong it
mentions it or opens a separate issue, so nothing becomes un-revertable.

**Two runs on one issue won't race** — concurrency is keyed per issue.

## When it goes wrong

| Symptom | Cause |
|---|---|
| Nothing happens on `@claude` | `CLAUDE_CODE_OAUTH_TOKEN` missing, or the label/mention didn't register |
| Run works, then fails at the end | Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests" is off |
| Release builds but won't sign | `TAURI_SIGNING_PRIVATE_KEY` not in the `release` environment — see `docs/UPDATES.md` |
| "Wrong password for that key" | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` has a placeholder in it. The key has no password, so that secret must be the empty string — **delete it** |
| "Branch main is not allowed to deploy to release" | the `release` environment's deployment rule is set to a tag pattern. It must allow **`main`** — GitHub checks the ref the workflow runs on, not the one the job checks out |
| No release after a merge | the PR was labelled `no-release`, or the commit was the version bump itself |
| Release has only source archives | the build job failed — open the run. The release is made by the build, not by the tag |
| App never offers an update | no `latest.json` on the release, so either `createUpdaterArtifacts` is off or the build did not finish |
| Cards never move | `PROJECT_TOKEN` missing, or `PROJECT_NUMBER` is not your board's number (check the URL) |
| Automation fails naming a Status | your board has no option with that exact name — the error lists the ones it does have |
