#!/usr/bin/env python3
"""
Check that a set of edits changed comments and nothing else.

Usage: tools/check-comment-only.py [BASE] [FILE...]

Compares each file with its version at BASE (default origin/main). Comments and
blank lines are removed from both sides, and what is left must be identical.
Workflows are compared after parsing, so YAML comments do not count, and shell
or JavaScript comment lines inside `run:` and `script:` do not count either.
The agent's `prompt:` and `claude_args:` inputs are compared exactly, because
they are instructions, not comments.
"""
import ast
import pathlib
import re
import subprocess
import sys

import yaml

base = sys.argv[1] if len(sys.argv) > 1 else "origin/main"
files = sys.argv[2:] or subprocess.run(
    ["git", "diff", "--name-only", base, "--"], capture_output=True, text=True, check=True
).stdout.split()

FULL_LINE = {
    ".rs": re.compile(r"^\s*//"),
    ".ts": re.compile(r"^\s*(//|/\*|\*)"),
    ".mjs": re.compile(r"^\s*(//|/\*|\*)"),
    ".sh": re.compile(r"^\s*#(?!!)"),
}
EXACT_KEYS = {"prompt", "claude_args"}


def old(path):
    r = subprocess.run(["git", "show", f"{base}:{path}"], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def strip_lines(text, pattern):
    return [l.rstrip() for l in text.splitlines() if l.strip() and not pattern.match(l)]


def strip_css(text):
    return re.sub(r"\s+", " ", re.sub(r"/\*.*?\*/", "", text, flags=re.S)).strip()


def strip_python(text):
    tree = ast.parse(text)
    for node in ast.walk(tree):
        body = getattr(node, "body", None)
        if isinstance(body, list) and body and isinstance(body[0], ast.Expr) \
                and isinstance(getattr(body[0], "value", None), ast.Constant) \
                and isinstance(body[0].value.value, str):
            body.pop(0)
    return ast.dump(tree)


def normalise_yaml(value, key=None):
    if isinstance(value, dict):
        return {k: normalise_yaml(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [normalise_yaml(v) for v in value]
    if isinstance(value, str) and "\n" in value and key not in EXACT_KEYS:
        return [l.rstrip() for l in value.splitlines()
                if l.strip() and not re.match(r"^\s*(#(?!!)|//)", l)]
    return value


def comparable(path, text):
    suffix = pathlib.Path(path).suffix
    if suffix in (".yml", ".yaml"):
        return normalise_yaml(yaml.safe_load(text))
    if suffix == ".css":
        return strip_css(text)
    if suffix == ".py":
        return strip_python(text)
    if suffix in FULL_LINE:
        return strip_lines(text, FULL_LINE[suffix])
    return None


bad, checked = [], 0
for path in files:
    before = old(path)
    if before is None or not pathlib.Path(path).exists():
        continue
    a = comparable(path, before)
    if a is None:
        continue
    checked += 1
    if a != comparable(path, pathlib.Path(path).read_text()):
        bad.append(path)

for path in bad:
    print(f"  {path}: something other than a comment changed")
if bad:
    sys.exit(1)
print(f"check-comment-only: {checked} files changed comments only")
