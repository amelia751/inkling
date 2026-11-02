"""A write's label set (todo17 D3): the project's rules labels ∪ the Studio environment's labels,
with `extends` presets resolved so preset-only labels count.

Annotations store the label the Studio uses: a Studio class id when the Studio has the label
(matched by the rules label's id or name, any case), else the rules label's id. Synonyms and
other spellings are rewritten to it (`label.synonym`, a fixable finding), so "PNA", "Pneumonia"
and "pneumonia" all land as one label.
"""

from __future__ import annotations

import copy
import unicodedata
from collections.abc import Mapping
from typing import Any

from sqlalchemy.orm import Session

from ..models import ProjectRow, WorkspaceEnvironment
from .lint import Violation, resolve_severity, violation


def _key(s: str) -> str:
    return unicodedata.normalize("NFC", s).strip().casefold()


def environment_labels(env: Any) -> list[str]:
    """Label ids an environment declares (after merging its `extends` presets): `labels` entries
    (strings, or groups whose `classes` are strings or `{id|name|label}`), first spelling wins."""
    if not isinstance(env, dict):
        return []
    from .environment_policy import _root
    from .environment_resolve import merged_spec

    try:
        merged = merged_spec(env, _root())
    except (OSError, ValueError):
        merged = env
    out: list[str] = []

    def add(x: Any) -> None:
        if isinstance(x, str) and x.strip():
            out.append(x)
        elif isinstance(x, dict):
            for k in ("id", "name", "label"):
                if isinstance(x.get(k), str) and x[k].strip():
                    out.append(x[k])
                    return

    for group in merged.get("labels") or ():
        if isinstance(group, dict) and isinstance(group.get("classes"), list):
            for c in group["classes"]:
                add(c)
        elif isinstance(group, dict) and isinstance(group.get("vocabulary"), list):
            for c in group["vocabulary"]:
                add(c)
        else:
            add(group)
    seen: set[str] = set()
    return [x for x in out if not (_key(x) in seen or seen.add(_key(x)))]


def studio_labels(db: Session, workspace_id: str, task_id: str) -> list[str]:
    row = db.get(WorkspaceEnvironment, (workspace_id, task_id))
    return environment_labels(row.environment if row is not None else None)


def project_rules(db: Session, project_id: str | None) -> dict[str, Any]:
    """The project's rules document (saved, else its preset's), or {} outside a project."""
    p = db.get(ProjectRow, project_id) if project_id else None
    if p is None:
        return {}
    from . import rules as rules_mod

    return rules_mod.get(db, p)["rules"] or {}


def _match(rules_labels: list[dict], word: str) -> dict | None:
    k = _key(word)
    for lab in rules_labels:
        if any(isinstance(w, str) and _key(w) == k for w in (lab.get("id"), lab.get("name"), *(lab.get("synonyms") or ()))):
            return lab
    return None


def effective_rules(rules: Mapping[str, Any], studio: list[str]) -> dict[str, Any]:
    """`rules` with the Studio's labels the rules don't know added as plain labels."""
    out = copy.deepcopy(dict(rules))
    labels = list(out.get("labels") or [])
    extra = [{"id": s, "name": s} for s in studio if _match(labels, s) is None]
    if extra:
        out["labels"] = labels + extra
    return out


def store_values(rules: Mapping[str, Any], studio: list[str]) -> dict[str, str]:
    """Rules label id → the string annotations store for it."""
    out: dict[str, str] = {}
    for lab in rules.get("labels") or ():
        ident = lab.get("id") or lab.get("name")
        keys = {_key(w) for w in (lab.get("id"), lab.get("name")) if isinstance(w, str)}
        out[ident] = next((s for s in studio if _key(s) in keys), ident)
    return out


def canonicalise(annotations: list[Any], rules: Mapping[str, Any], studio: list[str]) -> list[Violation]:
    """Rewrite each annotation's label (in place) to its stored form; a `label.synonym` finding
    per rewrite. Unknown labels are left for the `labels` family to reject."""
    labels = list(rules.get("labels") or [])
    if not labels:
        return []
    store = store_values(rules, studio)
    found: list[Violation] = []
    for i, a in enumerate(annotations):
        if not isinstance(a, dict) or not isinstance(a.get("label"), str):
            continue
        lab = _match(labels, a["label"])
        if lab is None:
            continue
        target = store[lab.get("id") or lab.get("name")]
        if a["label"] == target:
            continue
        before = a["label"]
        synonym = _key(before) not in {_key(w) for w in (lab.get("id"), lab.get("name")) if isinstance(w, str)}
        what = "a synonym of" if synonym else "another spelling of"
        v = violation("label.synonym", f"/annotations/{i}/label", f"'{before}' is {what} '{lab.get('name') or target}'. Rewritten to '{target}'.", value=before, allowed=[target])
        a["label"] = target
        found.append(resolve_severity(v, rules))
    return [v for v in found if v.severity != "off"]
