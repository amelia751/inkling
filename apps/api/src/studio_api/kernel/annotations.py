"""Annotation API (docs/plugins.md §6): canonical document, provenance, review state, idempotent commits.

The document is the one the Studio loads and saves (`AnnotationDocument` in
packages/contracts/src/types). Plugin output reaches it only through `commit`, which
is idempotent per key, so re-running a job never duplicates annotations (§14 #7).
"""

from __future__ import annotations

import copy
import time
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..context import RequestContext
from ..models import AnnotationCommit, AnnotationDocumentRow, ProjectRow
from ..naming import canonical_id
from . import audit, labelset
from .admission import Admitted, Ctx, Operation, WriteRejected, admit, register
from .admission import doors
from .lint import annotations as lint_annotations
from .lint import labels as lint_labels

ANNOTATIONS_VERSION = 2
# `imported`: written from a source file (a CSV column), unreviewed until a person confirms it (todo6 D8).
PROVENANCE = {"human-created", "ai-suggested", "human-corrected", "imported"}
REVIEW_STATES = {"pending", "accepted", "rejected", "edited"}

# ---- v1 → v2 migration (port of packages/contracts/src/migrations/annotations-v1-to-v2.ts)

V1_TYPES = {"interval", "beat", "wave", "rhythm", "phase", "segment", "event", "mark", "point"}


def _convert(g: dict) -> tuple[dict, dict | None]:
    t = g["type"]
    if t == "interval":
        return {"type": "span", "start": g["start"], "end": g["end"], "channel": g["lead"]}, {"kind": "interval"}
    if t == "beat":
        return {"type": "instant", "t": g["t"], "channel": g["lead"]}, {"kind": "beat", "code": g["code"]}
    if t == "wave":
        attrs = {"kind": "wave", "wave": g["wave"], **({"peak": g["peak"]} if g.get("peak") is not None else {})}
        return {"type": "span", "start": g["onset"], "end": g["offset"], "channel": g["lead"]}, attrs
    if t == "rhythm":
        return {"type": "span", "start": g["start"], "end": g["end"], "channel": "rhythm"}, {"kind": "rhythm", "rhythm": g["rhythm"]}
    if t == "phase":
        return {"type": "instant", "frame": g["frame"]}, {"kind": "phase", "phase": g["phase"]}
    if t == "segment":
        return {"type": "span", "start": g["start"], "end": g["end"]}, None
    if t == "event":
        return {"type": "instant", "frame": g["frame"]}, None
    if t == "mark":
        return {"type": "keypoint", "x": g["x"], "y": g["y"]}, None
    if t == "point":
        return {"type": "point3d", "plane": g["plane"], "slice": g["slice"], "ijk": g["ijk"]}, None
    return g, None


def migrate_annotation(a: dict, only: set[str] | None = None) -> dict:
    t = a.get("geometry", {}).get("type")
    if t not in V1_TYPES or (only is not None and t not in only):
        return a
    geometry, attrs = _convert(a["geometry"])
    return {**a, "geometry": geometry, "attributes": {**(a.get("attributes") or {}), **attrs} if attrs else a.get("attributes")}


def migrate_document(doc: dict, only: set[str] | None = None) -> dict:
    anns = [migrate_annotation(a, only) for a in doc.get("annotations", [])]
    done = not any(a.get("geometry", {}).get("type") in V1_TYPES for a in anns)
    return {**doc, "annotations": anns, "annotationsVersion": ANNOTATIONS_VERSION if done else doc.get("annotationsVersion")}


# ---- Document ------------------------------------------------------------------------------


def _row(db: Session, ctx: RequestContext) -> AnnotationDocumentRow:
    row = db.get(AnnotationDocumentRow, (ctx.workspace_id, ctx.task))
    if row is None:
        row = AnnotationDocumentRow(workspace_id=ctx.workspace_id, task_id=ctx.task, revision=0, annotations=[])
        db.add(row)
        db.flush()
    return row


def _canonical(a: dict) -> dict:
    g = a.get("geometry") or {}
    t = g.get("type")
    return {**a, "geometry": {**g, "type": canonical_id(t)}} if isinstance(t, str) and canonical_id(t) != t else a


