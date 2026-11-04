"""Deterministic, rules-based pre-review (todo23 W9, D11).

Runs before the model reviewer and on the calibration canaries. It finds the problem classes
that don't need judgement and reports them as a `review.v1` document (schemas/review.v1.json),
so its output and the reviewer model's are scored the same way. Stdlib only.

    python3 tests/review-canaries/pre_review.py <artifact dir> [--kind plugin --id x --version 1]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import UTC, datetime
from pathlib import Path

CODE = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".css"}
COPYLEFT = re.compile(r"\b(A?GPL|SSPL|LGPL|EUPL)(-\d|\b)", re.I)

NETWORK = [
    re.compile(r"\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\b"),
    re.compile(r"""["']fe["']\s*\+\s*["']tch["']|["']X["']\s*\+\s*["']MLHttp"""),  # split names
    re.compile(r"""["']https?://(?!localhost|127\.0\.0\.1)[^"']+["']"""),
]
RAW_COLOUR = re.compile(r"""(?<![\w-])(#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\()""")
FIXTURE_LITERAL = re.compile(r"""["'][^"']*fixture[^"']*["']""", re.I)


def _is_test(p: Path) -> bool:
    return "test" in p.parts or ".test." in p.name or ".spec." in p.name


def _finding(severity: str, cls: str, rel: str | None, line: int | None, claim: str) -> dict:
    return {"severity": severity, "class": cls, "file": rel, "line": line, "claim": claim, "test": None}


def scan(root: Path) -> list[dict]:
    out: list[dict] = []
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(root).as_posix()
        if p.name == "package.json":
            out += _package(p, rel)
            continue
        if p.suffix not in CODE:
            continue
        test = _is_test(p)
        for n, line in enumerate(p.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            code = line.split("//", 1)[0] if not line.lstrip().startswith("//") else ""
            if not code.strip():
                continue
            if not test and any(r.search(code) for r in NETWORK):
                out.append(_finding("blocker", "hidden-network", rel, n, "Reaches the network (directly, through a split name or a URL literal); viewers have none."))
            if not test and RAW_COLOUR.search(code) and "tokens" not in p.name:
                out.append(_finding("major", "off-token-colour", rel, n, "Raw colour value where a design token belongs."))
            if not test and FIXTURE_LITERAL.search(code):
                out.append(_finding("blocker", "fixture-overfit", rel, n, "Source special-cases a fixture name, so its tests pass only on the fixture."))
    return out


def _package(p: Path, rel: str) -> list[dict]:
    try:
        pkg = json.loads(p.read_text(encoding="utf-8"))
    except ValueError:
        return [_finding("major", "licence", rel, None, "package.json doesn't parse; licences can't be checked.")]
    out = []
    lic = str(pkg.get("license") or "")
    if COPYLEFT.search(lic):
        out.append(_finding("blocker", "licence", rel, None, f"{pkg.get('name')} is {lic}: copyleft code can't ship in a plugin."))
    for section in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
        for name, spec in (pkg.get(section) or {}).items():
            spec = str(spec)
            if spec.startswith("npm:") and not spec[4:].lstrip("@").startswith(name.lstrip("@").split("@")[0]):
                out.append(_finding("blocker", "licence", rel, None, f"{name} is an alias for {spec[4:]}: a renamed dependency hides its licence."))
            elif COPYLEFT.search(spec):
                out.append(_finding("blocker", "licence", rel, None, f"{name} looks copyleft ({spec})."))
    return out


def review(root: Path, kind: str = "canary", id_: str | None = None, version: str = "0") -> dict:
    findings = scan(root)
    blocker = any(f["severity"] in ("blocker", "major") for f in findings)
    return {
        "schema": "review.v1",
        "artifact": {"kind": kind, "id": id_ or root.name, "version": version},
        "reviewer": "system:pre-review",
        "model": "rules:pre-review-1",
        "verdict": "block" if blocker else "pass",
        "findings": findings,
        "createdAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
    }


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("dir", type=Path)
    ap.add_argument("--kind", default="canary")
    ap.add_argument("--id")
    ap.add_argument("--version", default="0")
    a = ap.parse_args(argv)
    doc = review(a.dir, a.kind, a.id, a.version)
    print(json.dumps(doc, indent=2))
    return 0 if doc["verdict"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
