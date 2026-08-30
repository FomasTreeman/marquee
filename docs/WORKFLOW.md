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

## 2. You hand it over

Any one of these starts a run:

- add the **`claude`** label — easiest, one click from the board
- write **`@claude`** in a comment
- open the issue with **`@claude`** in the title or body

Nothing happens without one of those. Filing an issue does not start anything,
which is deliberate — you might be recording something for later.

## 3. Claude works

It checks out the repository with full history, installs the Rust and Node
toolchains, reads `CLAUDE.md`, and gets on with it. Progress appears as a
**ticked checklist in the issue thread**, so a long run is legible rather than
a spinner.

It labels the issue **`claude-working`** when it starts. On the board, that's
*In progress*.

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

## 6. You release — two clicks

**Actions → Release → Run workflow → `patch`**

That bumps the version in `tauri.conf.json`, `package.json` and `Cargo.toml`
together, commits, tags, and pushes. **Build release** picks the tag up, builds
and signs installers for Apple silicon, Intel Mac, Linux and Windows, writes
the `latest.json` manifest, and opens a **draft** release.

**Releases → edit the draft → write real notes → Publish.**

Those notes are what the update prompt shows people, so "see the commit log"
tells nobody anything. Nothing reaches any install until you press publish.

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
| `bug` / `enhancement` | what kind of thing it is | — |
| `wont-fix-yet` | real, deliberately parked | — |

## Things worth knowing

**Only you can trigger it.** The action requires write access on the
repository, checked on issues, comments and reviews. Strangers writing
`@claude` on your public repo get nothing and spend none of your quota.

**It cannot merge, and it cannot push to `main`.** It opens branches and pull
requests. The review is the point — this app launches executables on your
machine and updates itself, so a patch nobody read is a patch nobody read,
whoever wrote it.

**It won't fold two fixes into one PR.** If it notices something else wrong it
mentions it or opens a separate issue, so nothing becomes un-revertable.

**Two runs on one issue won't race** — concurrency is keyed per issue.

## When it goes wrong

| Symptom | Cause |
|---|---|
| Nothing happens on `@claude` | `CLAUDE_CODE_OAUTH_TOKEN` missing, or the label/mention didn't register |
| Run works, then fails at the end | Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests" is off |
| Release builds but won't sign | `TAURI_SIGNING_PRIVATE_KEY` not in the `release` environment — see `docs/UPDATES.md` |
| App never offers an update | the release is still a draft, or the tag and `tauri.conf.json` disagree |
| Cards never move | `PROJECT_TOKEN` missing, or `PROJECT_NUMBER` is not your board's number (check the URL) |
| Automation fails naming a Status | your board has no option with that exact name — the error lists the ones it does have |
