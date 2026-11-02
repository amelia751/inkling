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
`sources/<project>/<sha256><ext>`. `complete` turns uploaded files into assets and nodes
and emits `source.uploaded`; nodes stay "Checking…" (not viewable) until the worker's
inspection reports on them.

todo7: an import lands in a folder of the project's drive (D1): the folder dropped on, or a
new top-level folder named after the dropped folder. New nodes get opaque ids, recorded in
`upload_files.node_id`, so completing twice finds them (D3). A session in `replace` mode
(`POST /v1/source-nodes/:id/versions`) adds a version to one file instead (D6).
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import posixpath
import tempfile
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from .. import blobstore
from ..config import settings
from ..context import RequestContext
from ..models import Asset, ImportSession, ProjectRow, Source, SourceNode, TaskItem, UploadFile, now
from . import assets, audit, drops, events, fs, ingest, projects, tree
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
        "dropId": s.drop_id,
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


def create_session(db: Session, ctx: RequestContext, p: ProjectRow, body: dict, *, internal: bool = False, session_id: str | None = None, check: Callable[[list[str]], Any] | None = None, forbidden: str = "") -> dict:
    """`internal`: the kernel's own fetch or copy (todo16 D10, `url_imports`), which may run
    for the assistant's delegated token; the bytes never pass through the caller.

    todo17: `forbidden` characters in a path become `_` (an info finding each), and `check`
    runs the layout rules on the paths the files will land at (raising rejects the import;
    rules in evaluate mode only report). Its findings come back as `findings`."""
    if ctx.scopes and not internal:
        raise HTTPException(403, "only people add data to a project")
    files = body.get("files")
    if not isinstance(files, list) or not files:
        raise HTTPException(422, "files must list at least one file")
    limits = settings()
    if body.get("attested") is not True:
        raise HTTPException(422, "confirm that you may use these files for research and that they're de-identified or synthetic")
    skipped_junk = 0
    renamed: list[dict] = []
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
        fixed = "".join("_" if c in forbidden and c != "/" else c for c in rel) if forbidden else rel
        if fixed != rel:
            renamed.append({"rule": "layout.forbidden-char", "severity": "info", "path": f"/files/{i}/relPath", "message": "Characters the project rules forbid were replaced with '_'.", "fix": "", "docs": "/docs/lint-rules#layout.forbidden-char"})
        wanted.append((fid, fixed, size, sha))
    if len(wanted) > limits.upload_max_session_files:
        raise HTTPException(413, f"Too many files: the limit is {limits.upload_max_session_files:,} per import")

    # todo13: a drop (chat, Home, Studio canvas) groups the sessions of one gesture; a chat
    # drop lands in `Shared in chat/<conversation>`.
    drop = drops.for_import(db, ctx, p, body)
    # Resume: the same file list after a reload (or a dropped connection) gets its session back.
    task = ingest.require_task_for_drop(db, p.id, body["taskId"]) if body.get("taskId") is not None else None
    resumed = _resumable(db, ctx, p, wanted) if session_id is None else None  # a queued fetch keeps its own id
    if resumed is not None and drop is not None and resumed.drop_id not in (None, drop.id):
        resumed = None  # the same files, but another drop: a new session for this one
    if resumed is not None:
        if drop is not None and resumed.drop_id is None:
            drops.session_started(db, ctx, drop, resumed)
        out = session_dict(db, resumed, files=True)
        if task is not None:
            # A resumed drop into a Studio: its items are already there (and on the stream).
            out["items"] = [ingest.entry(ti) for ti in db.scalars(select(TaskItem).where(TaskItem.session_id == resumed.id).order_by(TaskItem.id))]
        return out

    drive = fs.ensure_drive(db, p)
    target = body.get("targetNodeId")
    if drop is not None and not target:
        landing_folder = drops.landing_folder(db, p, drop, forbidden)
        target = landing_folder.id if landing_folder is not None else None
    source_kind = "chat" if drop is not None and drops.shared_in_chat(drop) else "upload"
    node = None
    if target:
        node = db.get(SourceNode, str(target))
        if node is None or node.project_id != p.id or not node.is_dir:
            raise HTTPException(422, "targetNodeId must be a folder of this project")
        if tree.is_hidden(db, node):
            raise HTTPException(422, "That folder is in the Trash: restore it first")
        if node.locked:
            raise HTTPException(423, fs.LOCKED)
        if node.id == drive.id:
            node = None  # dropped on Files itself: a new top-level folder, as with no target
    title = _title_of([w[1] for w in wanted], body.get("title"))
    tops = {w[1].split("/", 1)[0] for w in wanted}
    one_folder = len(tops) == 1 and all("/" in w[1] for w in wanted)
    if one_folder and (node is None or next(iter(tops)).lower() == node.name.lower()):
        # A dropped folder is the import's folder: its files are relative to it. Dropped onto
        # a folder of the same name (the same folder again, e.g. a re-drop on it), it merges
        # into that folder instead of nesting a copy inside it.
        wanted = [(fid, rel.split("/", 1)[1], size, sha) for fid, rel, size, sha in wanted]
    findings: list[dict] = list(renamed)
    if check is not None:
        base = tree.path_of(db, node) if node is not None else fs.clean_name(title)
        findings += check([f"{base}/{w[1]}" if base else w[1] for w in wanted]).findings_json()

    known = _known_hashes(db, p, [w[3] for w in wanted])
    if node is not None:
        # What is already in the folder dropped on, by path below it (any case).
        here = _paths_below(db, node.id)
        is_dup = lambda rel, sha: here.get(rel.lower()) == sha  # noqa: E731
        existing_source: str | None = None
    else:
        # A new top-level folder: a re-drop of something already here (same path inside its
        # import, same bytes, not in Trash) adds nothing.
        existing: dict[tuple[str, str], str] = {}
        for n in _visible(db, list(db.scalars(select(SourceNode).where(SourceNode.project_id == p.id, SourceNode.is_dir.is_(False), SourceNode.sha256.in_(list({w[3] for w in wanted})))))):
            if n.source_id:
                existing.setdefault((n.original_path, n.sha256 or ""), n.source_id)
        is_dup = lambda rel, sha: (rel, sha) in existing  # noqa: E731
        existing_source = None
    plan = []
    for fid, rel, size, sha in wanted:
        state, reason = "pending", None
        if size > limits.upload_max_file_bytes:
            state, reason = "rejected", f"Too large: the limit is {_human(limits.upload_max_file_bytes)} per file"
        elif is_dup(rel, sha):
            state, reason = "skipped_duplicate", "Already in this project"
            if node is None:
                existing_source = existing[(rel, sha)]
        elif sha in known:
            # The same bytes are already here under another name: no upload, linked on completion.
            state, reason = "uploaded", f"Same file as {known[sha]}"
        plan.append((fid, rel, size, sha, state, reason))

    landing: str | None
    if node is not None:
        source = db.get(Source, node.source_id) if node.source_id else None
        if source is None:
            # A folder made in Files: the import is its own provenance, landing there.
            source = Source(id=projects.new_id("src"), project_id=p.id, title=title, kind=source_kind, created_by=projects.person(ctx), status="uploading", root_node_id=node.id)
            db.add(source)
            db.flush()
        landing = node.id
    elif plan and all(x[4] == "skipped_duplicate" for x in plan) and existing_source:
        # A re-drop of something already here adds nothing: no new source.
        source = db.get(Source, existing_source)  # type: ignore[assignment]
        assert source is not None
        landing = source.root_node_id
    else:
        source = Source(id=projects.new_id("src"), project_id=p.id, title=title, kind=source_kind, created_by=projects.person(ctx), status="uploading")
        source.root_node_id = tree.new_node_id()
        db.add(source)
        db.flush()
        name = tree.free_name(fs.clean_name(title), fs.taken_names(db, drive.id), is_dir=True)
        db.add(SourceNode(**tree._row(id=source.root_node_id, source_id=source.id, project_id=p.id, project_root=drive.id, parent_id=drive.id, name=name, original_path="", is_dir=True, created_at=now())))
        db.flush()
        tree.bump(db, drive.id, 0, 0, children=1)
        landing = source.root_node_id
    # todo13 M4: the uploader sends a big drop's first files as their own session with
    # `origin.priority: "first"`: inspected first, classified without waiting for the rest.
    first = drop is not None and isinstance(body.get("origin"), dict) and body["origin"].get("priority") == "first"
    s = ImportSession(id=(session_id if internal and session_id else projects.new_id("imp")), project_id=p.id, source_id=source.id, target_node_id=str(target) if target else None, state="uploading", totals={"skippedSystemFiles": skipped_junk, "landingNodeId": landing, **({"taskId": task.id} if task is not None else {}), **({"priority": "first"} if first else {})}, created_by=projects.person(ctx), attested_by=projects.person(ctx), attested_at=now())
    db.add(s)
    db.flush()
    for fid, rel, size, sha, state, reason in plan:
        db.add(UploadFile(session_id=s.id, client_file_id=fid, rel_path=rel, size=size, sha256=sha, received=size if state == "uploaded" else 0, state=state, reason=reason))
    db.flush()
    if drop is not None:
        drops.session_started(db, ctx, drop, s)
    audit.record(db, ctx.for_scope(p.id, None), "import.started", target=s.id, after={"files": len(wanted), "skippedSystemFiles": skipped_junk, "attested": True, **({"dropId": drop.id} if drop is not None else {})})
    # Dropped into a Studio (todo11 D8): its images are items from now on, before any byte.
    registered = ingest.register(db, s, task) if task is not None else None
    _publish(db, ctx, s)
    out = session_dict(db, s, files=True)
    if registered is not None:
        out["items"] = registered
    if check is not None or renamed:
        out["findings"] = findings
    return out


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


