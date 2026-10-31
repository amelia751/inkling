"""RFC 8785 JSON Canonicalization Scheme and content hashes (todo10 Phase 1).

The Python twin of `packages/contracts/src/canonical.ts`; both are checked against
`packages/contracts/test-vectors/canonical.json`, so an environment or lockfile hashes the
same in the kernel and in the browser.

- objects: members sorted by the UTF-16 code units of their names, no whitespace;
- strings: ECMAScript `JSON.stringify` escaping (control characters only; UTF-8 otherwise);
- numbers: ECMAScript `Number.prototype.toString`. Integers beyond 2**53 become the double
  JavaScript would read; NaN and infinities aren't JSON and raise.
"""

from __future__ import annotations

import hashlib
import json
import math
from decimal import Decimal
from typing import Any

NULL_CONTENT_HASH = "sha256:74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
_SAFE_INT = 2**53


def _number(v: float) -> str:
    if not math.isfinite(v):
        raise ValueError(f"{v} isn't a JSON number")
    if v == 0:
        return "0"
    # repr() is the shortest round-trip form; ECMAScript only lays the same digits out differently.
    sign, digits, exp = Decimal(repr(v)).as_tuple()
    ds = "".join(map(str, digits)).rstrip("0") or "0"
    assert isinstance(exp, int)
    n = len(digits) + exp  # position of the decimal point relative to the digit string
    k = len(ds)
    if k <= n <= 21:
        out = ds + "0" * (n - k)
    elif 0 < n <= 21:
        out = ds[:n] + "." + ds[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * -n + ds
    else:
        e = n - 1
        out = ds[0] + ("." + ds[1:] if k > 1 else "") + "e" + ("+" if e >= 0 else "-") + str(abs(e))
    return ("-" if sign else "") + out


def _key(k: str) -> bytes:
    return k.encode("utf-16-be", "surrogatepass")


def _write(v: Any, out: list[str]) -> None:
    if v is None:
        out.append("null")
    elif v is True:
        out.append("true")
    elif v is False:
        out.append("false")
    elif isinstance(v, int):
        out.append(str(v) if -_SAFE_INT <= v <= _SAFE_INT else _number(float(v)))
    elif isinstance(v, float):
        out.append(_number(v))
    elif isinstance(v, str):
        out.append(json.dumps(v, ensure_ascii=False))
    elif isinstance(v, (list, tuple)):
        out.append("[")
        for i, x in enumerate(v):
            if i:
                out.append(",")
            _write(x, out)
        out.append("]")
    elif isinstance(v, dict):
        bad = next((k for k in v if not isinstance(k, str)), None)
        if bad is not None:
            raise TypeError(f"object keys must be strings, not {type(bad).__name__}")
        out.append("{")
        for i, k in enumerate(sorted(v, key=_key)):
            if i:
                out.append(",")
            out.append(json.dumps(k, ensure_ascii=False))
            out.append(":")
            _write(v[k], out)
        out.append("}")
    else:
        raise TypeError(f"a {type(v).__name__} isn't JSON")


def canonicalize(v: Any) -> str:
    out: list[str] = []
    _write(v, out)
    return "".join(out)


def canonical_bytes(v: Any) -> bytes:
    return canonicalize(v).encode("utf-8")


def content_hash(v: Any) -> str:
    """`sha256:<hex>` of the canonical UTF-8 bytes."""
    return "sha256:" + hashlib.sha256(canonical_bytes(v)).hexdigest()
