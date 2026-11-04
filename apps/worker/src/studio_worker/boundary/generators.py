"""Table fixture generators with planted truth (todo23 W4, D4, D5).

A generator makes a synthetic table from a `TableProfile` (never from the sample) and plants
known facts in it (anomalies, regimes, events). The worker picks the seed and the plants; the
caller can't. The truth goes to the verifier's store (the kernel's `verifier/` key, which the
builder can't read); the fixtures response carries only its id and digest.

Generators are registered per data kind. The platform ships one domain-neutral generator
(`profile-v1`: outliers and duplicate rows). Domain plugins add their own in
`plugins/<name>/src/<pkg>/fixture_generators.py`, which exports

    FIXTURE_GENERATORS = [{"id": "...", "kind": "table", "match": fn(profile) -> float,
                           "generate": fn(profile, rng, rows) -> (columns, rows, truth)}]

where `truth` is a list of `{"row": int, "kind": str, ...}` plants. `discover()` loads them from
the checkout's (or image's) `plugins/` folder.
"""

from __future__ import annotations

import importlib.util
import logging
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Callable

log = logging.getLogger(__name__)

Generate = Callable[[dict | None, Any, int], tuple[list[str], list[list[Any]], list[dict]]]


@dataclass(frozen=True)
class Generator:
    id: str
    kind: str
    match: Callable[[dict | None], float]
    generate: Generate


REGISTRY: dict[str, Generator] = {}


def register(id: str, kind: str, match: Callable[[dict | None], float], generate: Generate) -> None:
    REGISTRY[id] = Generator(id, kind, match, generate)


def _value(col: dict, rng, i: int) -> Any:
    lt = col.get("logicalType")
    if rng.random() < float(col.get("nullRate") or 0):
        return ""
    if lt in ("integer", "number"):
        q = col.get("quantiles") or [0.0, 25.0, 50.0, 75.0, 100.0]
        u = rng.random() * (len(q) - 1)
        lo = int(u)
        v = q[lo] + (q[min(lo + 1, len(q) - 1)] - q[lo]) * (u - lo)
        return int(round(v)) if lt == "integer" else round(float(v), 4)
    if lt in ("date", "datetime"):
        d = col.get("dates") or {"from": "2000-01"}
        y, m = (int(x) for x in d["from"].split("-"))
        return (date(y, m, 1) + timedelta(days=i)).isoformat()
    if lt == "boolean":
        return "true" if rng.random() < 0.5 else "false"
    if lt == "categorical":
        cats = col.get("categories") or [{"value": "category_0", "share": 1.0}]
        values = [c["value"] if not str(c["value"]).startswith("<") else f"category_{j}" for j, c in enumerate(cats)]
        p = [max(float(c.get("share") or 0), 1e-6) for c in cats]
        s = sum(p)
        return values[int(rng.choice(len(values), p=[x / s for x in p]))]
    if lt == "identifier":
        return f"id_{i:06d}"
    return f"text_{i}"


def _generic(profile: dict | None, rng, rows: int) -> tuple[list[str], list[list[Any]], list[dict]]:
    cols = (profile or {}).get("columns") or [{"name": "value", "logicalType": "number", "nullRate": 0, "quantiles": [0, 1, 2, 3, 4]}]
    names = [c["name"] if not str(c["name"]).startswith("<") else f"col_{i}" for i, c in enumerate(cols)]
    out = [[_value(c, rng, i) for c in cols] for i in range(rows)]
    truth: list[dict] = []
    numeric = [j for j, c in enumerate(cols) if c.get("logicalType") in ("integer", "number")]
    for r in rng.choice(rows, size=min(3, rows), replace=False) if numeric and rows else []:
        j = int(rng.choice(numeric))
        hi = max(abs(float(x)) for x in (cols[j].get("quantiles") or [1.0])) or 1.0
        out[int(r)][j] = round(hi * float(rng.uniform(8, 15)), 2)
        truth.append({"row": int(r), "kind": "outlier", "column": names[j]})
    if rows > 4:
        src = int(rng.integers(0, rows - 1))
        dst = int(rng.integers(0, rows))
        out.insert(dst, list(out[src]))
        truth = [t | {"row": t["row"] + (t["row"] >= dst)} for t in truth]
        truth.append({"row": dst, "kind": "duplicate", "of": src + (src >= dst)})
    return names, out, truth


register("profile-v1", "table", lambda _p: 0.01, _generic)


def discover(plugins_dir: Path | None = None) -> list[str]:
    """Load `fixture_generators.py` of every plugin under `plugins_dir`; return the new ids."""
    if plugins_dir is None:
        from .. import config

        plugins_dir = config.REPO_ROOT / "plugins"
    added: list[str] = []
    for f in sorted(plugins_dir.glob("*/src/*/fixture_generators.py")) if plugins_dir.is_dir() else []:
        try:
            spec = importlib.util.spec_from_file_location(f"_studio_fixture_generators_{f.parent.name}", f)
            assert spec and spec.loader
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            for g in getattr(mod, "FIXTURE_GENERATORS", []):
                register(str(g["id"]), str(g.get("kind", "table")), g["match"], g["generate"])
                added.append(str(g["id"]))
        except Exception:  # noqa: BLE001 — one broken plugin must not stop the others
            log.exception("fixture generators in %s failed to load", f)
    return added


def choose(profile: dict | None, kind: str = "table", requested: str | None = None) -> Generator:
    if requested and requested in REGISTRY and REGISTRY[requested].kind == kind:
        return REGISTRY[requested]
    cands = [g for g in REGISTRY.values() if g.kind == kind]
    return max(cands, key=lambda g: g.match(profile))