def _visible(db: Session, nodes: list[SourceNode]) -> list[SourceNode]:
    ch = tree.chains(db, [n.id for n in nodes])
    return [n for n in nodes if not (ch.get(n.id) and ch[n.id].hidden)]


def _paths_below(db: Session, folder_id: str) -> dict[str, str | None]:
    """lowercase path below a folder → sha256, for the files not in Trash."""
    rows = tree.subtree(db, folder_id)
    by_id = {r.id: r for r in rows}
    file_ids = [r.id for r in rows if not r.is_dir]
    sha: dict[str, str | None] = {}
    for i in range(0, len(file_ids), 500):
        sha.update({nid: h for nid, h in db.execute(select(SourceNode.id, SourceNode.sha256).where(SourceNode.id.in_(file_ids[i : i + 500])))})
    out: dict[str, str | None] = {}
    for r in rows:
        if r.is_dir:
            continue
        names = []
        cur = r
        while cur is not None and cur.id != folder_id:
            names.append(cur.name)
            cur = by_id.get(cur.parent_id)
        out["/".join(reversed(names)).lower()] = sha.get(r.id)
    return out


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
        if (s.totals or {}).get("mode") == "replace":
            continue
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
    """One file, or one chunk of it (`offset` > 0 continues). Returns the file's state.

    The bytes are read, stored and (for the last chunk) verified with no transaction open; only
    the final state change touches the database. On SQLite a read transaction held across that
    I/O goes stale as parallel uploads commit, and its write then fails at once with "database
    is locked" (WAL mode doesn't wait for a stale snapshot), which made folder uploads crawl."""
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
    sid, fid, size, sha, rel, pid = s.id, f.client_file_id, f.size, f.sha256, f.rel_path, p.id
    db.rollback()  # no transaction across the I/O below
    store = blobstore.data()
    tmp = tempfile.NamedTemporaryFile(delete=False, dir=None)
    n = 0
    try:
        with tmp:
            async for chunk in chunks:
                n += len(chunk)
                if offset + n > size or n > CHUNK_BYTES:
                    raise HTTPException(413, "more bytes than the file's declared size" if offset + n > size else "chunks are at most 64 MB")
                tmp.write(chunk)
        if n == 0 and size > 0:
            raise HTTPException(422, "empty chunk")
        _put_file(store, _quarantine(sid, fid, offset), tmp.name)
    finally:
        os.unlink(tmp.name)
    outcome = await asyncio.to_thread(_assemble, store, sid, fid, size, sha, upload_key(pid, sha, rel)) if offset + n == size else None
    def finish() -> dict:
        f = db.get(UploadFile, (sid, fid))
        if f is None:
            raise HTTPException(404, "no such file in this import")
        if f.state == "pending" and f.received == offset:  # else a retry of this chunk got there first
            f.received = offset + n
            if outcome is not None:
                f.state, f.reason = outcome[0], outcome[1]
                if outcome[0] != "uploaded":
                    f.received = 0
                s2 = db.get(ImportSession, sid)
                if s2 is not None and (s2.totals or {}).get("taskId"):
                    if outcome[0] == "uploaded":
                        ingest.uploaded(db, s2, f)
                    else:
                        ingest.upload_failed(db, s2, f, outcome[1])
        out = {"clientFileId": f.client_file_id, "state": f.state, "received": f.received, "reason": f.reason}
        db.commit()
        return out

    for attempt in range(6):
        try:
            # Off the event loop: on SQLite a write waiting for the lock would otherwise stall
            # every other request, including the one holding the lock (todo11: the worker
            # reports items while uploads are still arriving).
            return await asyncio.to_thread(finish)
        except OperationalError as e:  # SQLite only: another writer won the race; try again
            db.rollback()
            if attempt == 5 or "locked" not in str(e):
                raise
            await asyncio.sleep(0.05 * (attempt + 1))
    raise AssertionError("unreachable")


