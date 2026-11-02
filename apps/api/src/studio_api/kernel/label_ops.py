"""Label rename and merge (todo17 Milestone 1): rules and annotations change together.

`labels.rename {from, to}` renames a label in the project's rules (its old name becomes a
synonym) and rewrites every annotation in the project that uses it (or one of its synonyms).
`labels.merge {from: [...], into}` folds labels, synonyms or stray label strings into one label
(they become its synonyms) and rewrites their annotations. Each runs in the request's one
transaction: a new rules revision with a history row, the annotation documents (revision bumped)
and an undo journal entry in the project's audit chain (`plugin_audit`, target
`rules-history:<id>`) holding the rules before and each annotation's previous label.
`labels.undo {historyId}` puts both back, while the rules have not changed since.

A plain rules edit (PUT/PATCH) that would leave annotations with a label the rules no longer
know is refused with `label.in-use`, naming the count and the merge operation (as Label Studio
refuses label config changes that orphan annotations). Rules with no labels mean "no label set".
"""

from __future__ import annotations

import copy
from collections import Counter
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..context import RequestContext
from ..models import AnnotationDocumentRow, PluginAudit, ProjectRow
from . import audit
from . import rules as krules
from .admission import Ctx, Operation, WriteRejected, admit, register
from .lint import Violation, violation
from .lint.labels import _key, canonical_label

RENAME, MERGE, UNDO, RULES_UPDATE = "labels.rename", "labels.merge", "labels.undo", "rules.update"
JOURNALED = (RENAME, MERGE)
for _op in (RENAME, MERGE, UNDO, RULES_UPDATE):
    register(Operation(id=_op, scope="project:write", tier="write"))


def admit_rules_update(ctx: RequestContext, p: ProjectRow, *, dry_run: bool = False) -> None:
    """`rules.update` through the pipeline's permit step (the rules themselves are checked by
    `kernel.rules.validate` and `check_orphans`)."""
    admit(RULES_UPDATE, {}, Ctx(project_id=p.id, principal=ctx.principal, on_behalf_of=ctx.on_behalf_of, rules={}), dry_run=dry_run)


def _name(label: dict) -> str:
    return label.get("name") or label["id"]


def _names(rules: dict) -> list[str]:
    return [_name(lab) for lab in rules.get("labels") or ()]


def _reject(rule: str, path: str, message: str, **kw: Any) -> WriteRejected:
    return WriteRejected([violation(rule, path, message, **kw)])


def _docs(db: Session, p: ProjectRow, *, lock: bool = False) -> list[AnnotationDocumentRow]:
    q = select(AnnotationDocumentRow).where(AnnotationDocumentRow.workspace_id == p.id).order_by(AnnotationDocumentRow.task_id)
    return list(db.scalars(q.with_for_update() if lock else q))


# ---- orphan check (rules PUT/PATCH) -----------------------------------------------------------


def orphans(db: Session, p: ProjectRow, old: dict, new: dict) -> Counter[str]:
    """Old canonical label -> how many annotations would no longer match any label in `new`."""
    out: Counter[str] = Counter()
    if not new.get("labels") or not old.get("labels"):
        return out
    for doc in _docs(db, p):
        for a in doc.annotations or ():
            label = a.get("label") if isinstance(a, dict) else None
            if not isinstance(label, str):
                continue
            was = canonical_label(label, old)
            if was is not None and canonical_label(label, new) is None:
                out[was] += 1
    return out


def _suggest(old: dict, new: dict) -> str | None:
    """The label a removed one most likely went to: one the change added, else the first label."""
    added = [n for n in _names(new) if canonical_label(n, old) is None]
    return (added or _names(new) or [None])[0]


def check_orphans(db: Session, p: ProjectRow, old: dict, new: dict) -> None:
    counts = orphans(db, p, old, new)
    if not counts:
        return
    into = _suggest(old, new)
    vs: list[Violation] = []
    for label, n in sorted(counts.items()):
        uses = f"{n} annotation{'s' if n != 1 else ''} use{'s' if n == 1 else ''} '{label}'"
        target = f"'{into}'" if into else "another label"
        vs.append(
            violation(
                "label.in-use",
                "/labels",
                f"{uses}; these rules no longer have that label.",
                value=label,
                allowed=_names(new),
                fix=f"{uses}; merge it into {target} with labels.merge (POST /api/v1/projects/{p.id}/labels/merge "
                f'{{"from": ["{label}"], "into": "{into or "<label>"}"}}), or rename it with labels.rename, instead of removing it.',
                extra={"count": n},
            )
        )
    raise WriteRejected(vs, title="The rules change would orphan annotations")


# ---- rename / merge ---------------------------------------------------------------------------


