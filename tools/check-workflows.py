#!/usr/bin/env python3
"""
Catch a workflow GitHub would refuse, or one that leaves something to a default,
before it is pushed. An invalid workflow fails silently as a zero-second run.
Also requires `timeout-minutes` and `permissions` on every job, actions pinned
to full SHAs, and no event data interpolated into `run:`.
"""
import pathlib
import re
import sys

import os

try:
    import yaml
except ImportError:
    # On the runner, skipping would be a silent pass.
    if os.environ.get("CI"):
        print("check-workflows: pyyaml is not installed on this runner, so nothing was checked")
        sys.exit(1)
    print("check-workflows: pyyaml not installed, skipping")
    sys.exit(0)

# YAML parses `on:` as the boolean True.
TOP = {"name", "on", True, "permissions", "env", "defaults", "concurrency", "jobs", "run-name"}
STEP = {
    "id", "if", "name", "uses", "run", "with", "env", "continue-on-error",
    "timeout-minutes", "working-directory", "shell",
}

# A tag can be moved by its owner; a full SHA cannot. tauri-action runs beside
# the update signing key. Dependabot updates the SHA and its version comment.
PINNED = re.compile(r"^[^@]+@[0-9a-f]{40}$")

# `${{ }}` in `run:` is pasted into the shell, so attacker-controlled event data
# becomes shell injection with the job's token. Pass it through `env:` instead.
INJECTABLE = re.compile(
    r"\$\{\{[^}]*\b(github\.event\.|inputs\.|github\.head_ref)"
)

problems = []
unpinned = []


def check(path: pathlib.Path) -> None:
    try:
        doc = yaml.safe_load(path.read_text())
    except yaml.YAMLError as e:
        problems.append(f"{path}: not valid YAML: {e}")
        return
    if not isinstance(doc, dict):
        problems.append(f"{path}: is not a mapping")
        return

    for key in doc:
        if key not in TOP:
            problems.append(f"{path}: unknown top-level key {key!r}")

    if "on" not in doc and True not in doc:
        problems.append(f"{path}: no triggers")

    # A workflow-level block covers every job.
    top_permissions = "permissions" in doc

    for job_name, job in (doc.get("jobs") or {}).items():
        where = f"{path}: job {job_name}"
        if not isinstance(job, dict):
            problems.append(f"{where}: is not a mapping")
            continue
        if "uses" in job:
            continue  # a reusable workflow call has no steps

        # The six-hour default would let a wedged job block releases and spend
        # agent usage.
        if "timeout-minutes" not in job:
            problems.append(
                f"{where}: no `timeout-minutes`, so it inherits GitHub's six-hour default"
            )
        # Otherwise the job inherits a repository setting that can change
        # outside this repository.
        if not top_permissions and "permissions" not in job:
            problems.append(
                f"{where}: no `permissions`, so it inherits the repository-wide default"
            )
        steps = job.get("steps")
        if not steps:
            problems.append(f"{where}: has no steps")
            continue
        for i, step in enumerate(steps):
            at = f"{where}, step {i}" + (f" ({step.get('name')})" if isinstance(step, dict) else "")
            if not isinstance(step, dict):
                problems.append(f"{at}: is not a mapping")
                continue
            has_uses, has_run = "uses" in step, "run" in step
            if has_uses and has_run:
                problems.append(f"{at}: has both `uses` and `run`")
            elif not has_uses and not has_run:
                problems.append(f"{at}: has neither `uses` nor `run`")
            if has_run and "with" in step:
                problems.append(
                    f"{at}: a `run` step cannot take `with` — most likely a step "
                    f"was inserted between a `uses:` and the `with:` that belonged to it"
                )
            if has_run and isinstance(step["run"], str) and INJECTABLE.search(step["run"]):
                problems.append(
                    f"{at}: `run` interpolates event data with `${{{{ }}}}` -- pass it through `env:` instead"
                )
            if has_run and "shell" not in step and "windows" in str(job.get("runs-on", "")).lower():
                problems.append(f"{at}: a Windows `run` step should name its shell")
            # Local actions and containers have no tag to pin.
            if has_uses and not isinstance(step["uses"], str):
                problems.append(f"{at}: `uses` is empty — a failed substitution, most likely")
            elif has_uses and not step["uses"].startswith(("./", "docker://")):
                if not PINNED.match(step["uses"]):
                    unpinned.append(f"{at}: {step['uses']}")
            for key in step:
                if key not in STEP:
                    problems.append(f"{at}: unknown step key {key!r}")


root = pathlib.Path(__file__).resolve().parent.parent
files = sorted((root / ".github" / "workflows").glob("*.yml"))
if not files:
    print("check-workflows: no workflows found")
    sys.exit(0)
for f in files:
    check(f)

if problems:
    print("Workflows GitHub would refuse, or that leave something to a default:\n")
    for p in problems:
        print(f"  {p}")
    print("\nSee tools/check-workflows.py.")

if unpinned:
    print("Actions referenced by a tag somebody else can move:\n")
    for u in unpinned:
        print(f"  {u}")
    print(
        "\nPin each to a full commit SHA with the version in a trailing comment:\n"
        "  uses: owner/action@<40-char sha> # v1.2.3\n"
        "Find it with: gh api repos/<owner>/<action>/commits/<tag> --jq .sha"
    )

if problems or unpinned:
    sys.exit(1)
print(f"check-workflows: {len(files)} workflows well formed and pinned")