def _put_file(store: blobstore.BlobStore, key: str, path: str) -> None:
    put_file = getattr(store, "put_file", None)
    if put_file is not None:
        put_file(key, path)
    else:
        with open(path, "rb") as fh:
            store.put(key, fh.read())


def _assemble(store: blobstore.BlobStore, session_id: str, file_id: str, size: int, sha256: str, key: str) -> tuple[str, str | None]:
    """Concatenate the parts, verify size and SHA-256, and move the bytes to `sources/`.
    Returns the file's new (state, reason); no database access."""
    offsets = []
    pos = 0
    while pos < size or (size == 0 and not offsets):
        offsets.append(pos)
        info = store.stat(_quarantine(session_id, file_id, pos))
        if info is None:
            return "failed", "The connection dropped. Retry"
        pos += info.size
        if info.size == 0:
            break
    h = hashlib.sha256()
    tmp = tempfile.NamedTemporaryFile(delete=False)
    try:
        with tmp:
            for off in offsets:
                for chunk in store.iter_range(_quarantine(session_id, file_id, off)):
                    h.update(chunk)
                    tmp.write(chunk)
        if os.path.getsize(tmp.name) != size or h.hexdigest() != sha256:
            return "failed", "The file changed or arrived damaged. Retry"
        if store.stat(key) is None:
            _put_file(store, key, tmp.name)
        return "uploaded", None
    finally:
        os.unlink(tmp.name)
        for off in offsets:
            store.delete(_quarantine(session_id, file_id, off))


