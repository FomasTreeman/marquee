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

## Keeping the board honest

The issue is a card on a kanban board, and its labels are what move it. Keep
them true as you go — someone is reading the board instead of the thread.

- **When you start**, add `claude-working` and remove `needs-decision` if it is
  there:
  `gh issue edit <number> --add-label claude-working --remove-label needs-decision`

- **When you open the pull request**, remove `claude-working`. The open PR is
  the state now: `gh issue edit <number> --remove-label claude-working`

- **Put `Closes #<number>` in the pull request body.** That is what closes the
  issue on merge, which is what moves the card to Done. Without it every card
  has to be moved by hand.

## When to stop instead

**Stopping is a valid outcome and often the right one.** If the issue is
ambiguous, if you cannot reproduce it, if the fix would need a decision that is
not yours to make, or if you find the real cause is somewhere the issue did not
mention — do not guess. Guessing produces a confident patch for the wrong
problem, which costs more to review than nothing at all.

In that case:

1. Comment on the issue with what you found, what you tried, and the specific
   question you need answered. One question, not a list of five.
2. Label it: `gh issue edit <number> --add-label needs-decision --remove-label claude-working`
3. Stop. Do not open a speculative pull request.

## Scope

Fix the issue in front of you. If you notice something else wrong, mention it
in the pull request or open a separate issue — do not fold it in. A pull
request that fixes two things is one that cannot be half-reverted, and this
repository is reviewed by one person.
