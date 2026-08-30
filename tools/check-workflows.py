#!/usr/bin/env python3
"""
Catch a workflow GitHub will refuse before pushing it.

Valid YAML is not a valid workflow, and the difference is expensive here: a
schema-invalid file does not fail loudly, it fails as a run named after the
file path instead of the workflow, in zero seconds, which reads like the
workflow was renamed rather than broken. Releases stopped for three merges
before anyone noticed.

The specific bug this exists for: a step inserted between `- uses:` and its own
`with:` block, so the inputs silently reattached to the new step. `run` steps
cannot take `with`, and GitHub rejects the whole file for it.
"""
import pathlib
import sys

try:
    import yaml
except ImportError:
    print("check-workflows: pyyaml not installed, skipping")
    sys.exit(0)

# `on:` is parsed by YAML as the boolean True, not the string "on". This
# check tripped over that on its first run, which is the sort of thing it is
# here to catch.
TOP = {"name", "on", True, "permissions", "env", "defaults", "concurrency", "jobs", "run-name"}
STEP = {
    "id", "if", "name", "uses", "run", "with", "env", "continue-on-error",
    "timeout-minutes", "working-directory", "shell",
}

problems = []


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

    # `on:` is parsed by yaml as the boolean True, which is a fact worth
    # knowing before it wastes an afternoon.
    if "on" not in doc and True not in doc:
        problems.append(f"{path}: no triggers")

    for job_name, job in (doc.get("jobs") or {}).items():
        where = f"{path}: job {job_name}"
        if not isinstance(job, dict):
            problems.append(f"{where}: is not a mapping")
            continue
        if "uses" in job:
            continue  # a reusable workflow call has no steps
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
            if has_run and "shell" not in step and "windows" in str(job.get("runs-on", "")).lower():
                problems.append(f"{at}: a Windows `run` step should name its shell")
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
    print("Workflows GitHub would refuse:\n")
    for p in problems:
        print(f"  {p}")
    print("\nSee tools/check-workflows.py.")
    sys.exit(1)
print(f"check-workflows: {len(files)} workflows well formed")
