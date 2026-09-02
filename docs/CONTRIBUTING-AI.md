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
`CLAUDE_CODE_OAUTH_TOKEN` — a repository secret, not an environment one. This
workflow fires on issue comments, and an environment with a required reviewer
would mean approving every run. It is a credential for your Claude account:
never put it in an issue, a commit, or a chat window.

The repository is public, so it is worth being clear about who can spend that
token: **the action requires the triggering user to have write access**,
checked on issues, comments and reviews. A stranger writing `@claude` on an
issue gets nothing. Two action inputs disable that check — `allowed_bots` and
`allowed_non_write_users` — and neither is set. Do not set them without reading
[the action's security notes](https://github.com/anthropics/claude-code-action/blob/main/docs/security.md).

Issue text from anyone is still untrusted input being read by an agent with a
checkout of your repository. That is the residual risk of this arrangement, and
the reason the loop ends in a pull request you read rather than a push to
`main`.

**2. Let Actions open pull requests.**

**Settings → Actions → General → Workflow permissions →** tick *"Allow GitHub
Actions to create and approve pull requests"*. Without it the run does the work
and then fails at the last step, which is a confusing way to find out.

**3. A token that can write workflow files, if you want Claude to fix CI.**

Optional, and only for changes under `.github/workflows/`. GitHub will not let
`GITHUB_TOKEN` write a workflow file at all — there is no permission to grant,
and the push fails naming `workflows permission`, which reads like a bug in the
action. That is how issue #1 ended: a correct set of CI fixes posted as a
comment for somebody to retype, because the branch could not be pushed.

**Settings → Developer settings → Personal access tokens → Fine-grained.**
Scope it to this repository alone, and grant exactly:

| | |
|---|---|
| Contents | read and write |
| Pull requests | read and write |
| Issues | read and write |
| Workflows | read and write |
| Actions | read |

Store it as `CLAUDE_WORKFLOW_TOKEN`.

The workflow takes the first of `CLAUDE_WORKFLOW_TOKEN`, `PROJECT_TOKEN` and
`GITHUB_TOKEN` that exists, so the token the board automation already uses will
do the job if it carries `workflow` — but two things make a dedicated
fine-grained token the better one, which is why it is checked first:

- **`workflow` on its own cannot push.** Writing a workflow file still needs
  `repo`, or `public_repo` on a public repository. Without one of those the
  push fails exactly as it did with `GITHUB_TOKEN`, and the message still talks
  about workflow permission.
- **A classic token reaches too far.** `repo` covers every repository the
  account can see and `project` every board. That is a wide reach to hand a run
  whose brief is issue text written by anyone on the internet. A fine-grained
  token stops at this repository.

Actions stays **read** deliberately. It is what lets Claude open the run that
failed and see which step died and how long it sat there — the reading that
fixing a workflow actually consists of. Write would also let it start runs, and
`gh workflow run release.yml` cuts a release. A CI fix is tested by opening the
pull request and letting CI run on it.

Without the secret everything works as before; with it, pull requests come from
your account rather than `github-actions[bot]`, and the pushes trigger CI.

**4. The signing key, if you have not already.** `docs/UPDATES.md`. Nothing
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
the **`claude`** label. Any of the three starts a run (the first through
triage, which turns it into the label).

## What happens

`.github/workflows/claude.yml` checks out the repository with its full history,
installs the Rust and Node toolchains, and runs Claude Code with the issue as
its brief. It reads `CLAUDE.md` first, so it works to this project's
conventions rather than generic ones — including the one that matters most
here: **a fix is not finished until something fails when it regresses.**

It opens a branch and a pull request. It cannot merge, and it is not asked to.
Progress is ticked off in the issue thread as it goes.

A run ends in one of three states, and the board column says which: a pull
request (In Review), a question it could not answer itself (Needs Decision,
with the `needs-decision` label), or the issue closed because there was
nothing to do (Done). A run that stops anywhere else — out of turns, a tool it
was not allowed — has whatever it pushed turned into a pull request marked as
salvaged, so the work is somewhere you can see it rather than gone.

Answering the question is enough. A reply from someone with write access on
a `needs-decision` issue restarts it; you do not need to write `@claude`.

You can keep talking to it. `@claude` in a review comment on the PR, and it
picks up from there with the review as context.

**If CI goes red on that pull request, it fixes it without being asked.**
`.github/workflows/ci-repair.yml` watches CI finish, and on a failing run for a
`claude/` branch with an open pull request it starts a run whose brief is the
failing log. Three attempts, each announced in a comment on the pull request;
after the third it says so, labels the pull request `needs-decision` and stops,
because an agent that has not fixed something in three goes will not find it on
the ninth.

It skips a failure whose commit has already been superseded, and it does not
touch pull requests from forks — that restriction is load-bearing, and the
header of the file explains why.

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

When it is right, **enable auto-merge** — the button on the pull request, or
`gh pr merge <n> --squash --auto`. That is the whole of the merge step.
`main` requires a branch to be up to date before it merges, so every merge
puts the other pull requests behind; `.github/workflows/merge-queue.yml`
brings the oldest queued one up to date each time `main` moves, CI reruns on
it, and auto-merge lands it. Queue four and they land one after another
without further clicks. A branch that conflicts with `main` is handed back to
the agent to resolve, once per head commit, and stays in the queue.

They land oldest first. If the order ever matters — a one-line fix that
should not wait behind a refactor, or a refactor that should be rebased once
onto everything rather than everything onto it — set the repository variable
`MERGE_QUEUE_ORDER` to `clicked` and they land in the order auto-merge was
enabled. Nothing else changes; delete the variable to go back.

## Releasing

Nothing to do. Merging is the release — once CI is green on the merge commit.
The Release workflow waits for it and publishes nothing without it, because the
bundler only compiles and would happily sign and ship a commit whose tests
fail.

The Release workflow reads the labels on the pull request that was merged --
`breaking` for a major, `enhancement` for a minor, anything else a patch,
`no-release` to skip -- writes that version into all three files, tags, builds
and signs installers for four targets, and publishes.

There is no version number for a person to type, which is deliberate: typing
one is how this first went wrong. `docs/WORKFLOW.md` has the detail.

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

## When the fix did not work

Nothing broke, CI stayed green, the release installed — and the thing the
issue described is still happening. No workflow can notice that; you do.

**Reopen the issue, and say in a comment what is still wrong.** That is the
whole of it. Reopening a `claude` issue starts a run, and because the issue
already has a merged pull request the brief tells the agent so: start from
that diff rather than from the issue text, and amend it rather than revert
it. The new pull request goes through review, the queue and a release like
any other, and the issue closes again when it merges.

Do not file a new issue for it. A new issue loses the link to the fix that
did not work, so the agent starts from scratch and, as often as not,
rediscovers the same fix.

The three-attempt count starts again from the reopen: the run that shipped
the first fix was not a failed attempt at this one.

If the fix made things worse rather than merely not better, say so in the
comment and ask for the revert — that is the one case where the agent is
told not to guess.

## What this loop is not

**It is not a licence to skip review.** The whole arrangement is one where a
machine writes and a person decides, and the person is the part that makes it
safe. Marquee launches executables on your machine and updates itself; a patch
nobody read is a patch nobody read, whoever wrote it.