def retry(db: Session, ctx: RequestContext, s: ImportSession, file_ids: list[str] | None = None) -> dict:
    again = []
    for f in db.scalars(select(UploadFile).where(UploadFile.session_id == s.id, UploadFile.state == "failed")):
        if file_ids is None or f.client_file_id in file_ids:
            f.state, f.reason, f.received = "pending", None, 0
            again.append(f.client_file_id)
    if again and (s.totals or {}).get("taskId"):
        ingest.retried(db, s, again)
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
    if (s.totals or {}).get("mode") == "replace":
        return _complete_replace(db, ctx, s, p)
    source = db.get(Source, s.source_id)
    assert source is not None
    files = list(db.scalars(select(UploadFile).where(UploadFile.session_id == s.id, UploadFile.state == "uploaded")))
    known = {n.sha256: n for n in db.scalars(select(SourceNode).where(SourceNode.project_id == p.id, SourceNode.sha256.in_([f.sha256 for f in files]), SourceNode.asset_id.is_not(None)))} if files else {}
    specs = []
    # The first file of this session with given bytes, for duplicates within the session.
    first: dict[str, tuple[str, str, str]] = {}
    for f in sorted(files, key=lambda f: tree.natural_key(f.rel_path)):
        flags = {}
        prior = known.get(f.sha256)
        nid = f.node_id or tree.new_node_id()
        f.node_id = nid
        if prior is not None and prior.asset_id:
            # The same bytes are already in the project: link to that asset (stored once).
            asset_id = prior.asset_id
            flags["duplicate_of"] = {"nodeId": prior.id, "name": prior.name}
        elif f.sha256 in first:
            asset_id, first_id, name = first[f.sha256]
            flags["duplicate_of"] = {"nodeId": first_id, "name": name}
        else:
            asset_id = _asset_for(db, p, f).id
            first[f.sha256] = (asset_id, nid, posixpath.basename(f.rel_path))
        specs.append(tree.FileSpec(f.rel_path, asset_id, f.sha256, f.size, None, {}, flags, id=nid))
    landing = (s.totals or {}).get("landingNodeId") or source.root_node_id
    if landing is None or db.get(SourceNode, landing) is None or tree.is_hidden(db, db.get(SourceNode, landing)):  # type: ignore[arg-type]
        landing = fs.ensure_drive(db, p).id
    ids = tree.add_files(db, p.id, source.id, landing, specs, import_session_id=s.id, created_by=projects.person(ctx))
    pending = db.scalar(select(UploadFile.client_file_id).where(UploadFile.session_id == s.id, UploadFile.state.in_(("pending", "failed"))).limit(1))
    s.state = "inspecting" if ids else ("failed" if pending else "ready")
    s.totals = {**(s.totals or {}), "committed": len(ids), "incomplete": bool(pending), **({"inspectingAt": now().isoformat()} if ids else {})}
    if source.status == "uploading":
        source.status = "inspecting" if ids else "ready"
    if not ids:
        s.finished_at = now()
        if pending:
            s.error = "No file finished uploading"
    db.flush()
    scoped = ctx.for_scope(p.id, None)
    audit.record(db, scoped, "import.completed", target=s.id, after={"files": len(ids), "incomplete": bool(pending)})
    if (s.totals or {}).get("taskId"):
        ingest.link_to_dataset(db, s)
    if ids:
        prio = {"priority": "first"} if (s.totals or {}).get("priority") == "first" else {}
        events.publish(db, scoped, "source.uploaded", {"projectId": p.id, "importId": s.id, "sourceId": source.id, "nodeIds": ids, **prio}, source="kernel", idempotency_key=f"source.uploaded:{s.id}")
        # todo17 D11: imaging checks run in the worker after the upload; they never block it.
        from . import imaging_findings

        imaging_findings.enqueue_check(db, scoped, p, ids, trigger="import", key=f"imaging.check:import:{s.id}")
    if s.drop_id:
        drops.session_completed(db, ctx, s, ids)
    _publish(db, ctx, s)
    return session_dict(db, s, files=True)


