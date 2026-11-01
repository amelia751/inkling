"""Item lifecycle (todo11 D8, Milestone 3 Slice A): items appear as files register and upgrade
in place as they upload and the worker processes them.

A drop into a Studio is an import session with a `taskId`. Each image in it becomes a
`TaskItem` at once (`registered`, with the node id its file will have and its item id, the
content-addressed path its bytes land at), so the items rail can insert it before a byte has
arrived. When its last chunk lands it is `uploaded` (its asset exists, so the viewer can load
it); the worker then claims it (visible items first: `priority` is the latest on-screen hint),
probes it, stores a ThumbHash, a 256 px WebP thumbnail and a ~1600 px WebP preview through the
BlobStore, and reports each stage. Every transition is an `item.*` event on the project stream:
`{taskId, itemId, nodeId, kind, meta?}` (todo11 §6).

The data boundary holds: none of this is on an agent route (agent_scope), and the events carry
no bytes, only ids, sizes and derivative paths.
"""

from __future__ import annotations

import hashlib
import posixpath
import time
from datetime import timedelta

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from .. import blobstore
from ..context import RequestContext
from ..models import Asset, ImportSession, SourceNode, TaskItem, TaskRow, UploadFile, now
from . import assets, events, tree

STATES = ("registered", "uploaded", "probed", "thumb_ready", "preview_ready", "ready", "failed")
EVENTS = tuple(f"item.{s}" for s in STATES)
# What the worker may report, in order; `failed` from any stage.
STAGES = ("probed", "thumb_ready", "preview_ready", "ready", "failed")
CLAIMABLE = ("uploaded", "probed", "thumb_ready", "preview_ready")
# Slice A: images. Other kinds still upload into Files; their items come in later slices.
ITEM_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"}
META_KEYS = {"width", "height", "format", "thumb", "thumbhash", "preview", "error", "reason", "ms"}
DERIVED = {"thumb-webp": "image/webp", "preview-webp": "image/webp"}
MAX_DERIVED = 32 * 1024 * 1024
LEASE_S = 120
MAX_ATTEMPTS = 3
PAGE = 200


def is_item(rel_path: str) -> bool:
    return tree.extension(posixpath.basename(rel_path)) in ITEM_EXT


def _ms() -> int:
    return int(time.time() * 1000)


def _publish(db: Session, ti: TaskItem, state: str, meta: dict | None = None) -> None:
    ctx = RequestContext(ti.project_id, "kernel:ingest", "", task_id=ti.task_id)
    payload: dict = {"taskId": ti.task_id, "itemId": ti.item_id, "nodeId": ti.node_id, "kind": ti.kind}
    payload["meta"] = {**(meta or {}), "at": _ms()}
    events.publish(db, ctx, f"item.{state}", payload, source="kernel")


def entry(ti: TaskItem) -> dict:
    """The item as a task document asset (packages/contracts `SeedAsset` + `ingest`)."""
    meta = ti.meta or {}
    out: dict = {"path": ti.item_id, "sha256": ti.sha256, "bytes": ti.size, "name": ti.name, "nodeId": ti.node_id}
    for k in ("width", "height"):
        if meta.get(k):
            out[k] = meta[k]
    out["ingest"] = {"state": ti.state, "seq": ti.id, **{k: meta[k] for k in ("thumb", "thumbhash", "preview", "error") if meta.get(k)}}
    return out


def task_items(db: Session, task_id: str) -> list[TaskItem]:
    """The task's ingesting items, oldest first, without privacy holds."""
    rows = list(db.scalars(select(TaskItem).where(TaskItem.task_id == task_id).order_by(TaskItem.id)))
    held: set[str] = set()
    ids = [r.node_id for r in rows]
    for i in range(0, len(ids), 500):
        for n in db.scalars(select(SourceNode).where(SourceNode.id.in_(ids[i : i + 500]))):
            p = (n.flags or {}).get("privacy") or {}
            if (p and not p.get("clearedBy")) or n.trashed_at is not None:
                held.add(n.id)
    return [r for r in rows if r.node_id not in held and (r.meta or {}).get("reason") != "privacy"]


# ---- Registration and upload ----------------------------------------------------------------


def require_task_for_drop(db: Session, p_id: str, task_id: object) -> TaskRow:
    t = db.get(TaskRow, str(task_id)) if isinstance(task_id, str) else None
    if t is None or t.project_id != p_id:
        raise HTTPException(422, "taskId must be a task of this project")
    return t


