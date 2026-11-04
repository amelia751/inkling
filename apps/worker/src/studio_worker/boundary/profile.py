"""Table profiles (todo23 D5a): a table's distributions, computed here next to the data.

What crosses the boundary for a table is its shape, never its values:

- column names (screened by the kernel's text check, as for every fingerprint);
- a logical type, a null rate (to 0.01) and a cardinality bucket per column;
- numeric columns: five coarse quantiles (p5 … p95) rounded to 2 significant digits;
- date columns: the range rounded to the month and the typical spacing;
- categorical values only when each appears at least k = 10 times; rarer ones become
  `<category:N>` (N = how many rows carry them), and a value that isn't identifier-shaped is
  never shown at all;
- identifier columns (by name, or almost-unique strings) report nothing beyond type and nulls.

`noise=True` adds Laplace noise to the row count and the category shares.
"""

from __future__ import annotations

import math
import re
import secrets
from collections import Counter
from datetime import date, datetime
from typing import Any

K = 10
SAFE_VALUE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.:/-]{0,63}$")
# Column names that hold identifiers or direct personal data: never profiled beyond type and nulls.
IDENTIFIER_NAME = re.compile(
    r"(^|[_\W])(id|uuid|guid|key|name|first|last|surname|email|e_?mail|phone|tel|mobile|fax|ssn|sin|nin|passport|licen[cs]e|"
    r"account|acct|iban|swift|bic|card|pan|routing|address|addr|street|zip|postcode|postal|ip|mac|dob|birth|mrn|patient|"
    r"customer|client|user|username|login|memo|note|notes|comment|description|desc|narrative|reference|ref)([_\W]|$)",
    re.I,
)
INT = re.compile(r"^[+-]?\d+$")
NUM = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DATETIME = re.compile(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$")
BOOL = {"true", "false", "yes", "no", "0", "1", "t", "f", "y", "n"}


def _sig2(x: float) -> float:
    if x == 0 or not math.isfinite(x):
        return 0.0
    return float(round(x, 1 - int(math.floor(math.log10(abs(x))))))


def _bucket(n: int) -> str:
    return "1" if n <= 1 else "2-10" if n <= 10 else "11-100" if n <= 100 else "101-1000" if n <= 1000 else "1001-10000" if n <= 10000 else ">10000"


def _laplace(scale: float) -> float:
    u = secrets.randbelow(10**9) / 10**9 - 0.5
    return -scale * math.copysign(1, u) * math.log(1 - 2 * abs(u) + 1e-12)


def _quantiles(xs: list[float]) -> list[float]:
    s = sorted(xs)
    out = []
    for q in (0.05, 0.25, 0.5, 0.75, 0.95):
        pos = q * (len(s) - 1)
        lo, hi = int(math.floor(pos)), int(math.ceil(pos))
        out.append(_sig2(s[lo] + (s[hi] - s[lo]) * (pos - lo)))
    return out


def _parse_date(v: str) -> date | None:
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def _frequency(ds: list[date]) -> str:
    u = sorted(set(ds))
    if len(u) < 3:
        return "irregular"
    gaps = sorted((b - a).days for a, b in zip(u, u[1:]))
    g = gaps[len(gaps) // 2]
    if g == 0:
        return "sub-daily"
    if g == 1:
        return "business-daily" if all(d.weekday() < 5 for d in u) and any(x == 3 for x in gaps) else "daily"
    if g in (2, 3) and all(d.weekday() < 5 for d in u):
        return "business-daily"
    return "weekly" if 6 <= g <= 8 else "monthly" if 27 <= g <= 32 else "quarterly" if 88 <= g <= 93 else "yearly" if 360 <= g <= 370 else "irregular"


def _logical(vals: list[str]) -> str:
    if not vals:
        return "empty"
    if all(INT.match(v) for v in vals):
        return "integer"
    if all(NUM.match(v) for v in vals):
        return "number"
    if all(v.lower() in BOOL for v in vals) and len({v.lower() for v in vals}) <= 2:
        return "boolean"
    if all(DATE.match(v) for v in vals):
        return "date"
    if all(DATE.match(v) or DATETIME.match(v) for v in vals):
        return "datetime"
    return "categorical"


def profile_column(name: str, cells: list[str], *, noise: bool = False) -> dict[str, Any]:
    vals = [c.strip() for c in cells if c is not None and c.strip() != ""]
    n = max(1, len(cells))
    distinct = len(set(vals))
    lt = _logical(vals)
    by_name = bool(IDENTIFIER_NAME.search(name))
    # Almost-unique strings are identifiers or free text whatever the column is called.
    if lt == "categorical" and len(vals) >= 20 and distinct / len(vals) > 0.5:
        lt = "identifier" if all(" " not in v for v in vals) else "text"
    identifier = by_name or lt == "identifier"
    col: dict[str, Any] = {"name": name, "logicalType": "identifier" if identifier and lt in ("categorical", "text") else lt, "identifier": identifier,
                           "nullRate": round(1 - len(vals) / n, 2), "cardinality": _bucket(distinct)}
    if identifier or lt in ("empty", "text"):
        return col
    if lt in ("integer", "number") and len(vals) >= K:
        col["quantiles"] = _quantiles([float(v) for v in vals])
    elif lt in ("date", "datetime"):
        ds = [d for d in (_parse_date(v) for v in vals) if d]
        if len(ds) >= K:
            col["dates"] = {"from": min(ds).strftime("%Y-%m"), "to": max(ds).strftime("%Y-%m"), "frequency": _frequency(ds)}
    elif lt in ("categorical", "boolean"):
        counts = Counter(v.lower() if lt == "boolean" else v for v in vals)
        cats, rare = [], 0
        for v, c in counts.most_common():
            if c >= K and SAFE_VALUE.match(v) and len(cats) < 63:
                share = c / n + (_laplace(1 / n) if noise else 0)
                cats.append({"value": v, "share": round(min(1, max(0, share)), 2)})
            else:
                rare += c
        if rare:
            cats.append({"value": f"<category:{rare}>", "share": round(rare / n, 2)})
        col["categories"] = cats
    return col


def profile_rows(names: list[str], rows: list[list[str]], *, noise: bool = False) -> dict[str, Any]:
    """`TableProfile` (boundary.ts) of a parsed table."""
    cols = [profile_column(nm, [r[i] if i < len(r) else "" for r in rows], noise=noise) for i, nm in enumerate(names[:512])]
    n = len(rows) + (round(_laplace(2)) if noise else 0)
    return {"rows": int(max(0, _sig2(max(0, n)))), "k": K, "noise": noise, "columns": cols}
