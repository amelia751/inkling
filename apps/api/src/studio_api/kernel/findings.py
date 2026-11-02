"""What's stored is re-checked (todo17 D5, D10): lint findings, the `rules.scan` job, fixes.

A finding is keyed by (project, resource kind, resource id, rule, path). `record` upserts what a
write or a scan reported for one resource and resolves (sets `resolved_at` on) the findings it no
longer reports; `sync` does the same for many resources of one kind at once (the scan). Only the
rule codes a check covers are resolved by it (`codes`), so an imaging check never clears a label
finding and the other way round.

Evaluate mode (D5) is not stored: a rule is in evaluate mode while its catalogue entry says so and
the project's rules don't list it under `enforce`. "Would have rejected N writes" counts the
error findings that writes recorded for rules that are (still) in evaluate mode.

Resource kinds and paths:
- `annotation`: resource id is the task id, path `/annotations/<annotation id>/<field>`;
- `file`: resource id is the source node id, path `/path` (names are never stored, D6);
- `dataset`: resource id is the dataset id, path as the datasets family reports it.

The `rules.scan` job is a `scheduled_runs` row (`rules.scan.project`, period = job id, result =
`{state, projectId, reason, ...}`): every rules change enqueues one, the worker's scheduled tick
drains them (`/api/v1/worker/scheduled/rules.scan`) and runs the daily scan of every project at
API_RULES_SCAN_HOUR (UTC). `POST …/scan` enqueues and runs at once.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Iterable, Mapping
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..models import AnnotationDocumentRow, DatasetRow, FsBatch, LintFinding, ProjectRow, ProjectRulesHistory, ScheduledRun, SourceNode, TaskRow
from .lint import CATALOGUE, Violation, run_families
from .lint import datasets as lint_datasets
from .lint import labels as lint_labels
from .lint import layout as lint_layout

SOURCES = ("write", "scan")
LABEL_CODES = frozenset({"label.unknown", "label.synonym", "geometry.not-allowed"})
LAYOUT_CODES = frozenset({"layout.misplaced", "layout.forbidden-char", "layout.too-deep", "name.pattern"})
DATASET_CODES = frozenset({"dataset.metadata-missing", "dataset.name-taken", "dataset.mixed-modality"})
CODES_BY_KIND = {"annotation": LABEL_CODES, "file": LAYOUT_CODES, "dataset": DATASET_CODES}
# The fixes that apply without a person's judgement (D10): (kind, rule).
FIXABLE = {("annotation", "label.synonym"), ("file", "name.pattern")}
SCAN_JOB = "rules.scan.project"
DAILY_JOB = "rules.scan"


def _now() -> datetime:
    return datetime.now(UTC)


def _vjson(v: Violation | Mapping[str, Any]) -> dict[str, Any]:
    if isinstance(v, Violation):
        return {"rule": v.rule, "severity": v.severity, "path": v.path, "message": v.message}
    return {"rule": str(v.get("rule")), "severity": str(v.get("severity") or "error"), "path": v.get("path") or "", "message": str(v.get("message") or "")}


def _codes_of(kind: str, reported: Iterable[dict], codes: Iterable[str] | None) -> set[str]:
    if codes is not None:
        return set(codes)
    return set(CODES_BY_KIND.get(kind, ())) | {r["rule"] for r in reported}


def sync(db: Session, project_id: str, resource_kind: str, results: Mapping[str, Iterable[Violation | Mapping[str, Any]]], source: str, *, codes: Iterable[str] | None = None, complete: bool = False) -> dict[str, int]:
    """Upsert the findings of many resources of one kind and resolve the ones they no longer
    report. `complete=True` (a scan of every resource of this kind) also resolves findings on
    resources missing from `results` (deleted, trashed)."""
    if source not in SOURCES:
        raise ValueError(f"source is one of {SOURCES}")
    reported = {rid: [_vjson(v) for v in vs] for rid, vs in results.items()}
    scope = _codes_of(resource_kind, (r for vs in reported.values() for r in vs), codes)
    q = select(LintFinding).where(LintFinding.project_id == project_id, LintFinding.resource_kind == resource_kind)
    if not complete:
        ids = list(reported)
        if not ids:
            return {"recorded": 0, "resolved": 0}
        q = q.where(LintFinding.resource_id.in_(ids))
    existing: dict[tuple[str, str, str], LintFinding] = {}
    for row in db.scalars(q):
        key = (row.resource_id, row.rule, row.path or "")
        # Keep the open row over a resolved one with the same key.
        if key not in existing or existing[key].resolved_at is not None:
            existing[key] = row
    now = _now()
    seen: set[tuple[str, str, str]] = set()
    recorded = 0
    for rid, vs in reported.items():
        for v in vs:
            key = (rid, v["rule"], v["path"] or "")
            if key in seen:
                continue
            seen.add(key)
            row = existing.get(key)
            if row is None:
                db.add(LintFinding(id=uuid.uuid4().hex, project_id=project_id, resource_kind=resource_kind, resource_id=rid, rule=v["rule"], severity=v["severity"], path=v["path"], message=v["message"], source=source, first_seen=now))
                recorded += 1
                continue
            if row.resolved_at is not None:  # it came back: open again, seen anew
                row.resolved_at, row.first_seen, row.source = None, now, source
                recorded += 1
            row.severity, row.message = v["severity"], v["message"]
    resolved = 0
    for key, row in existing.items():
        if row.resolved_at is None and key not in seen and row.rule in scope:
            row.resolved_at = now
            resolved += 1
    db.flush()
    return {"recorded": recorded, "resolved": resolved}


def record(db: Session, project_id: str, resource_kind: str, resource_id: str, violations: Iterable[Violation | Mapping[str, Any]], source: str, *, codes: Iterable[str] | None = None) -> dict[str, int]:
    """What one write (or check) found on one resource; resolves what it no longer finds."""
    return sync(db, project_id, resource_kind, {resource_id: list(violations)}, source, codes=codes)


def resolve_missing(db: Session, project_id: str, resource_kind: str, resource_id: str, still: Iterable[tuple[str, str]] = (), *, codes: Iterable[str] | None = None) -> int:
    """Resolve the open findings on a resource except the (rule, path) pairs in `still`."""
    keep = {(r, p or "") for r, p in still}
    scope = set(codes) if codes is not None else set(CODES_BY_KIND.get(resource_kind, ()))
    n = 0
    for row in db.scalars(select(LintFinding).where(LintFinding.project_id == project_id, LintFinding.resource_kind == resource_kind, LintFinding.resource_id == resource_id, LintFinding.resolved_at.is_(None))):
        if row.rule in scope and (row.rule, row.path or "") not in keep:
            row.resolved_at = _now()
            n += 1
    db.flush()
    return n


# ---- Reading --------------------------------------------------------------------------------


def evaluating(rule: str, rules: Mapping[str, Any]) -> bool:
    spec = CATALOGUE.get(rule)
    return bool(spec and spec.evaluate and rule not in set(rules.get("enforce") or ()))


def finding_json(row: LintFinding, rules: Mapping[str, Any]) -> dict[str, Any]:
    spec = CATALOGUE.get(row.rule)
    return {
        "id": row.id,
        "resourceKind": row.resource_kind,
        "resourceId": row.resource_id,
        "rule": row.rule,
        "severity": row.severity,
        "path": row.path,
        "message": row.message,
        "fix": spec.fix if spec else "",
        "fixable": (row.resource_kind, row.rule) in FIXABLE,
        "mode": "evaluate" if evaluating(row.rule, rules) else "enforce",
        "source": row.source,
        "firstSeen": row.first_seen.isoformat() if row.first_seen else None,
        "resolvedAt": row.resolved_at.isoformat() if row.resolved_at else None,
    }


def would_have_rejected(db: Session, project_id: str, rules: Mapping[str, Any]) -> dict[str, int]:
    """D5: per rule in evaluate mode, the error findings writes recorded (open or since resolved)."""
    out: dict[str, int] = {}
    for row in db.scalars(select(LintFinding).where(LintFinding.project_id == project_id, LintFinding.source == "write", LintFinding.severity == "error")):
        if evaluating(row.rule, rules):
            out[row.rule] = out.get(row.rule, 0) + 1
    return out


def listing(db: Session, p: ProjectRow, rules: Mapping[str, Any], state: str = "open", limit: int = 500) -> dict[str, Any]:
    q = select(LintFinding).where(LintFinding.project_id == p.id)
    if state != "all":
        q = q.where(LintFinding.resolved_at.is_(None))
    rows = list(db.scalars(q.order_by(LintFinding.first_seen.desc()).limit(max(1, min(limit, 2000)))))
    counts = {"error": 0, "warn": 0, "info": 0}
    for sev, n in by_severity(db, p.id).items():
        counts[sev] = n
    return {"findings": [finding_json(r, rules) for r in rows], "counts": counts, "wouldHaveRejected": would_have_rejected(db, p.id, rules)}


def by_severity(db: Session, project_id: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for sev in db.scalars(select(LintFinding.severity).where(LintFinding.project_id == project_id, LintFinding.resolved_at.is_(None))):
        out[sev] = out.get(sev, 0) + 1
    return out


def by_rule(db: Session, project_id: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for rule in db.scalars(select(LintFinding.rule).where(LintFinding.project_id == project_id, LintFinding.resolved_at.is_(None))):
        out[rule] = out.get(rule, 0) + 1
    return out


def require_finding(db: Session, p: ProjectRow, finding_id: str) -> LintFinding:
    row = db.get(LintFinding, finding_id)
    if row is None or row.project_id != p.id:
        raise HTTPException(404, "no such finding")
    return row


# ---- Checking what's stored ------------------------------------------------------------------


def _rules(db: Session, p: ProjectRow) -> dict[str, Any]:
    from . import rules as krules

    return krules.get(db, p)["rules"]


def _task_ids(db: Session, project_id: str) -> list[str]:
    return list(db.scalars(select(TaskRow.id).where(TaskRow.project_id == project_id, TaskRow.trashed_at.is_(None))))


def check_annotations(annotations: list[Any], rules: Mapping[str, Any]) -> list[Violation]:
    """The label family over a document, with paths by annotation id (stable across saves)."""
    anns = [a for a in annotations if isinstance(a, dict)]
    out = []
    for v in run_families([lint_labels.check], {"annotations": anns}, rules):
        parts = v.path.split("/")  # /annotations/<i>/<field...>
        i = int(parts[2])
        ann_id = str(anns[i].get("id") or i)
        v.path = "/".join(["", "annotations", ann_id, *parts[3:]])
        out.append(v)
    return out


def check_file(path: str, rules: Mapping[str, Any]) -> list[Violation]:
    return run_families([lint_layout.check], {"path": path}, rules)


def _dataset_input(ds: DatasetRow, others: list[str]) -> dict[str, Any]:
    d = ds.definition or {}
    meta = d.get("metadata") if isinstance(d.get("metadata"), dict) else {}
    return {"dataset": {"name": ds.title, "metadata": meta, "modalities": d.get("modalities") or []}, "existingNames": others}


def _live_files(db: Session, project_id: str) -> dict[str, str]:
    """node id -> current path, for files not in Trash (nor inside a trashed folder)."""
    from . import tree

    ids = list(db.scalars(select(SourceNode.id).where(SourceNode.project_id == project_id, SourceNode.is_dir.is_(False), SourceNode.trashed_at.is_(None))))
    return {nid: c.path for nid, c in tree.chains(db, ids).items() if not c.hidden}


def scan_project(db: Session, p: ProjectRow) -> dict[str, Any]:
    """Re-check every annotation document, file path and dataset of the project (source=scan)."""
    rules = _rules(db, p)
    tasks = _task_ids(db, p.id)
    ann: dict[str, list[Violation]] = {}
    if tasks:
        for row in db.scalars(select(AnnotationDocumentRow).where(AnnotationDocumentRow.task_id.in_(tasks))):
            ann.setdefault(row.task_id, []).extend(check_annotations(list(row.annotations or []), rules))
    files = {nid: check_file(path, rules) for nid, path in _live_files(db, p.id).items()}
    dsets = list(db.scalars(select(DatasetRow).where(DatasetRow.project_id == p.id, DatasetRow.trashed_at.is_(None))))
    ds: dict[str, list[Violation]] = {}
    for d in dsets:
        others = [o.title for o in dsets if o.id != d.id]
        ds[d.id] = run_families([lint_datasets.check], _dataset_input(d, others), rules)
    out: dict[str, Any] = {"projectId": p.id, "annotations": len(ann), "files": len(files), "datasets": len(ds)}
    for kind, results in (("annotation", ann), ("file", files), ("dataset", ds)):
        r = sync(db, p.id, kind, results, "scan", codes=CODES_BY_KIND[kind], complete=True)
        out["recorded"] = out.get("recorded", 0) + r["recorded"]
        out["resolved"] = out.get("resolved", 0) + r["resolved"]
    out["open"] = sum(by_rule(db, p.id).values())
    return out


# ---- The rules.scan job ---------------------------------------------------------------------


def enqueue_scan(db: Session, project_id: str, reason: str) -> str:
    job_id = "scan-" + uuid.uuid4().hex
    db.add(ScheduledRun(name=SCAN_JOB, period=job_id, result={"state": "queued", "projectId": project_id, "reason": reason}, at=_now()))
    db.flush()
    return job_id


def run_scan_job(db: Session, job_id: str) -> dict[str, Any] | None:
    row = db.get(ScheduledRun, (SCAN_JOB, job_id))
    if row is None or not isinstance(row.result, dict) or row.result.get("state") != "queued":
        return None
    meta = dict(row.result)
    p = db.get(ProjectRow, meta.get("projectId"))
    if p is None or p.trashed_at is not None:
        row.result = {**meta, "state": "skipped"}
        return row.result
    row.result = {**meta, "state": "done", "result": scan_project(db, p)}
    db.flush()
    return row.result


def drain(db: Session, *, limit: int = 20) -> list[str]:
    """Run the queued per-project scans (rules changes, `POST …/scan`); returns their job ids.
    A scan run twice records nothing twice, so racing replicas cost only time."""
    since = _now() - timedelta(days=2)
    rows = list(db.scalars(select(ScheduledRun).where(ScheduledRun.name == SCAN_JOB, ScheduledRun.at >= since).order_by(ScheduledRun.at)))
    done = []
    for row in rows:
        if len(done) >= limit:
            break
        if isinstance(row.result, dict) and row.result.get("state") == "queued" and run_scan_job(db, row.period):
            done.append(row.period)
    return done


def scan_all(db: Session) -> dict[str, Any]:
    n = 0
    for p in list(db.scalars(select(ProjectRow).where(ProjectRow.trashed_at.is_(None), ProjectRow.archived.is_(False)))):
        scan_project(db, p)
        n += 1
    return {"projects": n}


def daily(db: Session, *, hour: int, now: datetime | None = None) -> dict[str, Any]:
    """The daily scan of every project, once per UTC day from `hour` on (any worker may ask)."""
    from ..dbutil import insert_ignore

    now = now or _now()
    if now.hour < hour:
        return {"ran": False, "reason": "before the scan hour"}
    period = now.strftime("%Y-%m-%d")
    insert_ignore(db, ScheduledRun, [{"name": DAILY_JOB, "period": period, "at": now}])
    claimed = db.execute(update(ScheduledRun).where(ScheduledRun.name == DAILY_JOB, ScheduledRun.period == period, ScheduledRun.result.is_(None)).values(result={"state": "running"})).rowcount  # type: ignore[attr-defined]
    if not claimed:
        return {"ran": False, "period": period}
    result = scan_all(db)
    db.execute(update(ScheduledRun).where(ScheduledRun.name == DAILY_JOB, ScheduledRun.period == period).values(result=result))
    return {"ran": True, "period": period, "result": result}


# ---- Fixes ----------------------------------------------------------------------------------


def _is_person(ctx: Any) -> bool:
    return ctx.on_behalf_of is None and not ctx.principal.startswith(("agent:", "service:", "worker:"))


def normalised_name(name: str, pattern: str, forbidden: str | Iterable[str] = "") -> str | None:
    """A rename that matches `pattern`, if a mechanical one does: case, separators, forbidden chars."""
    bad = set(forbidden or "")
    stem, dot, ext = name.rpartition(".")
    if not dot or not stem:
        stem, ext = name, ""
    cleaned = "".join("_" if (c in bad or c.isspace()) else c for c in stem)
    cands = []
    for sep in ("_", "-"):
        s = re.sub(r"[_\-\s]+", sep, cleaned).strip(sep)
        for variant in (s, s.lower()):
            for e in (ext, ext.lower()):
                cands.append(f"{variant}.{e}" if e else variant)
    for c in dict.fromkeys(cands):
        if c and c != name and re.fullmatch(pattern, c):
            return c
    return None


def plan_fix(db: Session, p: ProjectRow, row: LintFinding, rules: Mapping[str, Any]) -> dict[str, Any]:
    """The operation that fixes a fixable finding: `{op, input}` (409 when there is none)."""
    if (row.resource_kind, row.rule) not in FIXABLE or row.resolved_at is not None:
        raise HTTPException(409, {"error": "not fixable", "rule": row.rule})
    if row.rule == "label.synonym":
        parts = (row.path or "").split("/")
        if len(parts) < 4 or parts[1] != "annotations":
            raise HTTPException(409, {"error": "not fixable", "rule": row.rule})
        ann_id = parts[2]
        for doc in db.scalars(select(AnnotationDocumentRow).where(AnnotationDocumentRow.task_id == row.resource_id)):
            for a in doc.annotations or []:
                if isinstance(a, dict) and str(a.get("id")) == ann_id and isinstance(a.get("label"), str):
                    canon = lint_labels.canonical_label(a["label"], rules)
                    if canon and canon != a["label"]:
                        return {"op": "annotation.relabel", "input": {"taskId": row.resource_id, "annotationId": ann_id, "label": canon}}
        raise HTTPException(409, {"error": "not fixable", "rule": row.rule, "reason": "the annotation changed; scan again"})
    # name.pattern
    n = db.get(SourceNode, row.resource_id)
    layout = rules.get("layout") or {}
    pattern = layout.get("fileNamePattern")
    if n is None or n.project_id != p.id or not pattern:
        raise HTTPException(409, {"error": "not fixable", "rule": row.rule})
    new = normalised_name(n.name, pattern, layout.get("forbiddenCharacters") or "")
    if new is None:
        raise HTTPException(409, {"error": "not fixable", "rule": row.rule, "reason": "no mechanical rename matches the pattern"})
    return {"op": "source.rename", "input": {"nodeId": n.id, "name": new}}


def apply_op(db: Session, ctx: Any, p: ProjectRow, op: dict[str, Any], rules: Mapping[str, Any]) -> None:
    """Apply a fix operation directly (people) and re-check the resource it changed."""
    inp = op["input"]
    if op["op"] == "annotation.relabel":
        for doc in list(db.scalars(select(AnnotationDocumentRow).where(AnnotationDocumentRow.task_id == inp["taskId"]))):
            anns = [dict(a) if isinstance(a, dict) and str(a.get("id")) == inp["annotationId"] else a for a in doc.annotations or []]
            for a in anns:
                if isinstance(a, dict) and str(a.get("id")) == inp["annotationId"]:
                    a["label"] = inp["label"]
            doc.annotations = anns
            doc.revision = (doc.revision or 0) + 1
            doc.saved_at = _now()
        db.flush()
        found: list[Violation] = []
        for doc in db.scalars(select(AnnotationDocumentRow).where(AnnotationDocumentRow.task_id == inp["taskId"])):
            found.extend(check_annotations(list(doc.annotations or []), rules))
        record(db, p.id, "annotation", inp["taskId"], found, "write", codes=LABEL_CODES)
        return
    if op["op"] == "source.rename":
        from . import fs, tree

        fs.apply(db, ctx, p, {"ops": [{"kind": "rename", "nodeId": inp["nodeId"], "name": inp["name"]}]})
        n = db.get(SourceNode, inp["nodeId"])
        if n is not None:
            record(db, p.id, "file", n.id, check_file(tree.path_of(db, n), rules), "write", codes=LAYOUT_CODES)
        return
    raise HTTPException(409, {"error": "not fixable", "op": op["op"]})


def _change_requests() -> Any:
    try:
        from . import change_requests  # type: ignore[attr-defined]  # W-CR (todo17 D7)
    except ImportError:
        return None
    return change_requests if hasattr(change_requests, "open_or_append") else None


def propose(db: Session, ctx: Any, ops: list[dict[str, Any]], *, title: str) -> dict[str, Any]:
    """Put `ops` into one change request (the assistant never applies fixes itself, D10)."""
    cr_mod = _change_requests()
    if cr_mod is None:
        raise HTTPException(503, "change requests are not available on this server")
    cr: dict[str, Any] = {}
    for op in ops:
        cr = cr_mod.open_or_append(db, ctx, op["op"], op["input"], title=title)
    return cr


def fix(db: Session, ctx: Any, p: ProjectRow, finding_id: str) -> dict[str, Any]:
    rules = _rules(db, p)
    row = require_finding(db, p, finding_id)
    op = plan_fix(db, p, row, rules)
    if not _is_person(ctx):
        return {"changeRequest": propose(db, ctx, [op], title=f"Fix {row.rule}")}
    apply_op(db, ctx, p, op, rules)
    return {"applied": True}


def gardener(db: Session, ctx: Any, p: ProjectRow) -> dict[str, Any]:
    """The gardener (D10): every fixable open finding becomes an operation in ONE change request
    ("Tidy: N fixes"). It never applies or merges anything."""
    rules = _rules(db, p)
    ops: list[dict[str, Any]] = []
    skipped = 0
    for row in db.scalars(select(LintFinding).where(LintFinding.project_id == p.id, LintFinding.resolved_at.is_(None)).order_by(LintFinding.first_seen)):
        if (row.resource_kind, row.rule) not in FIXABLE:
            continue
        try:
            ops.append(plan_fix(db, p, row, rules))
        except HTTPException:
            skipped += 1
    if not ops:
        return {"changeRequest": None, "fixes": 0, "skipped": skipped}
    cr = propose(db, ctx, ops, title=f"Tidy: {len(ops)} fix{'es' if len(ops) != 1 else ''}")
    return {"changeRequest": cr, "fixes": len(ops), "skipped": skipped}


# ---- Promotion (D5) -------------------------------------------------------------------------


def promote(db: Session, ctx: Any, p: ProjectRow, body: Mapping[str, Any]) -> dict[str, Any]:
    """Set a rule's severity (and end its evaluate mode): a rules edit, so it has history."""
    import copy

    from . import rules as krules

    krules.require_person(ctx)
    rule, severity = body.get("rule"), body.get("severity")
    if not isinstance(rule, str) or rule not in CATALOGUE:
        raise HTTPException(422, {"error": "unknown rule", "rule": rule})
    if severity not in ("error", "warn", "info", "off"):
        raise HTTPException(422, {"error": "severity is one of error, warn, info, off"})
    cur = krules.get(db, p)
    new = copy.deepcopy(cur["rules"])
    new["severityOverrides"] = {**(new.get("severityOverrides") or {}), rule: severity}
    if CATALOGUE[rule].evaluate and severity != "off":
        new["enforce"] = sorted({*(new.get("enforce") or ()), rule})
    return krules.put(db, ctx, p, {"rules": new, "baseRevision": cur["revision"]})


