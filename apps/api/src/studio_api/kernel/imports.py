"""Import sessions and uploads (todo6 D7, Phase 4.5).

The browser hashes every file (SHA-256) before it asks for a session, so duplicates and
resume cost nothing: a file whose hash and path are already in the project is skipped
("Already in this project"), the same bytes under another path link to the existing asset
(flag `duplicate_of`), and re-sending a session's file list after a reload returns the same
session with what already arrived.

Bytes go one file per request to `PUT /v1/uploads/:session/files/:fileId` (`?offset=` for
chunks). Each chunk is stored as a part under `quarantine/<session>/` in the data BlobStore,
so any replica can take the next one. When a file is complete it is assembled in /tmp,
its size and SHA-256 are verified, and it moves to the content-addressed
`sources/<project>/<sha256><ext>`. `complete` turns uploaded files into assets and source
nodes and emits `source.uploaded`; nodes stay "Checking…" (not viewable) until the worker's
inspection reports on them.
"""

from __future__ import annotations

import hashlib
import os
import posixpath
import tempfile
from collections.abc import AsyncIterator
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from .. import blobstore
from ..config import settings
from ..context import RequestContext
from ..models import Asset, ImportSession, ProjectRow, Source, SourceNode, UploadFile, now
from . import assets, audit, events, projects, tree
from .kinds import is_junk

CHUNK_BYTES = 64 * 1024 * 1024
OPEN_STATES = ("uploading",)
SHA = set("0123456789abcdef")


def _quarantine(session_id: str, file_id: str, offset: int) -> str:
    return f"quarantine/{session_id}/{hashlib.sha256(file_id.encode()).hexdigest()[:24]}.{offset:012d}"


def upload_key(project_id: str, sha256: str, name: str) -> str:
    return f"{assets.UPLOAD_PREFIX}{project_id}/{sha256}{tree.extension(name)}"


def _clean_rel(rel: object) -> str:
    parts = [p for p in str(rel or "").replace("\\", "/").split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts) or any("\x00" in p for p in parts) or len("/".join(parts)) > 2048:
        raise ValueError("bad path")
    return "/".join(parts)


def session_dict(db: Session, s: ImportSession, files: bool = False) -> dict:
    rows = list(db.scalars(select(UploadFile).where(UploadFile.session_id == s.id)))
    counts: dict[str, int] = {}
    for f in rows:
        counts[f.state] = counts.get(f.state, 0) + 1
    out = {
        "id": s.id,
        "projectId": s.project_id,
        "sourceId": s.source_id,
        "targetNodeId": s.target_node_id,
        "state": s.state,
        "totals": {**(s.totals or {}), "files": len(rows), "bytes": sum(f.size for f in rows), "receivedBytes": sum(f.received for f in rows if f.state in ("pending", "uploaded")), "byState": counts},
        "createdBy": s.created_by,
        "attestedBy": s.attested_by,
        "attestedAt": projects.iso(s.attested_at),
        "startedAt": projects.iso(s.started_at),
        "finishedAt": projects.iso(s.finished_at),
        "error": s.error,
    }
    if files:
        order = {"failed": 0, "rejected": 1, "pending": 2, "uploaded": 3, "skipped_duplicate": 4}
        out["files"] = [{"clientFileId": f.client_file_id, "relPath": f.rel_path, "size": f.size, "sha256": f.sha256, "received": f.received, "state": f.state, "reason": f.reason, "uploadUrl": f"/api/v1/uploads/{s.id}/files/{f.client_file_id}" if f.state == "pending" else None} for f in sorted(rows, key=lambda f: (order.get(f.state, 9), tree.natural_key(f.rel_path)))]
    return out


def list_sessions(db: Session, p: ProjectRow) -> list[dict]:
    return [session_dict(db, s) for s in db.scalars(select(ImportSession).where(ImportSession.project_id == p.id).order_by(ImportSession.started_at.desc()))]


