"""Label rules: label.unknown, label.synonym (fixable), geometry.not-allowed.

Input: `{"annotations": [{"label": str, "geometry": {"type": str}}...]}`.
"""

from __future__ import annotations

import unicodedata
from collections.abc import Mapping
from typing import Any

from . import Violation, violation


def _key(s: str) -> str:
    return unicodedata.normalize("NFC", s).strip().casefold()


def label_index(rules: Mapping[str, Any]) -> tuple[dict[str, dict], dict[str, str]]:
    """(canonical key -> label, synonym key -> canonical name)."""
    canon: dict[str, dict] = {}
    syn: dict[str, str] = {}
    for lab in rules.get("labels") or ():
        name = lab.get("name") or lab.get("id")
        canon[_key(name)] = lab
        if lab.get("id"):
            canon.setdefault(_key(lab["id"]), lab)
        for s in lab.get("synonyms") or ():
            syn[_key(s)] = name
    return canon, syn


def canonical_label(label: str, rules: Mapping[str, Any]) -> str | None:
    """The canonical name for `label` (itself, case-folded, or a synonym), or None if unknown."""
    canon, syn = label_index(rules)
    k = _key(label)
    if k in canon:
        return canon[k].get("name") or canon[k].get("id")
    return syn.get(k)


def check(data: Mapping[str, Any], rules: Mapping[str, Any]) -> list[Violation]:
    if not rules.get("labels"):
        return []  # a project without a label set accepts any label
    canon, syn = label_index(rules)
    names = sorted(lab.get("name") or lab.get("id") for lab in canon.values())
    out: list[Violation] = []
    for i, ann in enumerate(data.get("annotations") or ()):
        label = ann.get("label")
        if not isinstance(label, str):
            continue
        path = f"/annotations/{i}/label"
        k = _key(label)
        if k in syn and k not in canon:
            out.append(violation("label.synonym", path, f"'{label}' is a synonym of '{syn[k]}'.", value=label, allowed=[syn[k]]))
            lab = canon.get(_key(syn[k]))
        elif k in canon:
            lab = canon[k]
        else:
            out.append(violation("label.unknown", path, f"'{label}' is not a label in this project.", value=label, allowed=sorted(set(names))))
            continue
        geo = (ann.get("geometry") or {}).get("type")
        allowed = (lab or {}).get("allowedGeometries")
        if geo and allowed and geo not in allowed:
            out.append(violation("geometry.not-allowed", f"/annotations/{i}/geometry/type", f"Label '{lab.get('name')}' does not allow '{geo}'.", value=geo, allowed=list(allowed)))
    return out
