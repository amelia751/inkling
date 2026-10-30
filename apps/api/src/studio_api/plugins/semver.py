"""Minimal semver: x.y.z versions and npm-style ranges (^ ~ >= > <= < = x * , space AND, || OR)."""

from __future__ import annotations

import re

_V = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$")


def parse(v: str) -> tuple[int, int, int, tuple]:
    m = _V.match(v.strip())
    if not m:
        raise ValueError(f"not a semver version: {v!r}")
    pre = tuple(int(p) if p.isdigit() else p for p in m.group(4).split(".")) if m.group(4) else ()
    return int(m.group(1)), int(m.group(2)), int(m.group(3)), pre


def key(v: str):
    a, b, c, pre = parse(v)
    # A release sorts after its pre-releases.
    return (a, b, c, 1 if not pre else 0, tuple((0, p) if isinstance(p, int) else (1, p) for p in pre))


def _partial(v: str) -> tuple[int | None, int | None, int | None]:
    parts = [p for p in v.strip().lstrip("v=").split(".") if p]
    out: list[int | None] = []
    for p in parts[:3]:
        out.append(None if p in ("x", "X", "*") else int(p))
    while len(out) < 3:
        out.append(None)
    return out[0], out[1], out[2]


def _cmp(v: str, op: str, target: str) -> bool:
    a, b, c = _partial(target)
    t = (a or 0, b or 0, c or 0)
    x = parse(v)[:3]
    if op in ("", "="):
        return all(p is None or p == q for p, q in zip((a, b, c), x))
    return {">=": x >= t, ">": x > t, "<=": x <= t, "<": x < t}[op]


def _comparator(v: str, comp: str) -> bool:
    comp = comp.strip()
    if comp in ("", "*", "x", "latest"):
        return True
    if comp.startswith("^"):
        a, b, c = _partial(comp[1:])
        lo = (a or 0, b or 0, c or 0)
        if a:
            hi = (a + 1, 0, 0)
        elif b:
            hi = (0, b + 1, 0)
        else:
            hi = (0, 0, (c or 0) + 1) if c is not None else (0, 1, 0)
        x = parse(v)[:3]
        return lo <= x < hi
    if comp.startswith("~"):
        a, b, c = _partial(comp[1:])
        lo = (a or 0, b or 0, c or 0)
        hi = (a or 0, (b or 0) + 1, 0) if b is not None else ((a or 0) + 1, 0, 0)
        x = parse(v)[:3]
        return lo <= x < hi
    m = re.match(r"^(>=|<=|>|<|=)?\s*(.+)$", comp)
    assert m
    return _cmp(v, m.group(1) or "", m.group(2))


def satisfies(version: str, rng: str) -> bool:
    try:
        parse(version)
    except ValueError:
        return False
    for alt in rng.split("||"):
        comps = re.findall(r"(?:>=|<=|>|<|=|\^|~)?\s*[\w.*]+", alt)
        if all(_comparator(version, c) for c in comps) if comps else True:
            return True
    return False


def max_satisfying(versions: list[str], rng: str) -> str | None:
    ok = [v for v in versions if satisfies(v, rng)]
    return max(ok, key=key) if ok else None
