"""Service routes (todo12 §4 M0 items 5-6, §5 contracts): what `service:pipeline` may call.

    POST /api/v1/service/jobs        {workspace_id, kind, plugin?, input_ref, resource_class, idempotency_key} → {job_id}
    GET  /api/v1/service/jobs/{id}   → {state, attempts, result_ref?, error_class?}
    GET  /api/v1/service/events?after=<cursor>&types=<csv>[&limit=&wait=]   → {events: [envelope], cursor}
    POST /api/v1/service/events      {workspace_id, type, payload, payload_ref?, correlation_id?, depth?, idempotency_key} → {event_id, replayed}

The feed long-polls: with nothing new it waits up to `wait` seconds (default and maximum 25)
for an event before answering with an empty page and the same cursor. It holds no database
connection while it waits (a fresh short session per poll), so a waiting consumer costs one
async task, not a pool slot.
"""

from __future__ import annotations

import asyncio
import time
import uuid

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.orm import Session
from studio_observability import request_id as obs_request_id

from ..context import RequestContext
from ..db import get_session, session_scope
from ..kernel import events, service_jobs, service_scope
from ..models import PluginEvent, Workspace

router = APIRouter(prefix="/api/v1/service")

FEED_WAIT_MAX_S = 25.0
FEED_POLL_S = 0.25

# Event types each service principal may publish (source = the principal's name).
PUBLISHES: dict[str, frozenset[str]] = {service_scope.PIPELINE: frozenset()}  # pipeline event types arrive with Milestone 1


def _correlation(request: Request) -> str:
    return obs_request_id() or request.headers.get("X-Correlation-Id") or uuid.uuid4().hex


@router.post("/jobs")
def enqueue_job(request: Request, body: dict = Body(...), principal: str = Depends(service_scope.require), db: Session = Depends(get_session)):
    j, created = service_jobs.enqueue(db, principal, _correlation(request), body)
    return JSONResponse({"job_id": j.job_id}, status_code=201 if created else 200)


@router.get("/jobs/{job_id}")
def job_status(job_id: str, principal: str = Depends(service_scope.require), db: Session = Depends(get_session)):
    return service_jobs.status(db, principal, job_id)


@router.get("/events")
async def event_feed(request: Request, after: str | None = None, types: str | None = None, limit: int = 100, wait: float = FEED_WAIT_MAX_S, principal: str = Depends(service_scope.require)):
    wanted = [t.strip() for t in (types or "").split(",") if t.strip()] or None
    deadline = time.monotonic() + max(0.0, min(FEED_WAIT_MAX_S, wait))

    def once() -> tuple[list[dict], str]:
        with session_scope() as s:
            return events.feed(s, after, wanted, limit)

    while True:
        rows, cursor = await asyncio.to_thread(once)
        if rows or time.monotonic() >= deadline or await request.is_disconnected():
            return {"events": rows, "cursor": cursor}
        after = cursor  # skips past rows of other types already scanned
        await asyncio.sleep(FEED_POLL_S)


@router.post("/events")
def publish_event(request: Request, body: dict = Body(...), principal: str = Depends(service_scope.require), db: Session = Depends(get_session)):
    workspace_id, type_, key = body.get("workspace_id"), body.get("type"), body.get("idempotency_key")
    payload = body.get("payload") or {}
    if not isinstance(workspace_id, str) or not isinstance(type_, str) or not isinstance(key, str) or not key:
        raise HTTPException(422, "workspace_id, type and idempotency_key are required")
    if not isinstance(payload, dict):
        raise HTTPException(422, "payload must be an object")
    if type_ not in PUBLISHES.get(principal, frozenset()):
        raise HTTPException(403, f"{principal} can't publish {type_!r}")
    if db.get(Workspace, workspace_id) is None:
        raise HTTPException(404, "no such workspace")
    depth = body.get("depth") or 0
    if not isinstance(depth, int) or depth < 0:
        raise HTTPException(422, "depth must be a non-negative integer")
    ref = body.get("payload_ref")
    ctx = RequestContext(workspace_id, principal, str(body.get("correlation_id") or _correlation(request))[:64])
    ev = events.publish(db, ctx, type_, payload, source=principal.split(":", 1)[1], depth=depth, idempotency_key=key, payload_ref=ref if isinstance(ref, str) else None)
    if ev is None:
        prior = db.scalar(select(PluginEvent.event_id).where(PluginEvent.workspace_id == workspace_id, PluginEvent.idempotency_key == key))
        return {"event_id": prior, "replayed": True}
    return {"event_id": ev.event_id, "replayed": False}
