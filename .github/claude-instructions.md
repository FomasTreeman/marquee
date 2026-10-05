Read `CLAUDE.md` at the repository root first, and follow it.

## Finishing a fix

Bugs in this project tend to be silent, so a fix is not finished until a test
fails when it regresses. Add the test, then prove it bites: reintroduce the
bug, watch the test fail, put the fix back. Say in the pull request that you
did, and what the failure looked like.

Before saying you are done, run both:

```bash
pnpm test
cd src-tauri && cargo clippy --all-targets -- -D warnings
```

If either fails, say so plainly in the pull request. An honest red pull
request is more useful than a green one that skipped a step.

## Where your work goes

**Never commit to `main`.** A ruleset refuses it. Every change goes on a
branch and arrives as a pull request.

**The pull request is the deliverable, not a comment describing one.** If you
have working changes, open the pull request without being asked.

**If a push is refused, open the pull request anyway** with what you could
push, and name the rejected files and the reason in the body. The most likely
refusal is `.github/workflows/`, which needs a token with workflow permission;
the error mentions `workflows permission`. `CLAUDE_WORKFLOW_TOKEN` provides
it; see the header of `.github/workflows/claude.yml`.

The run has already created and checked out a branch named
`claude/issue-<number>-<timestamp>`. Stay on it, commit there, and
`git push -u origin HEAD`.

## The board

You do not need to touch labels. The workflow adds `claude-working` before you
start and removes it when you finish.

Put `Closes #<number>` in the pull request body. It links the pull request to
the issue, moves the card to In Review, and closes the issue on merge.

## When to stop and ask

Stopping is a valid outcome. If the issue is ambiguous, you cannot reproduce
it, the fix needs a decision that is not yours, or the real cause is somewhere
the issue did not mention, do not guess. Instead:

1. Comment on the issue with what you found, what you tried, and the one
   question you need answered.
2. Label it: `gh issue edit <number> --add-label needs-decision`
3. Stop. Do not open a speculative pull request.

Leave `claude-working` alone. The person's reply starts a new run with the
thread as its brief.

## Do not stop anywhere else

Every run ends in one of three states: a pull request, a `needs-decision`
question, or the issue closed. The workflow checks which after you return.

If you run out of time or get stuck, commit and push what you have and open
the pull request anyway, saying what is missing and that the suite did not
run.

## Scope

Fix the issue in front of you. If you notice something else wrong, mention it
in the pull request or open a separate issue rather than folding it in. One
person reviews everything here, and a pull request that fixes two things
cannot be half-reverted.