def require_session(db: Session, ctx: RequestContext, session_id: str, *, write: bool = False) -> tuple[ImportSession, ProjectRow]:
    s = db.get(ImportSession, session_id)
    if s is None:
        raise HTTPException(404, "no such import")
    return s, projects.require_project(db, ctx, s.project_id, write=write)


def _publish(db: Session, ctx: RequestContext, s: ImportSession) -> None:
    events.publish(db, ctx.for_scope(s.project_id, None), "import.updated", {"projectId": s.project_id, "importId": s.id, "state": s.state}, source="kernel")


def create_session(db: Session, ctx: RequestContext, p: ProjectRow, body: dict) -> dict:
    if ctx.scopes:
        raise HTTPException(403, "only people add data to a project")
    files = body.get("files")
    if not isinstance(files, list) or not files:
        raise HTTPException(422, "files must list at least one file")
    limits = settings()
    if body.get("attested") is not True:
        raise HTTPException(422, "confirm that you may use these files for research and that they're de-identified or synthetic")
    skipped_junk = 0
    wanted: list[tuple[str, str, int, str]] = []
    seen_ids: set[str] = set()
    for i, f in enumerate(files):
        if not isinstance(f, dict):
            raise HTTPException(422, f"files[{i}] must be an object")
        fid = str(f.get("clientFileId") or "")[:128]
        sha = str(f.get("sha256") or "").lower()
        size = f.get("size")
        try:
            rel = _clean_rel(f.get("relPath"))
        except ValueError:
            raise HTTPException(422, f"files[{i}].relPath is not a relative path") from None
        if not fid or fid in seen_ids or len(sha) != 64 or not set(sha) <= SHA or not isinstance(size, int) or size < 0:
            raise HTTPException(422, f"files[{i}] needs a unique clientFileId, a SHA-256 and a size")
        seen_ids.add(fid)
        if is_junk(rel):
            skipped_junk += 1
            continue
        wanted.append((fid, rel, size, sha))
    if len(wanted) > limits.upload_max_session_files:
        raise HTTPException(413, f"Too many files: the limit is {limits.upload_max_session_files:,} per import")

    # Resume: the same file list after a reload (or a dropped connection) gets its session back.
    resumed = _resumable(db, ctx, p, wanted)
    if resumed is not None:
        return session_dict(db, resumed, files=True)

    target = body.get("targetNodeId")
    base = ""
    node = None
    if target:
        node = db.get(SourceNode, str(target))
        if node is None or node.project_id != p.id or not node.is_dir:
            raise HTTPException(422, "targetNodeId must be a folder of this project")
        base = node.rel_path
    title = _title_of([w[1] for w in wanted], body.get("title"))
    tops = {w[1].split("/", 1)[0] for w in wanted}
    if node is None and len(tops) == 1 and all("/" in w[1] for w in wanted):
        # A dropped folder is the source's root: its files are relative to it.
        wanted = [(fid, rel.split("/", 1)[1], size, sha) for fid, rel, size, sha in wanted]

    # (source, path inside it, sha) of every file already in the project.
    existing: dict[tuple[str, str], str] = {}
    for n in db.scalars(select(SourceNode).where(SourceNode.project_id == p.id, SourceNode.is_dir.is_(False), SourceNode.sha256.in_(list({w[3] for w in wanted})))):
        existing.setdefault((n.rel_path, n.sha256 or ""), n.source_id)
    known = _known_hashes(db, p, [w[3] for w in wanted])
    plan = []
    for fid, rel, size, sha in wanted:
        full = posixpath.join(base, rel) if base else rel
        state, reason = "pending", None
        if size > limits.upload_max_file_bytes:
            state, reason = "rejected", f"Too large: the limit is {_human(limits.upload_max_file_bytes)} per file"
        elif (full, sha) in existing:
            state, reason = "skipped_duplicate", "Already in this project"
        elif sha in known:
            # The same bytes are already here under another name: no upload, linked on completion.
            state, reason = "uploaded", f"Same file as {known[sha]}"
        plan.append((fid, rel, size, sha, state, reason))

    if node is not None:
        source = db.get(Source, node.source_id)
        assert source is not None
    elif plan and all(x[4] == "skipped_duplicate" for x in plan):
        # A re-drop of something already here adds nothing: no new source.
        source = db.get(Source, existing[(plan[0][1], plan[0][3])])  # type: ignore[assignment]
        assert source is not None
    else:
        source = Source(id=projects.new_id("src"), project_id=p.id, title=title, kind="upload", created_by=projects.person(ctx), status="uploading")
        source.root_node_id = tree.node_id(source.id, "")
        db.add(source)
        db.flush()
        db.add(SourceNode(id=source.root_node_id, source_id=source.id, project_id=p.id, parent_id=None, name=title, rel_path="", is_dir=True, facts={}, flags={}))
    s = ImportSession(id=projects.new_id("imp"), project_id=p.id, source_id=source.id, target_node_id=str(target) if target else None, state="uploading", totals={"skippedSystemFiles": skipped_junk, "base": base}, created_by=projects.person(ctx), attested_by=projects.person(ctx), attested_at=now())
    db.add(s)
    db.flush()
    for fid, rel, size, sha, state, reason in plan:
        db.add(UploadFile(session_id=s.id, client_file_id=fid, rel_path=rel, size=size, sha256=sha, received=size if state == "uploaded" else 0, state=state, reason=reason))
    db.flush()
    audit.record(db, ctx.for_scope(p.id, None), "import.started", target=s.id, after={"files": len(wanted), "skippedSystemFiles": skipped_junk, "attested": True})
    _publish(db, ctx, s)
    return session_dict(db, s, files=True)


