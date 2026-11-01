"""Drops (todo13 D2–D4, D14, D15; kernel/drops.py). Behind `API_FEATURE_CHAT_DROPS`: every
route answers 404 while it is off.

    POST   /api/v1/projects/{id}/drops                         start a drop {origin, conversationId?, messageId?, taskId?, files?, bytes?, id?}
    GET    /api/v1/projects/{id}/drops?conversationId=         a conversation's drops, newest first (Shared files)
    GET    /api/v1/drops/{id}?offset=                          person: the drop; agent: its DropSummary (screened)
    DELETE /api/v1/drops/{id}/files/{nodeId}                   take a file out of the chat (the File stays)
    POST   /api/v1/projects/{id}/conversations/{cid}/deleted   the chat was deleted: its folder is renamed "(deleted chat)"

Uploads go through the import route with `origin`/`dropId` (routes/sources.py).
"""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends
from sqlalchemy.orm import Session

from ..context import RequestContext, get_context
from ..db import get_session
from ..kernel import drops, features, projects

router = APIRouter(prefix="/api/v1", dependencies=[Depends(features.require("chat_drops"))])


@router.post("/projects/{project_id}/drops", status_code=201)
def create_drop(project_id: str, body: dict = Body(default={}), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = projects.require_project(db, ctx, project_id, write=True)
    return drops.create(db, ctx, p, body)


@router.get("/projects/{project_id}/drops")
def list_drops(project_id: str, conversationId: str | None = None, limit: int = 50, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):  # noqa: N803 — the query name
    return drops.list_for(db, ctx, projects.require_project(db, ctx, project_id), conversationId, limit)


@router.get("/drops/{drop_id}")
def get_drop(drop_id: str, offset: int = 0, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    d, _ = drops.require(db, ctx, drop_id)
    return drops.get(db, ctx, d, offset)


@router.delete("/drops/{drop_id}/files/{node_id}")
def remove_file(drop_id: str, node_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    d, _ = drops.require(db, ctx, drop_id, write=True)
    return drops.remove_file(db, ctx, d, node_id)


@router.post("/projects/{project_id}/conversations/{conversation_id}/deleted")
def conversation_deleted(project_id: str, conversation_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = projects.require_project(db, ctx, project_id, write=True)
    return drops.conversation_deleted(db, ctx, p, conversation_id)
