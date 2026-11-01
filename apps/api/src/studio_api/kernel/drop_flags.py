"""The two flags drop plans read (todo13 §7.1): `auto_apply` (D6) and `fast_path` (principle 3).

They're todo13-entry's (`kernel/features.py`, `API_FEATURE_*` in the config module); this shim
reads them from there when it's present, else (before that merge) from the environment. Tests
pin them with `OVERRIDES`, so a test doesn't depend on the environment's defaults (on in dev and
test, off in production).
"""

from __future__ import annotations

from typing import Literal

from ..config import env

Flag = Literal["auto_apply", "fast_path"]
OVERRIDES: dict[str, bool] = {}


def enabled(flag: Flag) -> bool:
    if flag in OVERRIDES:
        return OVERRIDES[flag]
    try:
        from . import features  # type: ignore[attr-defined]

        return bool(features.enabled(flag))
    except ImportError:
        return (env(f"API_FEATURE_{flag.upper()}") or "0").lower() in ("1", "true")
