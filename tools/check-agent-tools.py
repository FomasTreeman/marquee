#!/usr/bin/env python3
"""
Every command the agent is told to run, it is allowed to run.

Three times now the instructions have demanded something the tool list forbade,
and every time the symptom was the same: a run that works for fifteen minutes,
reports success, and delivers nothing.

  * `gh pr create` was missing while claude-instructions.md said, twice, that
    the pull request is the deliverable. Runs pushed a branch and left a
    "Create PR" link for somebody to click.
  * `cd` was missing while both CLAUDE.md and claude-instructions.md say to run
    `cd src-tauri && cargo clippy --all-targets -- -D warnings` before claiming
    to be done. Issue #76 stopped on exactly that line, after thirteen
    permission denials, with "Open PR" left unticked.

None of it failed loudly. The action reports `is_error: false` and the job goes
green, because being refused a tool is not an error -- it is the agent being
told no, and then doing its best without it.

So: read the commands out of the fenced bash blocks the agent is pointed at,
read the allowlists out of the workflows that point at them, and refuse any
instruction the agent could not carry out.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# Each workflow against its own brief, which is not the same brief.
#
# claude.yml points an agent at these documents and tells it to follow them, so
# everything they ask for it has to be able to do. ci-repair.yml is a narrower
# job -- it fixes a red pull request on a branch that already exists -- and its
# tool list is correctly narrower for it. Checking the shared documents against
# both would demand `gh issue edit` from a workflow that has no business
# editing issues, which is how a check earns its way into being switched off.
#
# So ci-repair.yml is checked against the commands in its own `prompt:`, which
# is the brief it actually gets.
BRIEFS = {
    "claude.yml": [ROOT / "CLAUDE.md", ROOT / ".github" / "claude-instructions.md"],
    "ci-repair.yml": [ROOT / ".github" / "workflows" / "ci-repair.yml"],
    "review.yml": [ROOT / ".github" / "workflows" / "review.yml"],
}

# What the loop depends on that no fenced block spells out.
#
# Parsing the documents catches an instruction written as a command. It cannot
# catch one written as prose, and the most expensive omission so far was
# exactly that: claude-instructions.md says "the pull request is the
# deliverable" twice, at length, and never as a shell line -- so nothing
# noticed that `gh pr create` was absent for as long as it was. These are
# named here because a capability the loop cannot do without should not depend
# on somebody having phrased it as code.
REQUIRED = {
    "claude.yml": [
        "gh pr create",     # the deliverable, stated in prose only
        "gh issue comment",  # how a run stops and asks a question
        "gh issue edit",     # how it labels needs-decision and stops
        "git",               # commit and push, or there is nothing to open
    ],
    "ci-repair.yml": [
        "git",               # it pushes to an existing branch
        "gh pr comment",     # how it says which it concluded and why
    ],
    # The review's brief was "post ONE comment" and its tool list was `git`.
    # Sixty-nine runs, every one reported success, not one comment posted:
    # the agent was refused, gave up, and the run had nothing to fail on.
    "review.yml": [
        "gh pr comment",     # the whole job, per its own prompt
    ],
}

# Shell built-ins and operators that are not commands needing a grant, plus
# the placeholders documentation uses in place of a real argument.
IGNORE = {"", "#", "&&", "||", "|", "then", "else", "fi", "do", "done"}


def allowed_prefixes(workflow: pathlib.Path) -> set[str]:
    """The `Bash(...)` grants in a workflow's --allowed-tools."""
    text = workflow.read_text()
    return {m.group(1).rstrip(":*").strip() for m in re.finditer(r"Bash\(([^)]*)\)", text)}


def commands(doc: pathlib.Path) -> list[str]:
    """Every command inside a ```bash fence, split on && and |."""
    out = []
    for block in re.findall(r"```(?:bash|sh)\n(.*?)```", doc.read_text(), re.S):
        for line in block.splitlines():
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            # Split on `&&` and `||`, which chain commands the agent has to
            # run, and not on a single `|`, which pipes into a filter. The
            # distinction matters: `cd src-tauri && cargo clippy` hides a
            # second command that needs granting -- that is the bug this file
            # exists for -- while `git log | head` in an example would
            # otherwise demand a grant for `head` and fail the build over
            # documentation.
            for part in re.split(r"&&|\|\|", line):
                part = part.strip()
                if part and part.split()[0] not in IGNORE:
                    out.append(part)
    return out


def covered(command: str, grants: set[str]) -> bool:
    """Does any grant match the start of this command, token for token?"""
    tokens = command.split()
    for grant in grants:
        g = grant.split()
        # `tools/:*` grants anything beginning `tools/`.
        if grant.endswith("/") and tokens[0].startswith(grant):
            return True
        if tokens[: len(g)] == g:
            return True
    return False


problems = []
for name, docs in BRIEFS.items():
    workflow = ROOT / ".github" / "workflows" / name
    grants = allowed_prefixes(workflow)
    if not grants:
        problems.append(f"{name}: no Bash grants found — has --allowed-tools moved?")
        continue
    for doc in docs:
        for command in commands(doc):
            if not covered(command, grants):
                problems.append(
                    f"{doc.relative_to(ROOT)} tells the agent to run `{command}`, "
                    f"which {name} does not allow"
                )
    for command in REQUIRED.get(name, []):
        if not covered(command, grants):
            problems.append(
                f"{name} does not allow `{command}`, which the loop "
                f"cannot work without"
            )

if problems:
    print("The instructions ask for something the agent cannot do:\n")
    for p in sorted(set(problems)):
        print(f"  {p}")
    print(
        "\nEither grant it in the workflow's --allowed-tools, or stop asking for it\n"
        "in the documentation. A refused tool does not fail the run: the agent is\n"
        "told no, carries on without it, and reports success having delivered\n"
        "nothing. See tools/check-agent-tools.py."
    )
    sys.exit(1)

print(f"check-agent-tools: every documented command is granted in {len(BRIEFS)} workflows")
