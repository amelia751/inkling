"""Sources and imports (todo6 Phase 1.2, 4.5). Since todo7 the namespace is writable through
`routes/files.py` (`/v1/projects/:id/fs/*`); these reads stay as aliases. Removing an upload
moves its folder to the Trash (undoable) while no dataset uses it.

    GET   /api/v1/projects/{id}/sources                 the project's sources (tree roots)
    GET   /api/v1/projects/{id}/search?q=&kind=&status=  name search across the project
    GET   /api/v1/sources/{id}/children?node=&cursor=    a page of a folder (or of a numbered run)
    DELETE /api/v1/sources/{id}                          remove an upload (409 while a dataset uses it)
    GET   /api/v1/source-nodes/{id}                      facts, flags, path, used in, provenance
    GET   /api/v1/source-nodes/{id}/preview              type-specific preview JSON
    POST  /api/v1/source-nodes/{id}/privacy/clear        a person clears a privacy hold, with a reason
    GET   /api/v1/projects/{id}/imports                  import sessions, newest first
    POST  /api/v1/projects/{id}/imports                  start (or resume) a session: file list + attestation
    PUT   /api/v1/uploads/{session}/files/{fileId}       the bytes (`?offset=` for 64 MB chunks)
    POST  /api/v1/imports/{id}/complete | /cancel | /retry
    GET   /api/v1/imports/{id}
"""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..context import RequestContext, get_context
from ..db import get_session
from ..kernel import audit, events, fs, imports, projects, tree
from ..models import DatasetRow, ImportSession, SourceNode, now

router = APIRouter(prefix="/api/v1")


@router.get("/projects/{project_id}/sources")
def list_sources(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    projects.ensure_seeds_once(db)
    return {"sources": projects.list_sources(db, projects.require_project(db, ctx, project_id))}


@router.get("/projects/{project_id}/search")
def search(project_id: str, q: str = "", kind: str | None = None, status: str | None = None, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = projects.require_project(db, ctx, project_id)
    return {"items": projects.search_nodes(db, p, q.strip()[:200], kind, status)}


@router.get("/sources/{source_id}/children")
def children(source_id: str, node: str | None = None, cursor: str | None = None, limit: int = tree.PAGE, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    s, _ = projects.require_source(db, ctx, source_id)
    parent = node or s.root_node_id or ""
    if not parent.startswith("seq:"):
        n = db.get(SourceNode, parent)
        if n is None or n.project_id != s.project_id:
            raise HTTPException(404, "no such folder in this source")
    try:
        start = int(cursor or 0)
    except ValueError:
        raise HTTPException(422, "bad cursor") from None
    stars = fs.starred_ids(db, s.project_id, fs.person(ctx))
    return tree.children(db, s.project_id, parent, max(0, start), max(1, min(limit, tree.PAGE)), starred=stars)


@router.delete("/sources/{source_id}")
def remove_source(source_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    if ctx.scopes:
        raise HTTPException(403, "only people remove uploads")
    s, p = projects.require_source(db, ctx, source_id)
    projects.require_project(db, ctx, p.id, write=True)
    if s.kind == "seed":
        raise HTTPException(409, "sample data can't be removed")
    used = [d.title for d in db.scalars(select(DatasetRow).where(DatasetRow.project_id == p.id)) if projects._uses_source(db, d, s)]
    if used:
        raise HTTPException(409, f"Used by {', '.join(used[:3])}: remove it from those datasets first")
    for sess in db.scalars(select(ImportSession).where(ImportSession.source_id == s.id)):
        sess.state = "cancelled" if sess.state == "uploading" else sess.state
    root = db.get(SourceNode, s.root_node_id) if s.root_node_id else None
    if root is not None and root.trashed_at is None and root.parent_id is not None:
        fs.apply(db, ctx, p, {"ops": [{"kind": "trash", "nodeIds": [root.id]}]})
    audit.record(db, ctx.for_scope(p.id, None), "source.removed", target=s.id, after={"title": s.title})
    return Response(status_code=204)


@router.get("/source-nodes/{node_id}")
def describe(node_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    n, _ = projects.require_node(db, ctx, node_id)
    fs.opened(db, ctx, n)
    return projects.describe_node(db, n, ctx)


@router.get("/source-nodes/{node_id}/preview")
def preview(node_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    n, _ = projects.require_node(db, ctx, node_id)
    return projects.preview(db, ctx, n)


@router.post("/source-nodes/{node_id}/privacy/clear")
def clear_privacy(node_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """Only a person, with a reason; recorded in the audit log (this is a development check,
    not de-identification)."""
    if ctx.scopes or not ctx.principal.startswith("user:"):
        raise HTTPException(403, "only a person can clear a privacy hold")
    n, p = projects.require_node(db, ctx, node_id)
    projects.require_project(db, ctx, p.id, write=True)
    reason = str(body.get("reason") or "").strip()
    if not reason:
        raise HTTPException(422, "say why this file is safe to use")
    priv = (n.flags or {}).get("privacy")
    if not priv:
        raise HTTPException(409, "this file isn't held")
    n.flags = {**n.flags, "privacy": {**priv, "clearedBy": ctx.principal, "clearedAt": projects.iso(now()), "clearReason": reason[:1000]}}
    audit.record(db, ctx.for_scope(p.id, None), "privacy.cleared", target=n.id, before={"privacy": priv}, after={"reason": reason[:1000]})
    events.publish(db, ctx.for_scope(p.id, None), "source.node.inspected", {"projectId": p.id, "nodeIds": [n.id]}, source="kernel")
    return projects.describe_node(db, n, ctx)


# ---- Imports -----------------------------------------------------------------------------------


@router.get("/projects/{project_id}/imports")
def list_imports(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return {"imports": imports.list_sessions(db, projects.require_project(db, ctx, project_id))}


@router.post("/projects/{project_id}/imports", status_code=201)
def start_import(project_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = projects.require_project(db, ctx, project_id, write=True)
    return imports.create_session(db, ctx, p, body)


@router.put("/uploads/{session_id}/files/{file_id}")
async def upload_file(session_id: str, file_id: str, request: Request, offset: int = 0, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return await imports.receive(db, ctx, session_id, file_id, offset, request.stream())


@router.get("/imports/{session_id}")
def get_import(session_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    s, _ = imports.require_session(db, ctx, session_id)
    return imports.session_dict(db, s, files=True)


@router.post("/imports/{session_id}/complete")
def complete_import(session_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    s, p = imports.require_session(db, ctx, session_id, write=True)
    return imports.complete(db, ctx, s, p)


@router.post("/imports/{session_id}/cancel")
def cancel_import(session_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    s, _ = imports.require_session(db, ctx, session_id, write=True)
    return imports.cancel(db, ctx, s)


@router.post("/imports/{session_id}/retry")
def retry_import(session_id: str, body: dict = Body(default={}), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    s, _ = imports.require_session(db, ctx, session_id, write=True)
    ids = body.get("fileIds")
    return imports.retry(db, ctx, s, [str(x) for x in ids] if isinstance(ids, list) else None)

