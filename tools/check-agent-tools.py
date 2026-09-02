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

# The documents an agent is told to read and follow.
DOCS = [ROOT / "CLAUDE.md", ROOT / ".github" / "claude-instructions.md"]

# The workflows that run an agent against those documents.
WORKFLOWS = [
    ROOT / ".github" / "workflows" / "claude.yml",
    ROOT / ".github" / "workflows" / "ci-repair.yml",
]

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
            for part in re.split(r"&&|\|\||(?<!\|)\|(?!\|)", line):
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
for workflow in WORKFLOWS:
    grants = allowed_prefixes(workflow)
    if not grants:
        problems.append(f"{workflow.name}: no Bash grants found — has --allowed-tools moved?")
        continue
    for doc in DOCS:
        for command in commands(doc):
            if not covered(command, grants):
                problems.append(
                    f"{doc.relative_to(ROOT)} tells the agent to run `{command}`, "
                    f"which {workflow.name} does not allow"
                )
    for command in REQUIRED.get(workflow.name, []):
        if not covered(command, grants):
            problems.append(
                f"{workflow.name} does not allow `{command}`, which the loop "
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

print(f"check-agent-tools: every documented command is granted in {len(WORKFLOWS)} workflows")
