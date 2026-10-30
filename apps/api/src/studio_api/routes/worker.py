"""Worker routes: apps/worker pulls jobs here and reports results to the gateway (todo2 Phase 6).

Workers authenticate with the worker token (<envPrefix>API_WORKER_TOKEN). A claimed job
comes with a session token scoped to what the workspace granted that plugin version, and
one broker use token per provider secret; the plugin process gets nothing else.
"""

from __future__ import annotations

import hmac
import uuid

from fastapi import APIRouter, Body, Depends, Header, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from ..config import settings
from ..context import issue_session
from ..db import get_session
from ..kernel import gateway, jobs, secrets
from ..naming import env
from ..plugins import installer, policy

router = APIRouter(prefix="/api/v1/worker")


def worker_token() -> str:
    return settings().worker_token or env("API_WORKER_TOKEN") or f"dev-worker:{settings().secret_key[:16]}"


def _auth(x_worker_token: str = Header(default="")) -> None:
    if not hmac.compare_digest(x_worker_token, worker_token()):
        raise HTTPException(401, "bad worker token")


@router.post("/claim", dependencies=[Depends(_auth)])
def claim(body: dict = Body(default={}), db: Session = Depends(get_session)):
    j = jobs.claim(db, str(body.get("workerId") or "worker"), body.get("plugins"))
    if j is None:
        return {"job": None}
    manifest = installer.manifest_of(db, j.plugin_id, j.version)
    grants = sorted(policy.granted(db, j.workspace_id, j.plugin_id, j.version))
    token = issue_session(db, f"plugin:{j.plugin_id}@{j.version}", j.workspace_id, grants + ["commands.none"], ttl_s=j.timeout_s + 60, profile="plugin")
    provider = next((p for p in manifest.get("providers") or [] if p["id"] == j.provider), None)
    use_tokens = {}
    if provider:
        hosts = [h for h in provider.get("egress") or [] if f"network.egress:{h}" in grants]
        for name in provider.get("secrets") or []:
            if f"secrets.use:{name}" in grants:
                use_tokens[name] = secrets.issue_use_token(j.workspace_id, j.plugin_id, j.version, name, hosts, j.job_id, ttl_s=j.timeout_s + 60)
    runtime = manifest.get("runtime") or {}
    active = installer.active(db, j.workspace_id).get(j.plugin_id)
    entry = installer.catalog.get(j.plugin_id, j.version)
    return {
        "job": jobs.job_dict(j) | {"input": j.input, "workspaceId": j.workspace_id, "timeoutSeconds": j.timeout_s, "traceparent": j.traceparent},
        "plugin": {"id": j.plugin_id, "version": j.version, "artifactDigest": active.artifact_digest if active else None, "entrypoint": runtime.get("entrypoint"), "path": str(installer.package_path(entry) or "") if entry else "", "egress": policy.egress_hosts(grants), "memoryMb": runtime.get("memoryMb")},
        "provider": provider,
        "config": installer.current_config(db, j.workspace_id, j.plugin_id),
        "sessionToken": token,
        "secretUseTokens": use_tokens,
    }


@router.post("/jobs/{job_id}/progress", dependencies=[Depends(_auth)])
def progress(job_id: str, body: dict = Body(...), db: Session = Depends(get_session)):
    j = jobs.progress(db, job_id, str(body.get("workerId")), float(body.get("progress") or 0), body.get("message"))
    return {"state": j.state}


@router.post("/jobs/{job_id}/complete", dependencies=[Depends(_auth)])
def complete(job_id: str, body: dict = Body(...), db: Session = Depends(get_session)):
    j = jobs._owned(db, job_id, str(body.get("workerId")))
    gateway.finish(db, j, body.get("result"), body.get("costUsd"))
    return jobs.job_dict(j)


@router.post("/jobs/{job_id}/fail", dependencies=[Depends(_auth)])
def fail(job_id: str, body: dict = Body(...), db: Session = Depends(get_session)):
    j = jobs.fail(db, job_id, str(body.get("workerId")), str(body.get("error") or "failed"), bool(body.get("recoverable", True)))
    return jobs.job_dict(j)


@router.post("/jobs/{job_id}/release", dependencies=[Depends(_auth)])
def release(job_id: str, body: dict = Body(...), db: Session = Depends(get_session)):
    """A worker that is shutting down (SIGTERM) hands its job back to the queue."""
    j = jobs.release(db, job_id, str(body.get("workerId")))
    return jobs.job_dict(j)


@router.post("/events/deliver", dependencies=[Depends(_auth)])
def deliver(db: Session = Depends(get_session)):
    from ..kernel import eventbus

    return {"delivered": eventbus.deliver(db)}


# ---- Built-in subscriptions and versioning checks (todo4 Phase 6) ----------------------------
# The worker's de-identification check subscribes to `versioning.review.opened` (and
# `…checks_requested`, published when a head move sends a review back to CHECKING). It reads
# the review through the same kernel operations as everyone else, as a service principal
# limited to reading and reporting checks, and posts the result back here.

WORKER_VERSIONING_OPS = {"review.get", "diff", "checkout", "review.check"}
WORKER_VERSIONING_SCOPES = ("versioning.read", "versioning.checkout", "versioning.checks")


@router.post("/subscriptions/claim", dependencies=[Depends(_auth)])
def claim_events(body: dict = Body(...), db: Session = Depends(get_session)):
    from ..kernel import events

    subscriber = str(body.get("subscriber") or "")
    types = [str(t) for t in body.get("types") or []]
    if not subscriber or not types:
        raise HTTPException(422, "subscriber and types are required")
    evs = events.claim_for(db, subscriber, types, int(body.get("limit") or 20))
    return {"events": [{"eventId": e.event_id, "type": e.type, "workspaceId": e.workspace_id, "payload": e.payload, "correlationId": e.correlation_id, "depth": e.depth} for e in evs]}


@router.post("/subscriptions/ack", dependencies=[Depends(_auth)])
def ack_events(body: dict = Body(...), db: Session = Depends(get_session)):
    from ..kernel import events

    return {"acked": events.ack(db, str(body.get("subscriber") or ""), [str(x) for x in body.get("eventIds") or []])}


@router.post("/versioning/run", dependencies=[Depends(_auth)])
def versioning_run(body: dict = Body(...), db: Session = Depends(get_session)):
    """Run a read or report-check versioning operation in a workspace, as the worker."""
    from ..kernel.versioning import service as vservice

    op = str(body.get("op") or "")
    if op not in WORKER_VERSIONING_OPS:
        raise HTTPException(403, f"the worker can't run {op!r}")
    workspace = str(body.get("workspaceId") or "")
    if not workspace:
        raise HTTPException(422, "workspaceId is required")
    ctx = RequestContext(workspace, f"service:{body.get('subscriber') or 'worker'}"[:128], str(body.get("correlationId") or uuid.uuid4().hex), scopes=WORKER_VERSIONING_SCOPES)
    status, out = vservice.run(db, ctx, op, str(body.get("datasetId") or ""), body.get("body") or {})
    return JSONResponse(out, status_code=status)