# ---- Context (D9) ---------------------------------------------------------------------------


def how_to_add_data(rules: Mapping[str, Any]) -> str:
    lines: list[str] = []
    layout = rules.get("layout") or {}
    if layout.get("folderPatterns"):
        lines.append("Put files under one of these folders: " + ", ".join(layout["folderPatterns"]) + ".")
    if layout.get("fileNamePattern"):
        lines.append(f"File names must match the pattern {layout['fileNamePattern']}.")
    forbidden = layout.get("forbiddenCharacters")
    if forbidden:
        lines.append("Don't use these characters in paths: " + " ".join(forbidden if isinstance(forbidden, list) else list(forbidden)) + ".")
    if layout.get("maxDepth") is not None:
        lines.append(f"Keep paths at most {layout['maxDepth']} folders deep.")
    labels = rules.get("labels") or []
    if labels:
        parts = []
        for lab in labels:
            name = lab.get("name") or lab.get("id")
            syn = lab.get("synonyms") or []
            parts.append(f"{name} (also written {', '.join(syn)})" if syn else name)
        lines.append("Label with: " + "; ".join(parts) + ". Synonyms are rewritten to the canonical label.")
    ds = rules.get("datasets") or {}
    if ds.get("requiredMetadata"):
        lines.append("Every dataset needs: " + ", ".join(ds["requiredMetadata"]) + ".")
    if ds.get("oneModalityPerDataset"):
        lines.append("Keep one modality per dataset.")
    lines.append("Changes to published datasets and Studios go through a change request.")
    return "\n".join(lines)