def _human(n: int) -> str:
    for unit in ("bytes", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:g} {unit}" if unit == "bytes" else f"{n:.0f} {unit}"
        n //= 1024
    return str(n)


def _title_of(paths: list[str], asked) -> str:
    if isinstance(asked, str) and asked.strip():
        return asked.strip()[:256]
    tops = {p.split("/", 1)[0] for p in paths}
    if len(tops) == 1 and all("/" in p for p in paths):
        return tops.pop()
    return f"Upload {now():%b %-d}"


def _known_hashes(db: Session, p: ProjectRow, shas: list[str]) -> dict[str, str]:
    """sha256 → the name of a file in this project with those bytes."""
    out: dict[str, str] = {}
    uniq = list(set(shas))
    for i in range(0, len(uniq), 500):
        for n in db.scalars(select(SourceNode).where(SourceNode.project_id == p.id, SourceNode.sha256.in_(uniq[i : i + 500]), SourceNode.asset_id.is_not(None))):
            out.setdefault(n.sha256, n.name)  # type: ignore[arg-type]
    return out


def _resumable(db: Session, ctx: RequestContext, p: ProjectRow, wanted: list[tuple[str, str, int, str]]) -> ImportSession | None:
    want = {(rel, sha) for _, rel, _, sha in wanted}
    for s in db.scalars(select(ImportSession).where(ImportSession.project_id == p.id, ImportSession.state.in_(OPEN_STATES), ImportSession.created_by == projects.person(ctx)).order_by(ImportSession.started_at.desc()).limit(5)):
        rows = list(db.scalars(select(UploadFile).where(UploadFile.session_id == s.id)))
        have = {(f.rel_path, f.sha256) for f in rows}
        # The client may have stripped the dropped folder's name (the source root) or not.
        stripped = {(rel.split("/", 1)[1] if "/" in rel else rel, sha) for rel, sha in want}
        if have and (have == want or have == stripped):
            # Same file ids as this attempt, so the browser's new ids map onto the old rows.
            by_key = {(rel, sha): fid for fid, rel, _, sha in wanted}
            by_key |= {((rel.split("/", 1)[1] if "/" in rel else rel), sha): fid for fid, rel, _, sha in wanted}
            for f in rows:
                new_fid = by_key.get((f.rel_path, f.sha256))
                if new_fid and new_fid != f.client_file_id:
                    db.execute(update(UploadFile).where(UploadFile.session_id == s.id, UploadFile.client_file_id == f.client_file_id).values(client_file_id=new_fid))
            db.expire_all()
            return s
    return None


