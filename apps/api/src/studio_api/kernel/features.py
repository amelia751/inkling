"""Feature flags (todo13 §7.1): the four `API_FEATURE_*` keys, nothing else.

`GET /api/v1/features` serves `snapshot()`; the web app reads it once at start. Routes behind a
flag depend on `require("<flag>")`, which answers 404 while the flag is off, so a disabled
feature's routes don't exist as far as a caller can tell. No flag service: flags change by
config and rollout (§7.4).
"""

from __future__ import annotations

from typing import Literal

from fastapi import HTTPException

from ..config import settings

Flag = Literal["chat_drops", "auto_apply", "fast_path", "datasets_tab"]

# Short name → the camelCase key the web app reads.
FLAGS: dict[str, str] = {
    "chat_drops": "chatDrops",
    "auto_apply": "autoApply",
    "fast_path": "fastPath",
    "datasets_tab": "datasetsTab",
}


def enabled(flag: Flag) -> bool:
    return settings().feature(flag)


def snapshot() -> dict[str, bool]:
    """`{chatDrops, autoApply, fastPath, datasetsTab}` for the current settings."""
    s = settings()
    return {key: s.feature(name) for name, key in FLAGS.items()}


def require(flag: Flag):
    """A route dependency: 404 while `flag` is off (`dependencies=[Depends(features.require("chat_drops"))]`)."""
    if flag not in FLAGS:
        raise ValueError(f"unknown feature flag {flag!r}")

    def dep() -> None:
        if not enabled(flag):
            raise HTTPException(404, "Not Found")

    return dep
