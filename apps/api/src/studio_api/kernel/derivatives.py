"""Derivatives (todo18 D4): the kernel side of video → MP4 and slide → DZI.

Inspection reports `facts.derivative = {kind}` for files the browser can't show; `request`
records a pending row. The worker claims rows (`claim`, leased), reports `progress`, uploads
files through the BlobStore and calls `complete` or `fail`. A failed attempt is retried until
`max_attempts`, then the row stays `failed` with the reason (e.g. the codec ffmpeg couldn't
decode). `state_for` gives the item's ingest view (`processing` + progress / ready / failed / waiting);
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
# The converter each kind needs (todo19 D10): a worker serves a kind when it reports any of these.
NEEDS = {"video-mp4": ("ffmpeg",), "slide-dzi": ("openslide",)}
CONVERTER = {"video-mp4": "ffmpeg", "slide-dzi": "OpenSlide"}


def _now() -> datetime:
    return datetime.now(UTC)


def request(db: Session, node: SourceNode, kind: str) -> Derivative | None:
    """One row per (node, kind); asking again is a no-op. Bytes already converted (the same file
    dropped into another project) reuse that conversion instead of converting again."""
    if kind not in KINDS:
        return None
    row = db.scalar(select(Derivative).where(Derivative.source_node_id == node.id, Derivative.kind == kind))
    if row is None:
        row = Derivative(project_id=node.project_id, source_node_id=node.id, kind=kind)
        db.add(row)
        if (done := _converted(db, node, kind)) is not None:
            _reuse(db, row, done)
        db.flush()
    return row


def _converted(db: Session, node: SourceNode, kind: str) -> Derivative | None:
    from ..models import INCLUDE_TRASHED

    if not getattr(node, "sha256", None):
        return None
    # A project in Trash still has its files until it's purged (which then leaves them for this one).
    return db.scalar(
        select(Derivative)
        .join(SourceNode, SourceNode.id == Derivative.source_node_id)
        .where(Derivative.kind == kind, Derivative.state == "ready", Derivative.blob_key.is_not(None), SourceNode.sha256 == node.sha256)
        .order_by(Derivative.created_at)
        .limit(1)
        .execution_options(**INCLUDE_TRASHED)
    )


def _reuse(db: Session, row: Derivative, done: Derivative) -> None:
    from ..models import Asset

    complete(db, row, sha=done.sha or "", key=done.blob_key or "", keys=list(done.blob_keys or []), meta=dict(done.meta or {}))
    row.attempts = 0
    # The viewable files become Assets of this project too, so its signed URLs reach them.
    for a in db.scalars(select(Asset).where(Asset.workspace_id == done.project_id, Asset.path.in_([k for k in (done.blob_keys or [done.blob_key]) if k and "_files/" not in k]))):
        if db.scalar(select(Asset.id).where(Asset.workspace_id == row.project_id, Asset.path == a.path)) is None:
            db.add(Asset(workspace_id=row.project_id, path=a.path, media_type=a.media_type, role=a.role, size=a.size))


def _in_trash(db: Session, row: Derivative) -> bool:
    from ..models import INCLUDE_TRASHED, ProjectRow

    p = db.get(ProjectRow, row.project_id, execution_options=INCLUDE_TRASHED)
    n = db.get(SourceNode, row.source_node_id, execution_options=INCLUDE_TRASHED)
    return (p is not None and p.trashed_at is not None) or (n is not None and n.trashed_at is not None)


def claim(db: Session, limit: int = 1, max_attempts: int = DEFAULT_MAX_ATTEMPTS, kinds: list[str] | None = None) -> list[Derivative]:
    """Lease pending rows; `kinds` (what the claiming worker can convert) routes jobs only to a
    worker that can serve them (todo19 D10). `None` is an older worker: every kind. Rows of a
    project or file in Trash wait there: restoring it converts them."""
    from ..models import INCLUDE_TRASHED, ProjectRow

    now = _now()
    q = (
        select(Derivative)
        .outerjoin(ProjectRow, ProjectRow.id == Derivative.project_id)
        .outerjoin(SourceNode, SourceNode.id == Derivative.source_node_id)
        .where(Derivative.attempts < max_attempts, ProjectRow.trashed_at.is_(None), SourceNode.trashed_at.is_(None))
        .execution_options(**INCLUDE_TRASHED)
    )
    if kinds is not None:
        q = q.where(Derivative.kind.in_(list(kinds) or ["-"]))
    rows = db.scalars(
        q
        .where(or_(Derivative.state == "pending", (Derivative.state == "processing") & (Derivative.lease_until < now)))
        .order_by(Derivative.created_at)
        .limit(limit)
    ).all()
    for r in rows:
        r.state, r.attempts, r.progress, r.lease_until = "processing", r.attempts + 1, 0, now + timedelta(seconds=LEASE_S)
    db.flush()
    return list(rows)


def stop_if_trashed(db: Session, row: Derivative) -> None:
    """A conversion whose project or file went to Trash stops (409; the worker drops it) and goes
    back to pending without spending the attempt, so a restore converts it again."""
    from fastapi import HTTPException

    if row.state in ("pending", "processing") and _in_trash(db, row):
        if row.state == "processing":
            row.state, row.progress, row.lease_until = "pending", 0, None
            row.attempts = max(0, row.attempts - 1)
            db.commit()
        raise HTTPException(409, "the file is in Trash")


def progress(db: Session, row: Derivative, pct: int) -> None:
    row.progress = max(0, min(99, int(pct)))
    row.lease_until = _now() + timedelta(seconds=LEASE_S)
    db.flush()


def complete(db: Session, row: Derivative, *, sha: str, key: str, keys: list[str], meta: dict | None = None) -> None:
    row.state, row.progress, row.sha, row.blob_key, row.blob_keys = "ready", 100, sha, key, list(keys)
    row.meta, row.error, row.lease_until = meta or {}, None, None
    db.flush()


def fail(db: Session, row: Derivative, reason: str, *, retry: bool, max_attempts: int = DEFAULT_MAX_ATTEMPTS, unavailable: bool = False) -> None:
    """`unavailable` (todo19 P0-2): the worker lacks the converter. Not the file's fault, so the row
    `waiting`s ("Waiting for a converter: OpenSlide") without spending an attempt, and a worker that
    reports the capability re-queues it (`capabilities.report`)."""
    row.lease_until = None
    if unavailable:
        row.state, row.error = "waiting", f"Waiting for a converter: {CONVERTER.get(row.kind, 'a converter')}"
        row.attempts = max(0, row.attempts - 1)
        row.progress = 0
        db.flush()
        return
    row.error = reason[:500]
    row.state = "pending" if retry and row.attempts < max_attempts else "failed"
    db.flush()


def state_for(db: Session, node_ids: list[str]) -> dict[str, dict]:
    """node id → {kind, state, progress, label, error?, key?, meta?} for the item / Studio."""
    out: dict[str, dict] = {}
    if not node_ids:
        return out
    for r in db.scalars(select(Derivative).where(Derivative.source_node_id.in_(node_ids))):
        state = r.state if r.state in ("ready", "failed", "waiting") else "processing"
        v: dict = {"kind": r.kind, "state": state, "progress": r.progress, "label": LABEL.get(r.kind, "Preparing")}
        if r.error and state in ("failed", "waiting"):
            v["error"] = r.error
        if state == "ready":
            v["key"], v["meta"] = r.blob_key, r.meta or {}
        out[r.source_node_id] = v
    return out


def annotate(db: Session, items: list[dict]) -> None:
    """Add `derivative` ({kind, state, progress, label, error?, src?}) to task-document items;
    a ready slide also gets `mpp` and its size from the slide header."""
    states = state_for(db, [i["nodeId"] for i in items if i.get("nodeId")])
    for it in items:
        s = states.get(it.get("nodeId") or "")
        if not s:
            continue
        v = {k: s[k] for k in ("kind", "state", "progress", "label", "error") if k in s}
        if s["state"] == "ready":
            v["src"] = s["key"]
            meta = s.get("meta") or {}
            for k in ("mpp", "width", "height"):
                if meta.get(k) is not None:
                    it[k] = meta[k]
        it["derivative"] = v


def derived_keys(db: Session, node_ids: list[str]) -> list[str]:
    """Every blob key derived from these nodes, for the purge worker (todo18 W8); a conversion
    another file reuses (same bytes, `request`) is left for it."""
    if not node_ids:
        return []
    keys: list[str] = []
    for r in db.scalars(select(Derivative).where(Derivative.source_node_id.in_(node_ids))):
        if r.blob_key and db.scalar(select(Derivative.id).where(Derivative.blob_key == r.blob_key, Derivative.source_node_id.not_in(node_ids)).limit(1)):
            continue
        keys.extend(r.blob_keys or ([r.blob_key] if r.blob_key else []))
    return list(dict.fromkeys(keys))


# ---- Worker API helpers ------------------------------------------------------------------------

def get(db: Session, did: str) -> Derivative:
    from fastapi import HTTPException

    row = db.get(Derivative, did)
    if row is None:
        raise HTTPException(404, "no such derivative")
    return row


def public(row: Derivative) -> dict:
    return {"id": row.id, "projectId": row.project_id, "nodeId": row.source_node_id, "kind": row.kind, "state": row.state, "attempts": row.attempts, "progress": row.progress}


def file_key(row: Derivative, rel: str) -> str:
    """`uploads/<project>/derived/<rel>`; the worker names files by the source's content hash."""
    from fastapi import HTTPException

    from . import assets

    parts = rel.split("/")
    if not rel.startswith("derived/") or ".." in parts or "" in parts:
        raise HTTPException(422, "derivative files are derived/<sha>…")
    return f"{assets.UPLOAD_PREFIX}{row.project_id}/{rel}"