def _asset_for(db: Session, p: ProjectRow, f: UploadFile) -> Asset:
    key = upload_key(p.id, f.sha256, f.rel_path)
    asset = db.scalar(select(Asset).where(Asset.workspace_id == p.id, Asset.path == key))
    if asset is None:
        asset = Asset(workspace_id=p.id, path=key, media_type=assets.media_type_of(f.rel_path), size=f.size)
        db.add(asset)
        db.flush()
    return asset


def create_replace_session(db: Session, ctx: RequestContext, p: ProjectRow, n: SourceNode, body: dict) -> dict:
    """`POST /v1/source-nodes/:id/versions`: an import session for one file in `replace`
    mode. Upload as usual, then `complete` adds a version to the node (D6)."""
    if ctx.scopes:
        raise HTTPException(403, "only people add data to a project")
    if n.is_dir:
        raise HTTPException(422, "Only a file can have versions")
    if n.locked:
        raise HTTPException(423, fs.LOCKED)
    if tree.is_hidden(db, n):
        raise HTTPException(422, f"{n.name} is in the Trash: restore it first")
    if body.get("mode", "replace") != "replace":
        raise HTTPException(422, "mode must be replace")
    files = body.get("files")
    if not isinstance(files, list) or len(files) != 1 or not isinstance(files[0], dict):
        raise HTTPException(422, "files must list exactly one file")
    if body.get("attested") is not True:
        raise HTTPException(422, "confirm that you may use these files for research and that they're de-identified or synthetic")
    f = files[0]
    fid = str(f.get("clientFileId") or "")[:128]
    sha = str(f.get("sha256") or "").lower()
    size = f.get("size")
    try:
        rel = posixpath.basename(_clean_rel(f.get("relPath") or n.name))
    except ValueError:
        raise HTTPException(422, "files[0].relPath is not a relative path") from None
    if not fid or len(sha) != 64 or not set(sha) <= SHA or not isinstance(size, int) or size < 0:
        raise HTTPException(422, "files[0] needs a clientFileId, a SHA-256 and a size")
    if sha == n.sha256:
        raise HTTPException(409, "That's the same file as the current version")
    for s in db.scalars(select(ImportSession).where(ImportSession.project_id == p.id, ImportSession.state.in_(OPEN_STATES), ImportSession.target_node_id == n.id, ImportSession.created_by == projects.person(ctx))):
        row = db.scalar(select(UploadFile).where(UploadFile.session_id == s.id))
        if (s.totals or {}).get("mode") == "replace" and row is not None and row.sha256 == sha:
            if row.client_file_id != fid:
                db.execute(update(UploadFile).where(UploadFile.session_id == s.id, UploadFile.client_file_id == row.client_file_id).values(client_file_id=fid))
                db.expire_all()
            return session_dict(db, s, files=True)
    limits = settings()
    state, reason = "pending", None
    known = _known_hashes(db, p, [sha])
    if size > limits.upload_max_file_bytes:
        state, reason = "rejected", f"Too large: the limit is {_human(limits.upload_max_file_bytes)} per file"
    elif sha in known:
        state, reason = "uploaded", f"Same file as {known[sha]}"
    s = ImportSession(id=projects.new_id("imp"), project_id=p.id, source_id=n.source_id or "", target_node_id=n.id, state="uploading", totals={"mode": "replace", "replaceNodeId": n.id}, created_by=projects.person(ctx), attested_by=projects.person(ctx), attested_at=now())
    db.add(s)
    db.flush()
    db.add(UploadFile(session_id=s.id, client_file_id=fid, rel_path=rel, size=size, sha256=sha, received=size if state == "uploaded" else 0, state=state, reason=reason, node_id=n.id))
    db.flush()
    audit.record(db, ctx.for_scope(p.id, None), "import.started", target=s.id, after={"files": 1, "mode": "replace", "attested": True})
    _publish(db, ctx, s)
    return session_dict(db, s, files=True)


