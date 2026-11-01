"""The deterministic preset table (`registry/intents.json`, todo11 D5) for the kernel's fast path
(todo13 principle 3): the same matching as `packages/studio-tools/src/intents.ts`
`resolveIntent`, so a drop's detected kinds (and the request, when there is one) pick the same
preset in the kernel as in the browser and the agent. No model in the critical path.

Matching is case-insensitive and word-bounded, a space or hyphen inside a term matches either or
none, a trailing plural is accepted for words of three letters or more, multi-word terms weigh
more, and ties go to the earlier entry. `unambiguous` adds what the fast path needs: a single
best preset, never a tie.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import cache, lru_cache
from pathlib import Path

from ..config import settings

# Letters and digits, Unicode-aware (Python's `re` has no \p{L}: `[^\W_]` is the same class).
_ALNUM = r"[^\W_]"


@dataclass(frozen=True)
class Match:
    preset: str
    score: int
    matched: tuple[str, ...]


@cache
def _table_at(path: str) -> dict:
    return json.loads(Path(path).read_text())


def table() -> dict:
    """The registry's table (`<registry>/intents.json`, else the checkout's); empty if neither."""
    for root in (Path(settings().registry_dir), Path(settings().repo_root) / "registry"):
        if (root / "intents.json").is_file():
            return _table_at(str(root / "intents.json"))
    return {"version": 1, "intents": []}


@lru_cache(maxsize=2048)
def term_pattern(term: str) -> re.Pattern:
    words = re.split(r"[\s-]+", term.strip().lower())
    body = r"[\s-]?".join(re.escape(w) for w in words)
    plural = r"(?:e?s)?" if len(words[-1]) >= 3 else ""
    return re.compile(rf"(?<!{_ALNUM}){body}{plural}(?!{_ALNUM})", re.IGNORECASE)


def _weight(term: str) -> int:
    return len(re.split(r"[\s-]+", term.strip()))


def scores(text: str, tbl: dict, file_kinds: list[str] | None = None) -> list[Match]:
    """Every entry that matched, in table order."""
    kinds = {k.lower() for k in file_kinds or []}
    out = []
    for entry in tbl.get("intents") or []:
        matched: list[str] = []
        score = 0
        for term in entry.get("terms") or []:
            if text and term_pattern(term).search(text):
                matched.append(term)
                score += _weight(term)
        for k in entry.get("fileKinds") or []:
            if k.lower() in kinds:
                matched.append(f"kind:{k}")
                score += 1
        if score > 0:
            out.append(Match(entry["preset"], score, tuple(matched)))
    return out


def resolve(text: str, tbl: dict, file_kinds: list[str] | None = None) -> Match | None:
    """`resolveIntent`: the best preset, ties to the earlier entry; None when nothing matches."""
    best: Match | None = None
    for m in scores(text, tbl, file_kinds):
        if best is None or m.score > best.score:
            best = m
    return best


def unambiguous(text: str | None, file_kinds: list[str], tbl: dict | None = None) -> Match | None:
    """The fast path's preset: the single best match, or None on a tie or no match."""
    ms = scores(text or "", tbl if tbl is not None else table(), file_kinds)
    if not ms:
        return None
    top = max(m.score for m in ms)
    best = [m for m in ms if m.score == top]
    return best[0] if len(best) == 1 else None


def preset_for_kind(kind: str, tbl: dict | None = None) -> str | None:
    """The preset for one detected kind alone (a new collection's Studio), or None."""
    m = unambiguous(None, [kind], tbl)
    return m.preset if m else None
