"""Finance fixture generators with planted truth (todo23 W4, W8). numpy only, seeded by the
worker's rng; the worker (not the caller) decides where the plants go and keeps the truth.

Each generator: `generate(profile, rng, rows) -> (columns, rows, truth)`, where truth is a list
of `{"row": int, "kind": str, ...}`. `match(profile)` scores how well a table profile fits.
"""

from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Any

import numpy as np

CATEGORIES = ["groceries", "rent", "utilities", "travel", "payroll", "software", "dining", "insurance"]


def _names(profile: dict | None) -> list[str]:
    return [str(c.get("name", "")).lower() for c in (profile or {}).get("columns") or []]


def _has(names: list[str], *words: str) -> bool:
    return any(re.search(rf"(^|_){w}(_|$)", n) for n in names for w in words)


def _col(profile: dict | None, *words: str, types: tuple[str, ...] = ()) -> dict | None:
    for c in (profile or {}).get("columns") or []:
        n = str(c.get("name", "")).lower()
        if any(re.search(rf"(^|_){w}(_|$)", n) for w in words) and (not types or c.get("logicalType") in types):
            return c
    return None


def _start(profile: dict | None) -> date:
    for c in (profile or {}).get("columns") or []:
        if c.get("dates"):
            y, m = (int(x) for x in c["dates"]["from"].split("-"))
            return date(y, m, 1)
    return date(2020, 1, 1)


# ---- Ledger -------------------------------------------------------------------------------


def ledger_match(profile: dict | None) -> float:
    n = _names(profile)
    return 0.5 * _has(n, "amount", "debit", "credit", "value") + 0.3 * _has(n, "category", "account", "gl", "type") + 0.2 * _has(n, "date", "posted", "booked")


def ledger(profile: dict | None, rng: Any, rows: int) -> tuple[list[str], list[list[Any]], list[dict]]:
    """date, merchant, category, amount, currency. A merchant always maps to one category; the
    plants break that (miscategorised), repeat a row (duplicate) or blow up an amount (outlier)."""
    cat_col = _col(profile, "category", "type", "gl", types=("categorical",))
    cats = [c["value"] for c in (cat_col or {}).get("categories") or [] if not str(c["value"]).startswith("<")] or CATEGORIES
    if len(cats) < 2:
        cats = CATEGORIES
    amt = _col(profile, "amount", "value", "debit", "credit", types=("integer", "number"))
    q = (amt or {}).get("quantiles") or [5.0, 20.0, 60.0, 150.0, 900.0]
    med = max(abs(float(q[2])), 1.0)
    sigma = max(0.3, float(np.log(max(abs(float(q[4])), med * 1.5) / med)) / 1.645)
    merchants = [f"m{j:03d}" for j in range(max(len(cats) * 3, 12))]
    m_cat = {m: cats[j % len(cats)] for j, m in enumerate(merchants)}
    start = _start(profile)
    out: list[list[Any]] = []
    for i in range(rows):
        m = merchants[int(rng.integers(0, len(merchants)))]
        out.append([(start + timedelta(days=int(i * 365 / max(rows, 1)))).isoformat(), m, m_cat[m], round(float(rng.lognormal(np.log(med), sigma)), 2), "USD"])
    truth: list[dict] = []
    picks = rng.choice(rows, size=min(rows, 9), replace=False)
    for r in picks[:3]:  # outliers: 20-50x the 95th percentile
        out[int(r)][3] = round(abs(float(q[4]) or med) * float(rng.uniform(20, 50)), 2)
        truth.append({"row": int(r), "kind": "outlier", "column": "amount"})
    for r in picks[3:6]:  # miscategorised: a category the merchant never has
        right = out[int(r)][2]
        out[int(r)][2] = [c for c in cats if c != right][int(rng.integers(0, len(cats) - 1))]
        truth.append({"row": int(r), "kind": "miscategorised", "column": "category", "expected": right})
    for src in sorted((int(x) for x in picks[6:9]), reverse=True):  # duplicates: the same row twice in a row
        out.insert(src + 1, list(out[src]))
        truth = [t | {"row": t["row"] + (t["row"] > src)} | ({"of": t["of"] + (t["of"] > src)} if "of" in t else {}) for t in truth]
        truth.append({"row": src + 1, "kind": "duplicate", "of": src})
    return ["date", "merchant", "category", "amount", "currency"], out, sorted(truth, key=lambda t: t["row"])


