#!/usr/bin/env python3
"""Generate src/css/tokens.css from design/tokens.json.

One source of truth, same convention as the sibling theme projects. The
generated file is committed so a fresh clone renders without running Python,
but it is never hand-edited -- the header says so and the linter checks it.
"""
from __future__ import annotations
import json, pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "design" / "tokens.json"
OUT = ROOT / "src" / "css" / "tokens.css"


def argb_to_css(v: str) -> str:
    """#AARRGGBB -> rgb()/rgba(). The sibling projects store colours in WPF
    order so the three palettes stay diffable by eye; CSS wants alpha last."""
    s = v.lstrip("#")
    if len(s) != 8:
        sys.exit(f"palette value {v!r} must be #AARRGGBB")
    a, r, g, b = (int(s[i:i + 2], 16) for i in (0, 2, 4, 6))
    if a == 255:
        return f"rgb({r} {g} {b})"
    return f"rgb({r} {g} {b} / {a / 255:.3f}".rstrip("0").rstrip(".") + ")"


def main() -> None:
    t = json.loads(SRC.read_text())
    L = [
        "/* ==================================================================",
        "   DESIGN TOKENS -- GENERATED, DO NOT EDIT",
        "",
        "   Source:   design/tokens.json",
        "   Regenerate:  python3 tools/build-tokens.py",
        "",
        "   Edits here are lost on the next build. Change the JSON.",
        "   ================================================================== */",
        "",
        ":root {",
        "  /* --- type --- */",
        f'  --font: {t["fontStack"]};',
        f'  --fw-body: {t["fontWeightBody"]};',
        "",
        "  /* --- palette --- */",
    ]
    for k, v in t["palette"].items():
        if k.startswith("_"):
            continue
        L.append(f"  --{k}: {argb_to_css(v)};")

    L += ["", "  /* --- shape, spacing, effects --- */"]
    for k, v in t["vars"].items():
        L.append(f"  {k}: {v};")

    L += [
        "",
        "  /* --- derived ---",
        "     Cover height follows the card width and the box-art ratio, so",
        "     changing --card-w alone never distorts artwork. */",
        "  --card-h: calc(var(--card-w) / var(--cover-ratio));",
        "}",
        "",
        "/* Respect the platform setting. --motion is the design's own dial and",
        "   this is the user's; the user wins. */",
        "@media (prefers-reduced-motion: reduce) {",
        "  :root { --motion: 0; }",
        "}",
        "",
    ]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(L))
    n = sum(1 for k in t["palette"] if not k.startswith("_")) + len(t["vars"])
    print(f"tokens.css  {n} tokens  ->  {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