def get_document(db: Session, ctx: RequestContext) -> dict:
    row = db.get(AnnotationDocumentRow, (ctx.workspace_id, ctx.task))
    if row is None:
        return {"revision": 0, "annotations": []}
    doc = {"revision": row.revision, "annotations": [_canonical(a) for a in row.annotations]}
    if row.annotations_version is not None:
        doc["annotationsVersion"] = row.annotations_version
    if row.saved_at:
        doc["savedAt"] = row.saved_at.isoformat()
    return doc


def validate_annotation(a: Any) -> dict:
    """Shape check for canonical annotations; malformed plugin output never reaches the document (§14 #5)."""
    if not isinstance(a, dict):
        raise ValueError("annotation must be an object")
    for k in ("id", "itemId", "label", "provenance", "author", "createdAt"):
        if not isinstance(a.get(k), str) or not a[k]:
            raise ValueError(f"annotation.{k} must be a non-empty string")
    if a["provenance"] not in PROVENANCE:
        raise ValueError(f"annotation.provenance must be one of {sorted(PROVENANCE)}")
    g = a.get("geometry")
    if not isinstance(g, dict) or not isinstance(g.get("type"), str):
        raise ValueError("annotation.geometry.type is required")
    if g["type"] == "mask":
        dims, counts = g.get("dims"), g.get("counts")
        if not (isinstance(dims, list) and len(dims) >= 2 and all(isinstance(d, int) and d > 0 for d in dims)):
            raise ValueError("mask.dims must be positive integers")
        if not (isinstance(counts, list) and all(isinstance(c, int) and c >= 0 for c in counts)):
            raise ValueError("mask.counts must be non-negative integers")
        total = 1
        for d in dims:
            total *= d
        if sum(counts) != total:
            raise ValueError(f"mask.counts sum to {sum(counts)}, expected {total}")
    attrs = a.get("attributes")
    if attrs is not None and (not isinstance(attrs, dict) or any(not isinstance(v, (str, int, float, bool)) for v in attrs.values())):
        raise ValueError("annotation.attributes values must be strings, numbers or booleans")
    return a


# ---- Admission (todo17 D1): every annotation write runs admit() ---------------------------------

ANNOTATION_FAMILIES = (lint_annotations.check, lint_labels.check)
SAVE_OP = register(Operation(id="annotations.save", families=ANNOTATION_FAMILIES, scope="project:write"))
COMMIT_OP = register(Operation(id="annotations.commit", families=ANNOTATION_FAMILIES, scope="project:write", idempotent=True))


def admit_annotations(db: Session, ctx: RequestContext, op: Operation, annotations_: list, *, items: Any = None, dry_run: bool = False) -> Admitted:
    """Normalise (labels → the stored spelling), validate (shape, labels, geometry, the project's
    `annotations` rules) and permit a set of annotations. The label set is the project's rules
    labels ∪ the Studio's labels (presets resolved). Raises WriteRejected with every violation."""
    project = labelset.project_rules(db, ctx.workspace_id)
    studio = labelset.studio_labels(db, ctx.workspace_id, ctx.task)
    rules = labelset.effective_rules(project, studio)
    anns = [_canonical(a) if isinstance(a, dict) else a for a in copy.deepcopy(annotations_)]
    fixes = labelset.canonicalise(anns, rules, studio)
    data: dict[str, Any] = {"annotations": anns}
    if isinstance(items, dict):
        data["items"] = items
    c = Ctx(project_id=ctx.workspace_id if project else None, principal=ctx.principal, on_behalf_of=ctx.on_behalf_of, rules=rules)
    try:
        res = admit(op, data, c, dry_run=dry_run)
    except WriteRejected as e:
        e.violations += fixes
        raise
    res.findings = fixes + res.findings
    return res