def register(db: Session, s: ImportSession, t: TaskRow) -> list[dict]:
    """Make a `registered` item for each image of the session (idempotent per task and item id):
    called once the session's files exist. Returns the items as document assets."""
    from .imports import upload_key

    files = sorted(db.scalars(select(UploadFile).where(UploadFile.session_id == s.id)), key=lambda f: tree.natural_key(f.rel_path))
    have = {r.item_id for r in db.scalars(select(TaskItem).where(TaskItem.task_id == t.id))}
    # Bytes already in the project (another name, or the same file again): that asset is the item.
    shas = list({f.sha256 for f in files if f.state in ("uploaded", "skipped_duplicate")})
    known: dict[str, tuple[str, str]] = {}
    for i in range(0, len(shas), 500):
        for n in db.scalars(select(SourceNode).where(SourceNode.project_id == s.project_id, SourceNode.sha256.in_(shas[i : i + 500]), SourceNode.asset_id.is_not(None), SourceNode.trashed_at.is_(None))):
            a = db.get(Asset, n.asset_id)
            if a is not None and n.sha256 not in known:
                known[n.sha256] = (a.path, n.id)  # type: ignore[index]
    made: list[TaskItem] = []
    for f in files:
        if f.state in ("rejected", "failed") or not is_item(f.rel_path):
            continue
        prior = known.get(f.sha256) if f.state in ("uploaded", "skipped_duplicate") else None
        item_id = prior[0] if prior else upload_key(s.project_id, f.sha256, f.rel_path)
        if item_id in have:
            continue
        have.add(item_id)
        if f.state == "skipped_duplicate" and prior:
            node_id = prior[1]
        else:
            node_id = f.node_id or tree.new_node_id()
            f.node_id = node_id
        state = "uploaded" if prior else "registered"
        ti = TaskItem(task_id=t.id, project_id=s.project_id, session_id=s.id, client_file_id=f.client_file_id, item_id=item_id, node_id=node_id, name=posixpath.basename(f.rel_path), rel_path=f.rel_path, kind="image", size=f.size, sha256=f.sha256, state=state, meta={}, priority=0, attempts=0)
        db.add(ti)
        made.append(ti)
    db.flush()
    for ti in made:
        _publish(db, ti, "registered", {"name": ti.name, "bytes": ti.size, "seq": ti.id})
        if ti.state == "uploaded":
            _publish(db, ti, "uploaded")
    return [entry(ti) for ti in made]


def uploaded(db: Session, s: ImportSession, f: UploadFile) -> None:
    """A file's last chunk landed and verified: its asset row exists from now on (so a signed
    URL serves it before the import completes), and its item is `uploaded`."""
    ti = db.scalar(select(TaskItem).where(TaskItem.session_id == s.id, TaskItem.client_file_id == f.client_file_id))
    if ti is None or ti.state != "registered":
        return
    if db.scalar(select(Asset.id).where(Asset.workspace_id == s.project_id, Asset.path == ti.item_id)) is None:
        db.add(Asset(workspace_id=s.project_id, path=ti.item_id, media_type=assets.media_type_of(f.rel_path), size=f.size))
    ti.state, ti.updated_at = "uploaded", now()
    db.flush()
    _publish(db, ti, "uploaded")


def upload_failed(db: Session, s: ImportSession, f: UploadFile, reason: str | None) -> None:
    ti = db.scalar(select(TaskItem).where(TaskItem.session_id == s.id, TaskItem.client_file_id == f.client_file_id))
    if ti is None or ti.state != "registered":
        return
    ti.state, ti.meta, ti.updated_at = "failed", {**(ti.meta or {}), "error": (reason or "The upload failed")[:300]}, now()
    db.flush()
    _publish(db, ti, "failed", {"error": ti.meta["error"]})


def retried(db: Session, s: ImportSession, client_file_ids: list[str]) -> None:
    """A retried upload: its failed item is `registered` again (no event: it never left the rail)."""
    for ti in db.scalars(select(TaskItem).where(TaskItem.session_id == s.id, TaskItem.client_file_id.in_(client_file_ids), TaskItem.state == "failed")):
        if (ti.meta or {}).get("reason") != "privacy":
            ti.state, ti.meta = "registered", {k: v for k, v in (ti.meta or {}).items() if k != "error"}


def link_to_dataset(db: Session, s: ImportSession) -> None:
    """On completion the session's item files are nodes: pin them to the task's dataset (one
    write, so parallel uploads never race on the definition)."""
    from ..models import DatasetRow

    t = db.get(TaskRow, (s.totals or {}).get("taskId") or "")
    d = db.get(DatasetRow, t.dataset_id) if t is not None else None
    if d is None:
        return
    definition = dict(d.definition or {})
    files = list(definition.get("files") or [])
    have = {str(r.get("nodeId")) for r in files if isinstance(r, dict)}
    for ti in db.scalars(select(TaskItem).where(TaskItem.session_id == s.id).order_by(TaskItem.id)):
        n = db.get(SourceNode, ti.node_id)
        if n is not None and n.id not in have and n.asset_id:
            files.append({"nodeId": n.id, "assetId": n.asset_id, "version": n.version or 1})
            have.add(n.id)
    definition["files"] = files
    d.definition = definition
    db.flush()


# ---- Reads for the Studio ---------------------------------------------------------------------


def page(assets_: list[dict], after: str | None, limit: int) -> dict:
    """A page of a task's items. The cursor is the count already seen: the list only grows at
    its end while files register (ingesting items come after the dataset's own, in order)."""
    try:
        start = max(0, int(after)) if after else 0
    except ValueError:
        raise HTTPException(422, "after must be a cursor from a previous page") from None
    limit = max(1, min(limit, 1000))
    chunk = assets_[start : start + limit]
    end = start + len(chunk)
    return {"items": chunk, "cursor": str(end), "next": str(end) if end < len(assets_) else None, "total": len(assets_)}


