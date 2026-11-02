"""todo18 B: one name rule for everything a person names (files, folders, datasets,
collections, Studios). The web mirrors it in `apps/web/src/studio/lib/files/names.ts`
(`nameProblem`); keep the two in step (tests on both sides use the same cases)."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException

MAX_BYTES = 255


def problem(raw: Any, *, slash: bool = False) -> str | None:
    """The first rule `raw` breaks, as a sentence, or None. `slash`: "/" is not allowed (paths)."""
    name = str(raw if raw is not None else "").strip()
    if name in (".", ".."):
        return f"“{name}” can't be used as a name"
    name = name.rstrip(" .")
    if not name:
        return "A name can't be empty"
    if slash and "/" in name:
        return "A name can't contain “/”"
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in name):
        return "A name can't contain control characters"
    if len(name.encode()) > MAX_BYTES:
        return f"A name can be at most {MAX_BYTES} bytes long"
    return None


def clean(raw: Any, *, slash: bool = False) -> str:
    """The stored form (trimmed, trailing dots dropped), or 422 with the rule it breaks."""
    why = problem(raw, slash=slash)
    if why:
        raise HTTPException(422, why)
    return str(raw).strip().rstrip(" .")