def _complete_replace(db: Session, ctx: RequestContext, s: ImportSession, p: ProjectRow) -> dict:
    f = db.scalar(select(UploadFile).where(UploadFile.session_id == s.id))
    n = db.get(SourceNode, (s.totals or {}).get("replaceNodeId") or "")
    scoped = ctx.for_scope(p.id, None)
    if f is None or f.state != "uploaded" or n is None:
        s.state, s.finished_at = "failed", now()
        s.error = "The new version didn't finish uploading" if n is not None else "The file is gone"
        db.flush()
        _publish(db, ctx, s)
        return session_dict(db, s, files=True)
    known = db.scalar(select(SourceNode).where(SourceNode.project_id == p.id, SourceNode.sha256 == f.sha256, SourceNode.asset_id.is_not(None)).limit(1))
    asset_id = known.asset_id if known is not None and known.asset_id else _asset_for(db, p, f).id
    b = fs.replace_with_upload(db, ctx, p, n, asset_id, f.sha256, f.size, s.id)
    s.state = "inspecting"
    s.totals = {**(s.totals or {}), "committed": 1, "incomplete": False, "batchId": b.id, "version": n.version}
    db.flush()
    audit.record(db, scoped, "import.completed", target=s.id, after={"files": 1, "incomplete": False, "mode": "replace"})
    events.publish(db, scoped, "source.uploaded", {"projectId": p.id, "importId": s.id, "sourceId": n.source_id or "", "nodeIds": [n.id]}, source="kernel", idempotency_key=f"source.uploaded:{s.id}")
    _publish(db, ctx, s)
    return session_dict(db, s, files=True)


