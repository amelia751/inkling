"""Derivatives (todo18 D4): the kernel side of video → MP4 and slide → DZI.

Inspection reports `facts.derivative = {kind}` for files the browser can't show; `request`
records a pending row. The worker claims rows (`claim`, leased), reports `progress`, uploads
files through the BlobStore and calls `complete` or `fail`. A failed attempt is retried until
`max_attempts`, then the row stays `failed` with the reason (e.g. the codec ffmpeg couldn't
decode). `state_for` gives the item's ingest view (`processing` + progress / ready / failed);
`derived_keys` lists blob keys for the purge worker.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..models import Derivative, SourceNode

KINDS = ("video-mp4", "slide-dzi")
LEASE_S = 15 * 60
DEFAULT_MAX_ATTEMPTS = 3
LABEL = {"video-mp4": "Converting video", "slide-dzi": "Preparing slide"}


def _now() -> datetime:
    return datetime.now(UTC)


def request(db: Session, node: SourceNode, kind: str) -> Derivative | None:
    """One row per (node, kind); asking again is a no-op."""
    if kind not in KINDS:
        return None
    row = db.scalar(select(Derivative).where(Derivative.source_node_id == node.id, Derivative.kind == kind))
    if row is None:
        row = Derivative(project_id=node.project_id, source_node_id=node.id, kind=kind)
        db.add(row)
        db.flush()
    return row


def claim(db: Session, limit: int = 1, max_attempts: int = DEFAULT_MAX_ATTEMPTS) -> list[Derivative]:
    now = _now()
    rows = db.scalars(
        select(Derivative)
        .where(Derivative.attempts < max_attempts)
        .where(or_(Derivative.state == "pending", (Derivative.state == "processing") & (Derivative.lease_until < now)))
        .order_by(Derivative.created_at)
        .limit(limit)
    ).all()
    for r in rows:
        r.state, r.attempts, r.progress, r.lease_until = "processing", r.attempts + 1, 0, now + timedelta(seconds=LEASE_S)
    db.flush()
    return list(rows)


def progress(db: Session, row: Derivative, pct: int) -> None:
    row.progress = max(0, min(99, int(pct)))
    row.lease_until = _now() + timedelta(seconds=LEASE_S)
    db.flush()


def complete(db: Session, row: Derivative, *, sha: str, key: str, keys: list[str], meta: dict | None = None) -> None:
    row.state, row.progress, row.sha, row.blob_key, row.blob_keys = "ready", 100, sha, key, list(keys)
    row.meta, row.error, row.lease_until = meta or {}, None, None
    db.flush()


def fail(db: Session, row: Derivative, reason: str, *, retry: bool, max_attempts: int = DEFAULT_MAX_ATTEMPTS) -> None:
    row.error = reason[:500]
    row.lease_until = None
    row.state = "pending" if retry and row.attempts < max_attempts else "failed"
    db.flush()


def state_for(db: Session, node_ids: list[str]) -> dict[str, dict]:
    """node id → {kind, state, progress, label, error?, key?, meta?} for the item / Studio."""
    out: dict[str, dict] = {}
    if not node_ids:
        return out
    for r in db.scalars(select(Derivative).where(Derivative.source_node_id.in_(node_ids))):
        state = "ready" if r.state == "ready" else "failed" if r.state == "failed" else "processing"
        v: dict = {"kind": r.kind, "state": state, "progress": r.progress, "label": LABEL.get(r.kind, "Preparing")}
        if r.error and state == "failed":
            v["error"] = r.error
        if state == "ready":
            v["key"], v["meta"] = r.blob_key, r.meta or {}
        out[r.source_node_id] = v
    return out


def derived_keys(db: Session, node_ids: list[str]) -> list[str]:
    """Every blob key derived from these nodes, for the purge worker (todo18 W8)."""
    if not node_ids:
        return []
    keys: list[str] = []
    for r in db.scalars(select(Derivative).where(Derivative.source_node_id.in_(node_ids))):
        keys.extend(r.blob_keys or ([r.blob_key] if r.blob_key else []))
    return list(dict.fromkeys(keys))


# ---- Worker API helpers ------------------------------------------------------------------------

MAX_FILE_BYTES = 256 << 20


def get(db: Session, did: str) -> Derivative:
    from fastapi import HTTPException

    row = db.get(Derivative, did)
    if row is None:
        raise HTTPException(404, "no such derivative")
    return row


def public(row: Derivative) -> dict:
    return {"id": row.id, "projectId": row.project_id, "nodeId": row.source_node_id, "kind": row.kind, "state": row.state, "attempts": row.attempts, "progress": row.progress}


def put_file(db: Session, row: Derivative, rel: str, data: bytes, media_type: str) -> str:
    """Store one derivative file at `uploads/<project>/derived/<rel>` (content-hash keyed by the worker)."""
    from fastapi import HTTPException

    from .. import blobstore
    from . import assets

    if not rel.startswith(("derived/",)) or ".." in rel.split("/") or len(data) > MAX_FILE_BYTES:
        raise HTTPException(422, "derivative files are derived/<sha>… and at most 256 MB")
    key = f"{assets.UPLOAD_PREFIX}{row.project_id}/{rel}"
    store = blobstore.data()
    if store.stat(key) is None:
        store.put(key, data, media_type or "application/octet-stream")
    return key