def set_visible(db: Session, t: TaskRow, item_ids: list[str]) -> int:
    """The Studio's on-screen items: workers claim them first (latest hint wins)."""
    ids = [str(i) for i in item_ids[:500] if isinstance(i, str)]
    if not ids:
        return 0
    r = db.execute(update(TaskItem).where(TaskItem.task_id == t.id, TaskItem.item_id.in_(ids), TaskItem.state.in_(("registered", *CLAIMABLE))).values(priority=_ms()))
    return int(getattr(r, "rowcount", 0) or 0)


# ---- The worker -----------------------------------------------------------------------------


def claim(db: Session, limit: int = 4) -> list[dict]:
    """Uploaded items to process, highest priority first, each leased for `LEASE_S`. On
    Postgres rows are locked with SKIP LOCKED, so workers split the queue."""
    at = now()
    q = (
        select(TaskItem)
        .where(TaskItem.state.in_(CLAIMABLE), (TaskItem.lease_until.is_(None)) | (TaskItem.lease_until < at))
        .order_by(TaskItem.priority.desc(), TaskItem.id)
        .limit(max(1, min(limit, 32)))
    )
    if db.get_bind().dialect.name == "postgresql":
        q = q.with_for_update(skip_locked=True)
    out = []
    for ti in db.scalars(q).all():
        if ti.attempts >= MAX_ATTEMPTS:
            ti.state, ti.meta = "failed", {**(ti.meta or {}), "error": "We couldn't process this image"}
            _publish(db, ti, "failed", {"error": ti.meta["error"]})
            continue
        ti.lease_until, ti.attempts = at + timedelta(seconds=LEASE_S), ti.attempts + 1
        out.append({"id": ti.id, "taskId": ti.task_id, "projectId": ti.project_id, "itemId": ti.item_id, "nodeId": ti.node_id, "kind": ti.kind, "name": ti.name, "relPath": ti.rel_path, "size": ti.size, "state": ti.state})
    db.flush()
    return out


def require_item(db: Session, id_: int) -> TaskItem:
    ti = db.get(TaskItem, id_)
    if ti is None:
        raise HTTPException(404, "no such item")
    return ti


def content_key(ti: TaskItem) -> str:
    try:
        key = blobstore.safe_key(ti.item_id)
    except blobstore.BlobNotFound:
        raise HTTPException(404, "the item's bytes are missing") from None
    if assets.store_of(key).stat(key) is None:
        raise HTTPException(404, "the item's bytes are missing")
    return key


def put_derived(db: Session, ti: TaskItem, role: str, data: bytes, media_type: str) -> dict:
    """A thumbnail or preview, content-addressed next to the project's uploads."""
    if role not in DERIVED:
        raise HTTPException(422, f"role is one of {sorted(DERIVED)}")
    if media_type.split(";")[0].strip() != DERIVED[role]:
        raise HTTPException(415, f"{role} must be {DERIVED[role]}")
    if not data or len(data) > MAX_DERIVED:
        raise HTTPException(413, "derived files are 1 byte to 32 MB")
    key = f"{assets.UPLOAD_PREFIX}{ti.project_id}/derived/{hashlib.sha256(data).hexdigest()}.webp"
    store = blobstore.data()
    if store.stat(key) is None:
        store.put(key, data, DERIVED[role])
    if db.scalar(select(Asset.id).where(Asset.workspace_id == ti.project_id, Asset.path == key)) is None:
        db.add(Asset(workspace_id=ti.project_id, path=key, media_type=DERIVED[role], role=role, size=len(data)))
        db.flush()
    return {"path": key}


def report(db: Session, ti: TaskItem, body: dict) -> dict:
    """One or more stages, in order (`stages: [{stage, meta}]`, or one `stage` + `meta`); each
    merges its meta into the item and is one `item.<stage>` event."""
    stages = body.get("stages")
    raw = stages if isinstance(stages, list) else [{"stage": body.get("stage"), "meta": body.get("meta")}]
    for r in raw:
        stage = r.get("stage") if isinstance(r, dict) else None
        if stage not in STAGES:
            raise HTTPException(422, f"stage is one of {list(STAGES)}")
        if ti.state in ("ready", "failed"):
            break
        meta = {k: v for k, v in (r.get("meta") or {}).items() if k in META_KEYS} if isinstance(r.get("meta"), dict) else {}
        for k in ("error", "reason", "format", "thumbhash"):
            if k in meta:
                meta[k] = str(meta[k])[:300]
        for k in ("thumb", "preview"):
            if k in meta and not (isinstance(meta[k], str) and meta[k].startswith(f"{assets.UPLOAD_PREFIX}{ti.project_id}/")):
                raise HTTPException(422, f"{k} must be a path from this project's uploads")
        ti.meta = {**(ti.meta or {}), **meta}
        ti.state, ti.updated_at = stage, now()
        if stage in ("ready", "failed"):
            ti.lease_until = None
        db.flush()
        _publish(db, ti, stage, meta)
    return {"state": ti.state}