def _str(v: Any, path: str) -> str:
    if not isinstance(v, str) or not v.strip() or len(v) > 200:
        raise HTTPException(422, {"error": f"{path} must be a non-empty string (at most 200 characters)"})
    return v


def _find(rules: dict, name: str) -> int | None:
    """Index of the label whose name or id is `name` (case-folded), not a synonym."""
    k = _key(name)
    for i, lab in enumerate(rules.get("labels") or ()):
        if k in (_key(_name(lab)), _key(lab.get("id") or "")):
            return i
    return None


def _add_synonyms(label: dict, extra: list[str]) -> None:
    own = _key(_name(label))
    seen = {own}
    out: list[str] = []
    for s in [*(label.get("synonyms") or []), *extra]:
        if isinstance(s, str) and _key(s) not in seen:
            seen.add(_key(s))
            out.append(s)
    label["synonyms"] = out


def plan_rename(rules: dict, frm: str, to: str) -> tuple[dict, dict[str, str]]:
    """(new rules, {annotation label key -> new label}) for renaming label `frm` to `to`."""
    i = _find(rules, frm)
    names = _names(rules)
    if i is None:
        syn_of = canonical_label(frm, rules)
        msg = f"'{frm}' is a synonym of '{syn_of}', not a label; rename '{syn_of}' or merge." if syn_of else f"'{frm}' is not a label in this project."
        raise _reject("label.unknown", "/from", msg, value=frm, allowed=names)
    new = copy.deepcopy(rules)
    lab = new["labels"][i]
    old_name = _name(lab)
    other = canonical_label(to, rules)
    if other is not None and _key(other) != _key(old_name):
        raise _reject(
            "label.name-taken",
            "/to",
            f"'{to}' is already the label '{other}'.",
            value=to,
            allowed=[other],
            fix=f"Merge instead: labels.merge {{\"from\": [\"{old_name}\"], \"into\": \"{other}\"}}.",
        )
    rewrite = {_key(old_name): to, **{_key(s): to for s in lab.get("synonyms") or ()}}
    if lab.get("id"):
        rewrite[_key(lab["id"])] = to
    lab["name"] = to
    lab["synonyms"] = [s for s in lab.get("synonyms") or () if _key(s) != _key(to)]
    if old_name != to:
        _add_synonyms(lab, [old_name] if _key(old_name) != _key(to) else [])
    return new, rewrite


def plan_merge(rules: dict, frm: list[str], into: str) -> tuple[dict, dict[str, str]]:
    j = _find(rules, into)
    if j is None:
        target = canonical_label(into, rules)
        j = _find(rules, target) if target else None
    if j is None:
        raise _reject("label.unknown", "/into", f"'{into}' is not a label in this project.", value=into, allowed=_names(rules))
    new = copy.deepcopy(rules)
    target_label = new["labels"][j]
    target_name = _name(target_label)
    rewrite: dict[str, str] = {}
    synonyms: list[str] = []
    drop: set[int] = set()
    for f in frm:
        i = _find(new, f)
        if i is not None and i == j:
            continue  # merging a label into itself
        if i is not None:
            lab = new["labels"][i]
            keys = [_name(lab), *(lab.get("synonyms") or [])] + ([lab["id"]] if lab.get("id") else [])
            synonyms += [_name(lab), *(lab.get("synonyms") or [])]
            rewrite.update({_key(k): target_name for k in keys})
            drop.add(i)
            continue
        for lab in new["labels"]:  # a synonym of another label moves over
            if lab is not target_label:
                lab["synonyms"] = [s for s in lab.get("synonyms") or () if _key(s) != _key(f)]
        synonyms.append(f)
        rewrite[_key(f)] = target_name
    _add_synonyms(target_label, synonyms)
    new["labels"] = [lab for i, lab in enumerate(new["labels"]) if i not in drop]
    return new, rewrite


def _rewrite(docs: list[AnnotationDocumentRow], rewrite: dict[str, str]) -> tuple[list[tuple[AnnotationDocumentRow, list]], list[list]]:
    """(documents with their new annotation lists, [[taskId, annotationId, before, after]...])."""
    changed: list[tuple[AnnotationDocumentRow, list]] = []
    journal: list[list] = []
    for doc in docs:
        anns, hit = [], False
        for a in doc.annotations or ():
            label = a.get("label") if isinstance(a, dict) else None
            to = rewrite.get(_key(label)) if isinstance(label, str) else None
            if to is not None and to != label:
                journal.append([doc.task_id, a.get("id"), label, to])
                a, hit = {**a, "label": to}, True
            anns.append(a)
        if hit:
            changed.append((doc, anns))
    return changed, journal


