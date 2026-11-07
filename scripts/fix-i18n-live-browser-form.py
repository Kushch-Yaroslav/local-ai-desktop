#!/usr/bin/env python3
"""Normalize the liveBrowser.* i18n keys in the source catalogs.

The project's source catalogs (ui/desktop/src/i18n/messages/*.json) store each
message as an object: {"defaultMessage": "..."}. This matches what
`formatjs extract` emits (and what `i18n:check` compares against). The Live
Browser keys were originally appended as flat strings; this script converts
them to the object form and normalizes the ICU plural syntax to the compact
canonical form used by formatjs (e.g. `{count,plural,=0{...} one{...} ...}`).

It touches ONLY `liveBrowser.*` keys and leaves every other key untouched.
The compiled/*.json catalogs (flat form) are left as-is.
"""
import json
import re
import sys
from pathlib import Path

MESSAGES_DIR = Path(__file__).resolve().parent.parent / "ui/desktop/src/i18n/messages"


def _parse_clauses(body: str):
    clauses = []
    i = 0
    n = len(body)
    while i < n:
        while i < n and body[i].isspace():
            i += 1
        if i >= n:
            break
        j = i
        while j < n and body[j] != "{":
            j += 1
        kw = body[i:j].strip()
        if not kw or j >= n:
            break
        depth = 0
        k = j
        while k < n:
            if body[k] == "{":
                depth += 1
            elif body[k] == "}":
                depth -= 1
                if depth == 0:
                    break
            k += 1
        if k >= n:
            break
        clauses.append((kw, body[j : k + 1]))
        i = k + 1
    return clauses


def normalize_icu(s: str) -> str:
    if not isinstance(s, str) or "plural" not in s:
        return s
    m = re.match(r"^\s*\{\s*(\w+)\s*,\s*plural\s*,", s)
    if not m:
        return s
    sel = m.group(1)
    depth = 0
    j = 0
    n = len(s)
    while j < n:
        if s[j] == "{":
            depth += 1
        elif s[j] == "}":
            depth -= 1
            if depth == 0:
                break
        j += 1
    inner = s[s.index("{") + 1 : j]
    rest = inner[len(sel):]
    rest = re.sub(r"^\s*,\s*plural\s*,\s*", "", rest)
    clauses = _parse_clauses(rest)
    return "{" + sel + ",plural," + " ".join(kw + c for kw, c in clauses) + "}"


def main() -> int:
    files = sorted(MESSAGES_DIR.glob("*.json"))
    if not files:
        print("no message files found", file=sys.stderr)
        return 1
    for path in files:
        data = json.loads(path.read_text(encoding="utf-8"))
        changed = 0
        for key, value in list(data.items()):
            if not key.startswith("liveBrowser."):
                continue
            if isinstance(value, str):
                new_value = {"defaultMessage": normalize_icu(value)}
                if data[key] != new_value:
                    data[key] = new_value
                    changed += 1
            elif isinstance(value, dict) and "defaultMessage" in value:
                norm = normalize_icu(value["defaultMessage"])
                if norm != value["defaultMessage"]:
                    value["defaultMessage"] = norm
                    changed += 1
        if changed:
            path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"{path.name}: {changed} keys normalized")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