def save_document(db: Session, ctx: RequestContext, doc: Any, *, dry_run: bool = False) -> tuple[dict, Admitted]:
    """Save the whole document (the Studio's autosave) through admit(): every violation of every
    item at once (422 problem JSON); synonyms are rewritten; warnings come back as `findings`.
    Bumps the revision. `doc.items` ({itemId: {width, height}}) enables the inside-image check."""
    if not isinstance(doc, dict) or not isinstance(doc.get("annotations"), list):
        raise HTTPException(400, "invalid annotation document")
    try:
        res = admit_annotations(db, ctx, SAVE_OP, doc["annotations"], items=doc.get("items"), dry_run=dry_run)
    except WriteRejected as e:
        raise doors.reject(e.violations, title="The annotations break the project's rules", errors=doors.legacy_errors(e.violations)) from None
    anns = res.value["annotations"]
    if dry_run:
        cur = get_document(db, ctx)
        return {"revision": cur["revision"], "annotations": anns}, res
    row = _row(db, ctx)
    base = doc.get("revision")
    if base is not None and int(base) != row.revision:
        # todo18 P0-4: someone saved since this client loaded; hand back their document to merge.
        raise HTTPException(409, {"code": "revision_conflict", "message": f"the document is at revision {row.revision}, this save was based on {base}", "current": get_document(db, ctx)})
    row.annotations = anns
    row.annotations_version = doc.get("annotationsVersion")
    row.revision += 1
    row.saved_at = datetime.now(UTC)
    doors.record_findings(db, _project_id(db, ctx), "annotations", ctx.task, res)
    return get_document(db, ctx), res


def _project_id(db: Session, ctx: RequestContext) -> str | None:
    return ctx.workspace_id if db.get(ProjectRow, ctx.workspace_id) is not None else None


def commit(db: Session, ctx: RequestContext, annotations: list[dict], *, idempotency_key: str | None, job_id: str | None = None, source: str) -> list[str]:
    """Append (or replace by id) canonical annotations as one revision. Idempotent per key."""
    if idempotency_key:
        prior = db.scalar(select(AnnotationCommit).where(AnnotationCommit.workspace_id == ctx.workspace_id, AnnotationCommit.idempotency_key == idempotency_key))
        if prior is not None:
            return list(prior.annotation_ids)
    checked = [_canonical(validate_annotation(a)) for a in annotations]
    ids = {a["id"] for a in checked}
    # Compare-and-set on the revision: jobs finishing at once (todo25: a Studio's batch runs in
    # parallel) each append to the same document, and a plain read-modify-write loses all but one.
    for attempt in range(50):
        row = _row(db, ctx)
        db.refresh(row)
        base = row.revision
        merged = [a for a in row.annotations if a.get("id") not in ids] + checked
        done = db.execute(
            update(AnnotationDocumentRow)
            .where(AnnotationDocumentRow.workspace_id == ctx.workspace_id, AnnotationDocumentRow.task_id == ctx.task, AnnotationDocumentRow.revision == base)
            .values(annotations=merged, revision=base + 1, annotations_version=row.annotations_version or ANNOTATIONS_VERSION, saved_at=datetime.now(UTC))
            .execution_options(synchronize_session=False)
        ).rowcount
        if done == 1:
            break
        db.expire(row)
        time.sleep(min(0.02 * (attempt + 1), 0.25))
    else:
        raise HTTPException(409, "the annotation document kept changing; try again")
    db.refresh(row)
    db.add(AnnotationCommit(workspace_id=ctx.workspace_id, idempotency_key=idempotency_key or uuid.uuid4().hex, job_id=job_id, annotation_ids=[a["id"] for a in checked]))
    audit.record(db, ctx, "annotations.commit", target=source, after={"ids": [a["id"] for a in checked], "jobId": job_id, "revision": row.revision})
    db.flush()
    return [a["id"] for a in checked]


# Core (bare-named) geometry types a plugin may write; module geometries are `<module>.<name>`.
CORE_GEOMETRIES = {"class", "box", "ellipse", "polygon", "multipolygon", "polyline", "spline", "keypoint", "point3d", "measurement", "mask", "span", "instant", "track"}


