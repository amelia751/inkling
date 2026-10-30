"""Annotation API (docs/plugins.md §6): canonical document, provenance, review state, idempotent commits.

The document is the one the Studio loads and saves (`AnnotationDocument` in
packages/plugin-contracts/src/types). Plugin output reaches it only through `commit`, which
is idempotent per key, so re-running a job never duplicates annotations (§14 #7).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..context import RequestContext
from ..models import AnnotationCommit, AnnotationDocumentRow
from ..naming import canonical_id
from . import audit

ANNOTATIONS_VERSION = 2
PROVENANCE = {"human-created", "ai-suggested", "human-corrected"}
REVIEW_STATES = {"pending", "accepted", "rejected", "edited"}

# ---- v1 → v2 migration (port of packages/plugin-contracts/src/migrations/annotations-v1-to-v2.ts)

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
    row = db.get(AnnotationDocumentRow, ctx.workspace_id)
    if row is None:
        row = AnnotationDocumentRow(workspace_id=ctx.workspace_id, revision=0, annotations=[])
        db.add(row)
        db.flush()
    return row


def _canonical(a: dict) -> dict:
    g = a.get("geometry") or {}
    t = g.get("type")
    return {**a, "geometry": {**g, "type": canonical_id(t)}} if isinstance(t, str) and canonical_id(t) != t else a


def get_document(db: Session, ctx: RequestContext) -> dict:
    row = db.get(AnnotationDocumentRow, ctx.workspace_id)
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


def put_document(db: Session, ctx: RequestContext, doc: dict) -> dict:
    """Save the whole document (the Studio's autosave). Bumps the revision, like the dev seed server."""
    if not isinstance(doc, dict) or not isinstance(doc.get("annotations"), list):
        raise HTTPException(400, "invalid annotation document")
    row = _row(db, ctx)
    row.annotations = [_canonical(a) for a in doc["annotations"]]
    row.annotations_version = doc.get("annotationsVersion")
    row.revision = int(doc.get("revision") or 0) + 1
    row.saved_at = datetime.now(UTC)
    return get_document(db, ctx)


def commit(db: Session, ctx: RequestContext, annotations: list[dict], *, idempotency_key: str | None, job_id: str | None = None, source: str) -> list[str]:
    """Append (or replace by id) canonical annotations as one revision. Idempotent per key."""
    if idempotency_key:
        prior = db.scalar(select(AnnotationCommit).where(AnnotationCommit.workspace_id == ctx.workspace_id, AnnotationCommit.idempotency_key == idempotency_key))
        if prior is not None:
            return list(prior.annotation_ids)
    checked = [_canonical(validate_annotation(a)) for a in annotations]
    row = _row(db, ctx)
    ids = {a["id"] for a in checked}
    row.annotations = [a for a in row.annotations if a.get("id") not in ids] + checked
    row.revision += 1
    row.annotations_version = row.annotations_version or ANNOTATIONS_VERSION
    row.saved_at = datetime.now(UTC)
    db.add(AnnotationCommit(workspace_id=ctx.workspace_id, idempotency_key=idempotency_key or uuid.uuid4().hex, job_id=job_id, annotation_ids=[a["id"] for a in checked]))
    audit.record(db, ctx, "annotations.commit", target=source, after={"ids": [a["id"] for a in checked], "jobId": job_id, "revision": row.revision})
    db.flush()
    return [a["id"] for a in checked]


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