# ---- Prices -------------------------------------------------------------------------------


def prices_match(profile: dict | None) -> float:
    n = _names(profile)
    return 0.6 * _has(n, "close", "adj_close", "price") + 0.2 * _has(n, "open", "high", "low") + 0.2 * _has(n, "volume")


def prices(profile: dict | None, rng: Any, rows: int) -> tuple[list[str], list[list[Any]], list[dict]]:
    """Business-daily OHLCV from a GBM whose drift and volatility change at planted regime
    boundaries, with planted gaps (missing days) and one unadjusted split."""
    close_col = _col(profile, "close", "adj_close", "price", types=("integer", "number"))
    p0 = float(((close_col or {}).get("quantiles") or [100.0] * 5)[2]) or 100.0
    n_reg = 3
    bounds = sorted(int(x) for x in rng.choice(np.arange(rows // 5, rows - rows // 5), size=n_reg - 1, replace=False))
    regimes = [(float(rng.uniform(-0.002, 0.002)), float(rng.choice([0.008, 0.02, 0.04]))) for _ in range(n_reg)]
    truth: list[dict] = [{"row": b, "kind": "regime-shift", "drift": regimes[k + 1][0], "vol": regimes[k + 1][1]} for k, b in enumerate(bounds)]
    reg = np.searchsorted(np.array(bounds), np.arange(rows), side="right")
    mu = np.array([regimes[r][0] for r in reg])
    sd = np.array([regimes[r][1] for r in reg])
    ret = rng.normal(mu - sd**2 / 2, sd)
    close = p0 * np.exp(np.cumsum(ret))
    split_at = int(rng.integers(rows // 4, 3 * rows // 4))
    ratio = int(rng.choice([2, 3, 4]))
    close[split_at:] /= ratio
    volume = rng.lognormal(13, 0.4, rows)
    volume[split_at:] *= ratio
    truth.append({"row": split_at, "kind": "split", "ratio": ratio})
    days, d = [], _start(profile)
    while len(days) < rows:
        if d.weekday() < 5:
            days.append(d)
        d += timedelta(days=1)
    drop: set[int] = set()
    for g in rng.choice(np.arange(5, rows - 10), size=2, replace=False):  # gaps: 3-6 missing business days
        drop.update(range(int(g), int(g) + int(rng.integers(3, 7))))
    drop.discard(split_at)
    drop.difference_update(bounds)
    out, index = [], {}
    for i in range(rows):
        if i in drop:
            continue
        index[i] = len(out)
        o = close[i - 1] if i else close[0]
        if i == split_at:
            o = close[i]
        hi, lo = max(o, close[i]) * (1 + abs(rng.normal(0, sd[i] / 2))), min(o, close[i]) * (1 - abs(rng.normal(0, sd[i] / 2)))
        out.append([days[i].isoformat(), round(float(o), 4), round(float(hi), 4), round(float(lo), 4), round(float(close[i]), 4), int(volume[i])])
    truth = [t | {"row": index[t["row"]]} for t in truth]
    runs, prev = [], None
    for i in sorted(drop):
        if prev is not None and i == prev + 1:
            runs[-1][1] += 1
        else:
            runs.append([i, 1])
        prev = i
    for start, length in runs:
        nxt = next((index[j] for j in range(start + length, rows) if j in index), len(out))
        truth.append({"row": nxt, "kind": "gap", "missing": length})
    return ["date", "open", "high", "low", "close", "volume"], out, sorted(truth, key=lambda t: t["row"])


FIXTURE_GENERATORS = [
    {"id": "finance-ledger", "kind": "table", "match": ledger_match, "generate": ledger},
    {"id": "finance-prices", "kind": "table", "match": prices_match, "generate": prices},
]
