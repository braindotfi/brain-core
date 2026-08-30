#!/usr/bin/env python3
"""Add the staging surface-gateway route without replacing host-only Caddy config."""

from __future__ import annotations

import argparse
import pathlib
import re
import sys


SITE = "staging-api.brain.fi"
BEGIN_MARKER = "# BEGIN brain staging surface route"
END_MARKER = "# END brain staging surface route"


def site_block(lines: list[str]) -> tuple[int, int]:
    site_pattern = re.compile(rf"^\s*{re.escape(SITE)}\s*\{{\s*$")
    starts = [index for index, line in enumerate(lines) if site_pattern.match(line)]
    if len(starts) != 1:
        raise ValueError(f"expected exactly one {SITE} site block, found {len(starts)}")

    start = starts[0]
    depth = 0
    for index in range(start, len(lines)):
        depth += lines[index].count("{")
        depth -= lines[index].count("}")
        if index > start and depth == 0:
            return start, index
    raise ValueError(f"unterminated {SITE} site block")


def remove_managed_block(lines: list[str]) -> list[str]:
    begin = [index for index, line in enumerate(lines) if line.strip() == BEGIN_MARKER]
    end = [index for index, line in enumerate(lines) if line.strip() == END_MARKER]
    if not begin and not end:
        return lines
    if len(begin) != 1 or len(end) != 1 or begin[0] >= end[0]:
        raise ValueError("invalid managed staging surface route markers")
    after = end[0] + 1
    if after < len(lines) and lines[after].strip() == "":
        after += 1
    return lines[: begin[0]] + lines[after:]


def render(source: str) -> str:
    trailing_newline = source.endswith("\n")
    lines = remove_managed_block(source.splitlines())
    start, end = site_block(lines)
    block = lines[start + 1 : end]

    collisions = [
        line.strip()
        for line in block
        if "/surfaces" in line or "surface-gateway" in line
    ]
    if collisions:
        raise ValueError(
            "unmanaged staging surface route already exists: " + "; ".join(collisions)
        )

    api_targets = [
        index
        for index in range(start + 1, end)
        if re.match(r"^\s*reverse_proxy\s+api:3000\s*$", lines[index])
    ]
    if len(api_targets) != 1:
        raise ValueError(
            "expected exactly one catch-all reverse_proxy api:3000 in staging site, "
            f"found {len(api_targets)}"
        )

    insertion = api_targets[0]
    indent = re.match(r"^(\s*)", lines[insertion]).group(1)
    managed = [
        f"{indent}{BEGIN_MARKER}",
        f"{indent}@brain_surfaces path /surfaces/*",
        f"{indent}reverse_proxy @brain_surfaces surface-gateway:3000",
        f"{indent}{END_MARKER}",
        "",
    ]
    result = lines[:insertion] + managed + lines[insertion:]
    rendered = "\n".join(result)
    return rendered + ("\n" if trailing_newline else "")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()

    try:
        source = args.input.read_text(encoding="utf-8")
        rendered = render(source)
        args.output.write_text(rendered, encoding="utf-8")
    except (OSError, ValueError) as error:
        print(f"staging surface route update failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