def _write_docs(changed: list[tuple[AnnotationDocumentRow, list]]) -> None:
    at = datetime.now(UTC)
    for doc, anns in changed:
        doc.annotations = anns
        doc.revision = (doc.revision or 0) + 1
        doc.saved_at = at


def _journal(db: Session, ctx: RequestContext, p: ProjectRow, action: str, history_id: int, before: dict, after: dict) -> None:
    audit.record(db, replace(ctx, workspace_id=p.id), action, target=f"rules-history:{history_id}", before=before, after=after)


def apply(db: Session, ctx: RequestContext, p: ProjectRow, op_id: str, body: Any, *, dry_run: bool = False) -> dict[str, Any]:
    krules.require_person(ctx)
    if not isinstance(body, dict):
        raise HTTPException(422, {"error": "body must be an object"})
    current = krules.get(db, p)
    admitted = admit(op_id, body, Ctx(project_id=p.id, principal=ctx.principal, on_behalf_of=ctx.on_behalf_of, rules=current["rules"]), dry_run=dry_run)
    data = admitted.value
    base = data.get("baseRevision", current["revision"])
    if op_id == RENAME:
        rules, rewrite = plan_rename(current["rules"], _str(data.get("from"), "from"), _str(data.get("to"), "to"))
    else:
        frm = data.get("from")
        if isinstance(frm, str):
            frm = [frm]
        if not isinstance(frm, list) or not frm or len(frm) > 100:
            raise HTTPException(422, {"error": "from must be a list of 1-100 labels"})
        rules, rewrite = plan_merge(current["rules"], [_str(f, "from[]") for f in frm], _str(data.get("into"), "into"))
    docs = _docs(db, p, lock=not dry_run)
    changed, journal = _rewrite(docs, rewrite)
    saved, hist = krules.save_row(db, ctx, p, rules, base, dry_run=dry_run)
    out = {
        **saved,
        "rewritten": {"annotations": len(journal), "documents": len(changed)},
        "findings": admitted.findings_json(),
    }
    if dry_run:
        return {**out, "historyId": None, "dryRun": True}
    _write_docs(changed)
    _journal(db, ctx, p, op_id, hist.id, {"rules": current["rules"], "revision": current["revision"]}, {"revision": hist.revision, "input": data, "changes": journal})
    db.flush()
    return {**out, "historyId": hist.id}


def undo(db: Session, ctx: RequestContext, p: ProjectRow, history_id: int, *, dry_run: bool = False) -> dict[str, Any]:
    krules.require_person(ctx)
    target = f"rules-history:{history_id}"
    rows = list(db.scalars(select(PluginAudit).where(PluginAudit.workspace_id == p.id, PluginAudit.target == target).order_by(PluginAudit.id)))
    entry = next((r for r in rows if r.action in JOURNALED), None)
    if entry is None:
        raise HTTPException(404, "No label rename or merge with that history id in this project")
    if any(r.action == UNDO for r in rows):
        raise HTTPException(409, {"error": "already undone"})
    current = krules.get(db, p)
    after = entry.after_ref or {}
    if current["revision"] != after.get("revision"):
        raise HTTPException(409, {"error": "The rules changed after this operation; undo the later changes first.", "revision": current["revision"]})
    admit(UNDO, {"historyId": history_id}, Ctx(project_id=p.id, principal=ctx.principal, on_behalf_of=ctx.on_behalf_of, rules=current["rules"]), dry_run=dry_run)
    by_task: dict[str, dict[str, tuple[str, str]]] = {}
    for task_id, ann_id, before, now_label in after.get("changes") or ():
        by_task.setdefault(task_id, {})[ann_id] = (before, now_label)
    changed: list[tuple[AnnotationDocumentRow, list]] = []
    restored = skipped = 0
    for doc in _docs(db, p, lock=not dry_run):
        want = by_task.get(doc.task_id)
        if not want:
            continue
        anns, hit = [], False
        for a in doc.annotations or ():
            back = want.get(a.get("id")) if isinstance(a, dict) else None
            if back is not None:
                if a.get("label") == back[1]:
                    a, hit = {**a, "label": back[0]}, True
                    restored += 1
                else:
                    skipped += 1  # relabelled since: leave the person's later edit alone
            anns.append(a)
        if hit:
            changed.append((doc, anns))
    saved, hist = krules.save_row(db, ctx, p, (entry.before_ref or {}).get("rules") or krules.empty_rules(), current["revision"], dry_run=dry_run)
    out = {**saved, "restored": {"annotations": restored, "documents": len(changed)}, "skipped": skipped}
    if dry_run:
        return {**out, "dryRun": True}
    _write_docs(changed)
    _journal(db, ctx, p, UNDO, history_id, {"revision": current["revision"]}, {"revision": hist.revision, "historyId": hist.id})
    db.flush()
    return {**out, "historyId": hist.id}