def part_key(key: str, offset: int) -> str:
    return f"{key}.part.{offset:012d}"


def join_parts(store, key: str, total: int, media_type: str) -> None:
    """A file sent in pieces (`?offset=&total=`): the pieces, in order, become `key`."""
    import os
    import tempfile

    from fastapi import HTTPException

    offsets, pos = [], 0
    while pos < total:
        info = store.stat(part_key(key, pos))
        if info is None or info.size == 0:
            raise HTTPException(422, f"no piece at offset {pos}; send the file again from offset 0")
        offsets.append(pos)
        pos += info.size
    if pos != total:
        raise HTTPException(422, f"the pieces add up to {pos} bytes, not {total}")
    tmp = tempfile.NamedTemporaryFile(prefix="derive-", delete=False)
    try:
        with tmp:
            for off in offsets:
                for chunk in store.iter_range(part_key(key, off)):
                    tmp.write(chunk)
        store.put_file(key, tmp.name, media_type)
    finally:
        os.unlink(tmp.name)
    for off in offsets:
        store.delete(part_key(key, off))


def register_file(db: Session, row: Derivative, key: str, media_type: str, size: int) -> None:
    """The viewable file (.mp4, .dzi, thumbnail) is an Asset of the project so `assetUrl` signs it;
    DZI tiles are served as companions of their `.dzi` asset."""
    from ..models import Asset

    if key.endswith(("_files",)) or "_files/" in key:
        return
    if db.scalar(select(Asset.id).where(Asset.workspace_id == row.project_id, Asset.path == key)) is None:
        db.add(Asset(workspace_id=row.project_id, path=key, media_type=media_type, role="derivative", size=size))
        db.flush()