def plugin_write(db: Session, ctx: RequestContext, job: Any, annotations: list[Any], *, key: str | None, dry_run: bool = False) -> tuple[list[str], Admitted]:
    """`annotations.write` for a plugin session (the SDK's `ctx.annotations.write`).

    The same guarantees as the gateway's commit path, with identity from the context:
    the write is bound to a running job of the calling plugin version, each annotation is
    shape-checked (§14 #5), its item must be an asset of this workspace, and the kernel sets
    `author`, `provenance` and the stored id, so a plugin can neither pose as a human nor
    overwrite annotations it didn't write. Idempotent per (job, key) (§14 #7).
    """
    from . import assets

    if job.state != "running" or ctx.principal != f"plugin:{job.plugin_id}@{job.version}":
        raise HTTPException(409, "annotations can only be written by the plugin version running this job")
    if not isinstance(annotations, list) or not annotations or len(annotations) > 1000:
        raise HTTPException(422, "annotations must be a list of 1-1000 annotations")
    now = datetime.now(UTC).isoformat()
    out = []
    for i, a in enumerate(annotations):
        if not isinstance(a, dict):
            raise HTTPException(422, f"annotations[{i}] must be an object")
        local = str(a.get("id") or i)
        attrs = {**(a.get("attributes") or {}), "job_id": job.job_id, "review_status": "pending"}
        if job.provider:
            attrs.setdefault("provider", job.provider)
        stamped = {
            **{k: v for k, v in a.items() if k not in ("author", "provenance", "createdAt", "updatedAt")},
            "id": uuid.uuid5(uuid.NAMESPACE_URL, f"{job.job_id}/write/{local}").hex,
            "author": ctx.principal,
            "provenance": "ai-suggested",
            "createdAt": now,
            "attributes": attrs,
        }
        g = stamped.get("geometry")
        t = canonical_id(g["type"]) if isinstance(g, dict) and isinstance(g.get("type"), str) else None
        if t is not None and t not in CORE_GEOMETRIES and "." not in t:
            raise HTTPException(422, f"annotations[{i}]: geometry type {t!r} is neither a core geometry nor a module geometry (<module>.<name>)")
        if isinstance(stamped.get("itemId"), str) and stamped["itemId"]:
            try:
                assets.get_asset(db, ctx, stamped["itemId"])
            except HTTPException as e:
                raise HTTPException(422, f"annotations[{i}]: item {stamped['itemId']!r} isn't an asset of this workspace") from e
        out.append(stamped)
    scoped = ctx.for_scope(ctx.workspace_id, job.task_id)
    try:
        res = admit_annotations(db, scoped, COMMIT_OP, out, dry_run=dry_run)
    except WriteRejected as e:
        raise doors.reject(e.violations, title="The annotations break the project's rules", errors=doors.legacy_errors(e.violations)) from None
    if dry_run:
        return [a["id"] for a in res.value["annotations"]], res
    ids = commit(db, scoped, res.value["annotations"], idempotency_key=f"job:{job.job_id}:write:{key or uuid.uuid4().hex}", job_id=job.job_id, source=f"{job.plugin_id}.{job.tool}")
    doors.record_findings(db, _project_id(db, scoped), "annotations", scoped.task, res)
    return ids, res


def list_annotations(db: Session, ctx: RequestContext, item_id: str | None = None, label: str | None = None, limit: int = 1000) -> list[dict]:
    anns = get_document(db, ctx)["annotations"]
    if item_id:
        anns = [a for a in anns if a.get("itemId") == item_id]
    if label:
        anns = [a for a in anns if a.get("label") == label]
    return anns[:limit]


def set_review(db: Session, ctx: RequestContext, annotation_id: str, status: str) -> dict:
    """Accept / reject / mark edited one plugin-produced annotation (review_status in attributes)."""
    if status not in REVIEW_STATES:
        raise HTTPException(422, f"review status must be one of {sorted(REVIEW_STATES)}")
    row = _row(db, ctx)
    for i, a in enumerate(row.annotations):
        if a.get("id") == annotation_id:
            attrs = {**(a.get("attributes") or {}), "review_status": status}
            updated = {**a, "attributes": attrs, "updatedAt": datetime.now(UTC).isoformat()}
            if status in ("accepted", "edited") and a.get("provenance") == "ai-suggested":
                updated["provenance"] = "human-corrected" if status == "edited" else "ai-suggested"
            row.annotations = [*row.annotations[:i], updated, *row.annotations[i + 1 :]]
            row.revision += 1
            audit.record(db, ctx, "annotations.review", target=annotation_id, before={"review_status": (a.get("attributes") or {}).get("review_status")}, after={"review_status": status})
            return updated
    raise HTTPException(404, "no such annotation")
