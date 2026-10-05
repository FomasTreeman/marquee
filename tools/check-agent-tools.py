#!/usr/bin/env python3
"""
Fail when the agent's instructions ask for a command its workflow's
--allowed-tools does not grant. A refused tool is not an error: the run
reports success having delivered nothing. Commands are read from the fenced
bash blocks in each workflow's brief.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# Each workflow against its own brief. ci-repair.yml's job is narrower, so it
# is checked against its own `prompt:`, not the shared documents.
BRIEFS = {
    "claude.yml": [ROOT / "CLAUDE.md", ROOT / ".github" / "claude-instructions.md"],
    "ci-repair.yml": [ROOT / ".github" / "workflows" / "ci-repair.yml"],
    "review.yml": [ROOT / ".github" / "workflows" / "review.yml"],
}

# Capabilities the loop needs that the briefs state only in prose.
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
    # Without this, review runs once reported success and posted nothing.
    "review.yml": [
        "gh pr comment",     # the whole job, per its own prompt
    ],
}

# Shell keywords and operators, which need no grant.
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
            # Split on `&&` and `||`, which chain commands that each need a
            # grant, not on `|`, which pipes into a filter such as `head`.
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