def cancel(db: Session, ctx: RequestContext, s: ImportSession) -> dict:
    if s.state in OPEN_STATES:
        s.state, s.finished_at = "cancelled", now()
        for f in db.scalars(select(UploadFile).where(UploadFile.session_id == s.id, UploadFile.state == "pending")):
            f.state, f.reason = "failed", "Cancelled"
            if (s.totals or {}).get("taskId"):
                ingest.upload_failed(db, s, f, "Cancelled")
        source = db.get(Source, s.source_id) if s.source_id else None
        if source is not None and source.status == "uploading" and not db.scalar(select(SourceNode.id).where(SourceNode.source_id == source.id, SourceNode.is_dir.is_(False)).limit(1)):
            source.status = "ready"
        db.flush()
        if s.drop_id:
            drops.session_cancelled(db, ctx, s)
        audit.record(db, ctx.for_scope(s.project_id, None), "import.cancelled", target=s.id)
        _publish(db, ctx, s)
    return session_dict(db, s, files=True)


def stall_reason(minutes: int) -> str:
    return f"Inspection didn't finish in {minutes} minutes. Retry or drop the files again"


def fail_stalled(db: Session, at: datetime | None = None) -> int:
    """todo18 D6: nothing waits forever. A session still `inspecting` `API_IMPORT_STALL_MINUTES`
    after its bytes were committed fails with a reason (the worker died, its event was lost).
    Run by the api's housekeeping about once a minute; idempotent across replicas."""
    at = at or now()
    minutes = settings().import_stall_minutes
    if minutes <= 0:
        return 0
    cutoff = at - timedelta(minutes=minutes)
    n = 0
    for s in db.scalars(select(ImportSession).where(ImportSession.state == "inspecting").limit(500)):
        raw = (s.totals or {}).get("inspectingAt")
        since = datetime.fromisoformat(raw) if raw else s.started_at
        if since is None or (since if since.tzinfo else since.replace(tzinfo=UTC)) > cutoff:
            continue
        s.state, s.finished_at, s.error = "failed", at, stall_reason(minutes)
        source = db.get(Source, s.source_id) if s.source_id else None
        if source is not None and source.status == "inspecting" and not db.scalar(select(ImportSession.id).where(ImportSession.source_id == source.id, ImportSession.id != s.id, ImportSession.state.in_(("uploading", "inspecting"))).limit(1)):
            source.status = "ready"
        ctx = RequestContext(s.project_id, "service:housekeeping", f"stall-{s.id}")
        audit.record(db, ctx.for_scope(s.project_id, None), "import.stalled", target=s.id, after={"minutes": minutes})
        _publish(db, ctx, s)
        n += 1
    db.flush()
    return n


def finish_inspection(db: Session, s: ImportSession, needs_review: bool, at: datetime | None = None) -> None:
    s.state = "needs_review" if needs_review else "ready"
    s.finished_at = at or now()
    source = db.get(Source, s.source_id) if s.source_id else None
    if source is not None and not db.scalar(select(ImportSession.id).where(ImportSession.source_id == source.id, ImportSession.state.in_(("uploading", "inspecting"))).limit(1)):
        source.status = "ready"
