Read `CLAUDE.md` at the repository root before anything else, and follow it.

## Finishing a fix

This project's bugs are silent — a clipped focus ring, an invisible cover, a
grey placeholder served with a 200. **A fix is not finished until something
fails when it regresses.** Add the test, then prove it bites: reintroduce the
bug, watch the test fail, put the fix back. Say in the pull request that you
did, and what the failure looked like.

Before claiming to be done, run both:

```bash
pnpm test
cd src-tauri && cargo clippy --all-targets -- -D warnings
```

If either did not pass, say so plainly in the pull request rather than
describing the work as complete. A red pull request that is honest about being
red is more useful than a green one that skipped a step.

## Where your work goes

**Never commit to `main`.** A ruleset refuses it, so this is not a matter of
discipline, but knowing it saves you finding out the hard way: every change
goes on a branch and arrives as a pull request.

**The pull request is the deliverable. A comment describing one is not.** If
you have working changes, open the PR — always, without being asked and
without offering to. This is not a formality: issue #1 got a correct, ranked
set of CI fixes written out as prose in a comment, because the push of
`.github/workflows/ci.yml` was refused, and every one of them then had to be
retyped by hand. The run did the thinking and delivered nothing that could be
merged.

**A refused push is a reason to say so in the pull request, not a reason not
to open one.** Push what you can, open the PR with that, and name in the body
the files that were rejected and why. Half the change, visibly labelled as
half, is reviewable. A comment is not.

The refusal you are most likely to meet is `.github/workflows/`: GitHub blocks
a token without workflow permission from writing there, and the error mentions
`workflows permission` rather than anything about you. `CLAUDE_WORKFLOW_TOKEN`
in the repository secrets lifts it — see the header of `.github/workflows/claude.yml`.

The run has already made a branch named `claude/issue-<number>-<timestamp>`
and checked it out. Stay on it: commit there and `git push -u origin HEAD`. An
earlier version of this file asked for a hand-named branch, which contradicted
the run's own brief and left agents deciding which to obey.

## The board looks after itself

You do not need to touch labels. The workflow adds `claude-working` before you
start and removes it when you finish, and opening a pull request that says
`Closes #<number>` moves the issue to In Review on its own.

**So put `Closes #<number>` in the pull request body.** That one line is what
links the two, what closes the issue on merge, and what moves the card to Done.
Without it every card has to be moved by hand.

## When to stop instead

**Stopping is a valid outcome and often the right one.** If the issue is
ambiguous, if you cannot reproduce it, if the fix would need a decision that is
not yours to make, or if you find the real cause is somewhere the issue did not
mention — do not guess. Guessing produces a confident patch for the wrong
problem, which costs more to review than nothing at all.

In that case:

1. Comment on the issue with what you found, what you tried, and the specific
   question you need answered. One question, not a list of five.
2. Label it: `gh issue edit <number> --add-label needs-decision`
3. Stop. Do not open a speculative pull request.

Leave `claude-working` alone; the workflow clears it when you finish. The
person's reply on the issue starts a new run with the thread as its brief, so
write the question the way you would want to read the answer.

## Do not stop anywhere else

Every run ends in one of three states: a pull request, a `needs-decision`
question, or the issue closed. The workflow checks which, after you return.
A run that ends with an unticked "Open PR" and nothing pushed is the failure
this repository has had most often — three of them in two days — and it is
worse than a red pull request, because the work is discarded with it.

If you are out of time or stuck part-way, commit and push what you have and
open the pull request anyway, with the body saying what is missing and that
the suite did not run. The workflow will do the same with whatever you leave
in the working tree, but you know what is missing and it does not.

## Scope

Fix the issue in front of you. If you notice something else wrong, mention it
in the pull request or open a separate issue — do not fold it in. A pull
request that fixes two things is one that cannot be half-reverted, and this
repository is reviewed by one person.