async def receive(db: Session, ctx: RequestContext, session_id: str, file_id: str, offset: int, chunks: AsyncIterator[bytes]) -> dict:
    """One file, or one chunk of it (`offset` > 0 continues). Returns the file's state."""
    s, p = require_session(db, ctx, session_id, write=True)
    if ctx.scopes:
        raise HTTPException(403, "only people add data to a project")
    if s.state not in OPEN_STATES:
        raise HTTPException(409, f"this import is {s.state}")
    f = db.get(UploadFile, (s.id, file_id))
    if f is None:
        raise HTTPException(404, "no such file in this import")
    if f.state != "pending":
        return {"clientFileId": f.client_file_id, "state": f.state, "received": f.received, "reason": f.reason}
    if offset != f.received:
        raise HTTPException(409, f"expected offset {f.received}")
    store = blobstore.data()
    tmp = tempfile.NamedTemporaryFile(delete=False, dir=None)
    n = 0
    try:
        with tmp:
            async for chunk in chunks:
                n += len(chunk)
                if offset + n > f.size or n > CHUNK_BYTES:
                    raise HTTPException(413, "more bytes than the file's declared size" if offset + n > f.size else "chunks are at most 64 MB")
                tmp.write(chunk)
        if n == 0 and f.size > 0:
            raise HTTPException(422, "empty chunk")
        _put_file(store, _quarantine(s.id, f.client_file_id, offset), tmp.name)
    finally:
        os.unlink(tmp.name)
    f.received = offset + n
    if f.received == f.size:
        _assemble(db, s, p, f)
    db.flush()
    return {"clientFileId": f.client_file_id, "state": f.state, "received": f.received, "reason": f.reason}


def _put_file(store: blobstore.BlobStore, key: str, path: str) -> None:
    put_file = getattr(store, "put_file", None)
    if put_file is not None:
        put_file(key, path)
    else:
        with open(path, "rb") as fh:
            store.put(key, fh.read())


def _assemble(db: Session, s: ImportSession, p: ProjectRow, f: UploadFile) -> None:
    """Concatenate the parts, verify size and SHA-256, and move the bytes to `sources/`."""
    store = blobstore.data()
    offsets = []
    pos = 0
    while pos < f.size or (f.size == 0 and not offsets):
        offsets.append(pos)
        key = _quarantine(s.id, f.client_file_id, pos)
        info = store.stat(key)
        if info is None:
            f.state, f.reason, f.received = "failed", "The connection dropped. Retry", 0
            return
        pos += info.size
        if info.size == 0:
            break
    h = hashlib.sha256()
    tmp = tempfile.NamedTemporaryFile(delete=False)
    try:
        with tmp:
            for off in offsets:
                for chunk in store.iter_range(_quarantine(s.id, f.client_file_id, off)):
                    h.update(chunk)
                    tmp.write(chunk)
        size = os.path.getsize(tmp.name)
        if size != f.size or h.hexdigest() != f.sha256:
            f.state, f.reason, f.received = "failed", "The file changed or arrived damaged. Retry", 0
        else:
            key = upload_key(p.id, f.sha256, f.rel_path)
            if store.stat(key) is None:
                _put_file(store, key, tmp.name)
            f.state, f.reason = "uploaded", None
    finally:
        os.unlink(tmp.name)
        for off in offsets:
            store.delete(_quarantine(s.id, f.client_file_id, off))


def retry(db: Session, ctx: RequestContext, s: ImportSession, file_ids: list[str] | None = None) -> dict:
    for f in db.scalars(select(UploadFile).where(UploadFile.session_id == s.id, UploadFile.state == "failed")):
        if file_ids is None or f.client_file_id in file_ids:
            f.state, f.reason, f.received = "pending", None, 0
    if s.state not in OPEN_STATES:
        s.state = "uploading"
    db.flush()
    _publish(db, ctx, s)
    return session_dict(db, s, files=True)


