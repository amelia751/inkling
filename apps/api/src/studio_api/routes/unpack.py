"""Archive unpack (todo13 §4 M2 item 7): the worker's built-in `unpack` subscriber claims
`archive.unpack.requested`, reads the archive through the worker content route, checks it
against `WORKER_UNPACK_*` (size, count, ratio, depth; no symlinks, no path traversal; encrypted
archives refused), then streams each entry here. The entries land as an ordinary import session
next to the archive (folder `<archive name>`), so they get quarantine, hashing, dedupe and
inspection like any upload, and form a **child drop** that is classified on its own.

    POST /api/v1/worker/unpack/{nodeId}/start          {dropId, childDropId, depth, entries} → the session
    PUT  /api/v1/worker/unpack/sessions/{sid}/files/{fid}?offset=   one entry (64 MB chunks)
    POST /api/v1/worker/unpack/sessions/{sid}/complete → commit (inspection follows)
    POST /api/v1/worker/unpack/{nodeId}/refused        {dropId, reason, errorClass} → flag + `drop.failed`

Worker token only. The session acts for the person who imported the archive (they attested
its contents when they dropped it); the archive's own bytes never leave `spurby-phi`.
"""

from __future__ import annotations

import posixpath

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..context import RequestContext
from ..db import get_session
from ..kernel import drops_plan, events, imports
from ..models import DropPlanRow, ImportSession, ProjectRow, SourceNode
from .worker import _auth

router = APIRouter(prefix="/api/v1/worker/unpack", dependencies=[Depends(_auth)])
REASONS = {"too_large", "too_many_files", "ratio", "depth", "traversal", "encrypted", "unreadable", "tmp_budget", "symlink"}


def _archive(db: Session, node_id: str) -> tuple[SourceNode, ProjectRow, str]:
    n = db.get(SourceNode, node_id)
    if n is None or n.is_dir or n.detected_kind != "archive":
        raise HTTPException(404, "no such archive")
    p = db.get(ProjectRow, n.project_id)
    assert p is not None
    s = db.get(ImportSession, n.import_session_id) if n.import_session_id else None
    person = s.created_by if s is not None else p.created_by
    return n, p, person


def _ctx(project_id: str, person: str) -> RequestContext:
    return drops_plan._service_ctx(project_id, person)


def _stem(name: str) -> str:
    low = name.lower()
    for ext in (".tar.gz", ".tgz", ".tar", ".zip", ".gz"):
        if low.endswith(ext):
            return name[: -len(ext)] or "archive"
    return posixpath.splitext(name)[0] or "archive"


@router.post("/{node_id}/start")
def start(node_id: str, body: dict = Body(...), db: Session = Depends(get_session)):
    n, p, person = _archive(db, node_id)
    entries = body.get("entries")
    if not isinstance(entries, list) or not entries:
        raise HTTPException(422, "entries must list the archive's files")
    stem = _stem(n.name)
    files = []
    for i, e in enumerate(entries):
        if not isinstance(e, dict) or not isinstance(e.get("relPath"), str):
            raise HTTPException(422, f"entries[{i}] needs a relPath")
        files.append({"clientFileId": str(e.get("clientFileId") or f"e{i}"), "relPath": f"{stem}/{e['relPath']}", "size": e.get("size"), "sha256": e.get("sha256")})
    ctx = _ctx(p.id, person)
    out = imports.create_session(db, ctx, p, {"files": files, "attested": True, "targetNodeId": n.parent_id, "title": stem})
    s = db.get(ImportSession, out["id"])
    assert s is not None
    parent = db.get(DropPlanRow, str(body.get("dropId") or ""))
    dataset_id = (parent.context or {}).get("datasetId") if parent is not None else None
    s.totals = {
        **(s.totals or {}),
        "dropId": str(body.get("childDropId") or f"{body.get('dropId')}-u{node_id[-8:]}"),
        "parentDropId": body.get("dropId"),
        "origin": "unpack",
        "depth": int(body.get("depth") or 1),
        "archiveNodeId": n.id,
        **({"datasetId": dataset_id} if dataset_id else {}),
    }
    db.flush()
    return imports.session_dict(db, s, files=True)


def _session(db: Session, sid: str) -> tuple[ImportSession, RequestContext]:
    s = db.get(ImportSession, sid)
    if s is None or (s.totals or {}).get("origin") != "unpack":
        raise HTTPException(404, "no such unpack session")
    return s, _ctx(s.project_id, s.created_by)


@router.put("/sessions/{sid}/files/{fid}")
async def put_file(sid: str, fid: str, request: Request, offset: int = 0, db: Session = Depends(get_session)):
    _, ctx = _session(db, sid)
    return await imports.receive(db, ctx, sid, fid, offset, request.stream())


@router.post("/sessions/{sid}/complete")
def complete(sid: str, db: Session = Depends(get_session)):
    s, ctx = _session(db, sid)
    p = db.get(ProjectRow, s.project_id)
    assert p is not None
    return imports.complete(db, ctx, s, p)


@router.post("/{node_id}/refused")
def refused(node_id: str, body: dict = Body(...), db: Session = Depends(get_session)):
    """The archive stays a File, flagged with why it wasn't unpacked (the chip shows it)."""
    n, p, person = _archive(db, node_id)
    reason = str(body.get("reason") or "unreadable")
    if reason not in REASONS:
        reason = "unreadable"
    message = {
        "too_large": "Not unpacked: it would be larger than the unpack limit",
        "too_many_files": "Not unpacked: it holds more files than the unpack limit",
        "ratio": "Not unpacked: it expands far more than a normal archive (a zip bomb?)",
        "depth": "Not unpacked: archives nested too deep",
        "traversal": "Not unpacked: it has paths that point outside the archive",
        "encrypted": "Not unpacked: it's encrypted",
        "unreadable": "Not unpacked: we couldn't read this archive",
        "tmp_budget": "Not unpacked: too large to unpack here",
        "symlink": "Not unpacked: it holds links",
    }[reason]
    n.flags = {**(n.flags or {}), "unsupported": message, "unpack": {"refused": reason}}
    db.flush()
    events.publish(db, _ctx(p.id, person), "drop.failed", {"dropId": str(body.get("dropId") or ""), "step": "unpack", "errorClass": reason, "nodeId": n.id}, source="kernel")
    # The unpack-refusals metric reads this line (§7.3).
    drops_plan.log_failed(str(body.get("dropId") or ""), "unpack", reason, db)
    events.publish(db, _ctx(p.id, person), "source.node.inspected", {"projectId": p.id, "nodeIds": [n.id]}, source="kernel")
    return {"nodeId": n.id, "refused": reason}