def context(db: Session, p: ProjectRow) -> dict[str, Any]:
    from . import rules as krules

    r = krules.get(db, p)
    rules = r["rules"]
    tasks = list(db.scalars(select(TaskRow).where(TaskRow.project_id == p.id, TaskRow.trashed_at.is_(None), TaskRow.state == "published").order_by(TaskRow.created_at)))
    ds_ids = {t.dataset_id for t in tasks}
    datasets = list(db.scalars(select(DatasetRow).where(DatasetRow.id.in_(ds_ids), DatasetRow.trashed_at.is_(None)))) if ds_ids else []
    changes: list[dict[str, Any]] = []
    for b in db.scalars(select(FsBatch).where(FsBatch.project_id == p.id).order_by(FsBatch.at.desc()).limit(10)):
        changes.append({"kind": "files" if b.resource == "source" else b.resource, "label": b.label, "actor": b.actor, "onBehalfOf": b.on_behalf_of, "at": b.at.isoformat() if b.at else None})
    for h in db.scalars(select(ProjectRulesHistory).where(ProjectRulesHistory.project_id == p.id).order_by(ProjectRulesHistory.revision.desc()).limit(5)):
        changes.append({"kind": "rules", "label": f"rules revision {h.revision}", "actor": h.actor, "onBehalfOf": h.on_behalf_of, "at": h.created_at.isoformat() if h.created_at else None})
    changes.sort(key=lambda c: c["at"] or "", reverse=True)
    return {
        "project": {"id": p.id, "name": p.title, "preset": r.get("preset") or krules.project_preset(db, p)},
        "rules": {
            "revision": r["revision"],
            "labels": [{"id": lab.get("id"), "name": lab.get("name"), "synonyms": lab.get("synonyms") or [], "allowedGeometries": lab.get("allowedGeometries") or []} for lab in rules.get("labels") or []],
            "layout": rules.get("layout") or {},
            "requiredMetadata": (rules.get("datasets") or {}).get("requiredMetadata") or [],
            "datasets": rules.get("datasets") or {},
            "severityOverrides": rules.get("severityOverrides") or {},
        },
        "rulesSource": r["source"],
        "findings": {"byRule": by_rule(db, p.id), "counts": by_severity(db, p.id)},
        "published": {
            "datasets": [{"id": d.id, "name": d.title} for d in datasets],
            "studios": [{"id": t.id, "name": t.title, "datasetId": t.dataset_id} for t in tasks],
        },
        "recentChanges": changes[:10],
        "howToAddData": how_to_add_data(rules),
    }