def complete(db: Session, ctx: RequestContext, s: ImportSession, p: ProjectRow) -> dict:
    """Uploaded files become assets and source nodes; the worker inspects them next.
    Files still pending or failed stay in the session: partial success is normal."""
    if s.state not in OPEN_STATES:
        return session_dict(db, s, files=True)
    source = db.get(Source, s.source_id)
    assert source is not None
    files = list(db.scalars(select(UploadFile).where(UploadFile.session_id == s.id, UploadFile.state == "uploaded")))
    known = {n.sha256: n for n in db.scalars(select(SourceNode).where(SourceNode.project_id == p.id, SourceNode.sha256.in_([f.sha256 for f in files]), SourceNode.asset_id.is_not(None)))} if files else {}
    specs = []
    for f in files:
        key = upload_key(p.id, f.sha256, f.rel_path)
        asset = db.scalar(select(Asset).where(Asset.workspace_id == p.id, Asset.path == key))
        if asset is None:
            asset = Asset(workspace_id=p.id, path=key, media_type=assets.media_type_of(f.rel_path), size=f.size)
            db.add(asset)
            db.flush()
        flags = {}
        prior = known.get(f.sha256)
        if prior is not None:
            flags["duplicate_of"] = {"nodeId": prior.id, "name": prior.name}
        specs.append(tree.FileSpec(f.rel_path, asset.id, f.sha256, f.size, None, {}, flags))
    root = source.root_node_id or tree.node_id(source.id, "")
    ids = tree.add_files(db, source.id, p.id, root, specs, base=(s.totals or {}).get("base") or "", import_session_id=s.id)
    pending = db.scalar(select(UploadFile.client_file_id).where(UploadFile.session_id == s.id, UploadFile.state.in_(("pending", "failed"))).limit(1))
    s.state = "inspecting" if ids else ("failed" if pending else "ready")
    s.totals = {**(s.totals or {}), "committed": len(ids), "incomplete": bool(pending)}
    if source.status == "uploading":
        source.status = "inspecting" if ids else "ready"
    if not ids:
        s.finished_at = now()
        if pending:
            s.error = "No file finished uploading"
    db.flush()
    scoped = ctx.for_scope(p.id, None)
    audit.record(db, scoped, "import.completed", target=s.id, after={"files": len(ids), "incomplete": bool(pending)})
    if ids:
        events.publish(db, scoped, "source.uploaded", {"projectId": p.id, "importId": s.id, "sourceId": source.id, "nodeIds": ids}, source="kernel", idempotency_key=f"source.uploaded:{s.id}")
    _publish(db, ctx, s)
    return session_dict(db, s, files=True)


def cancel(db: Session, ctx: RequestContext, s: ImportSession) -> dict:
    if s.state in OPEN_STATES:
        s.state, s.finished_at = "cancelled", now()
        for f in db.scalars(select(UploadFile).where(UploadFile.session_id == s.id, UploadFile.state == "pending")):
            f.state, f.reason = "failed", "Cancelled"
        source = db.get(Source, s.source_id)
        if source is not None and source.status == "uploading" and not db.scalar(select(SourceNode.id).where(SourceNode.source_id == source.id, SourceNode.is_dir.is_(False)).limit(1)):
            source.status = "ready"
        db.flush()
        audit.record(db, ctx.for_scope(s.project_id, None), "import.cancelled", target=s.id)
        _publish(db, ctx, s)
    return session_dict(db, s, files=True)


def finish_inspection(db: Session, s: ImportSession, needs_review: bool, at: datetime | None = None) -> None:
    s.state = "needs_review" if needs_review else "ready"
    s.finished_at = at or now()
    source = db.get(Source, s.source_id)
    if source is not None and not db.scalar(select(ImportSession.id).where(ImportSession.source_id == source.id, ImportSession.state.in_(("uploading", "inspecting"))).limit(1)):
        source.status = "ready"
