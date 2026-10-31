"""Worker routes: apps/worker pulls jobs here and reports results to the gateway (todo2 Phase 6).

Workers authenticate with the worker token (<envPrefix>API_WORKER_TOKEN). A claimed job
comes with a session token scoped to what the workspace granted that plugin version, and
one broker use token per provider secret; the plugin process gets nothing else.
"""

from __future__ import annotations

import hmac
import uuid

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy import update
from sqlalchemy.orm import Session

from ..config import env, settings
from ..context import RequestContext, issue_session
from ..db import get_session
from ..kernel import gateway, jobs, secrets
from ..plugins import installer, policy

router = APIRouter(prefix="/api/v1/worker")


# Dev only (production requires API_WORKER_TOKEN): the token a worker on the same machine
# assumes when none is set, so `pnpm dev` needs no setup (studio_worker.config).
DEV_WORKER_TOKEN = "dev-only-worker-token"


def worker_token() -> str:
    return settings().worker_token or env("API_WORKER_TOKEN") or DEV_WORKER_TOKEN


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
    entry = installer.catalog.get(j.plugin_id, j.version, db)
    return {
        "job": jobs.job_dict(j) | {"input": j.input, "workspaceId": j.workspace_id, "timeoutSeconds": j.timeout_s, "traceparent": j.traceparent},
        "plugin": {"id": j.plugin_id, "version": j.version, "artifactDigest": active.artifact_digest if active else None, "entrypoint": runtime.get("entrypoint"), "path": str(installer.package_path(entry) or "") if entry else "", "manifestDigest": entry.manifest_digest if entry else None, "egress": policy.egress_hosts(grants), "memoryMb": runtime.get("memoryMb")},
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





# ---- Inspection of uploaded files (todo6 Phase 5.1) -----------------------------------------
# The worker's built-in `inspect` subscriber reads `source.uploaded`, then the import's files
# (ranged reads of the bytes), stores thumbnails and derived CSVs, and reports once.


@router.get("/inspect/imports/{import_id}", dependencies=[Depends(_auth)])
def inspect_import(import_id: str, db: Session = Depends(get_session)):
    from ..kernel import inspection

    return inspection.import_for_worker(db, import_id)


@router.get("/inspect/nodes/{node_id}/content", dependencies=[Depends(_auth)])
def inspect_content(node_id: str, request: Request, db: Session = Depends(get_session)):
    from ..kernel import assets, inspection
    from ..streaming import blob_response

    _, a = inspection.node_asset(db, node_id)
    return blob_response(assets.store_of(a.path), assets.asset_key(a), "application/octet-stream", request)


@router.put("/inspect/nodes/{node_id}/derived/{role}", dependencies=[Depends(_auth)])
async def inspect_derived(node_id: str, role: str, request: Request, db: Session = Depends(get_session)):
    from ..kernel import inspection

    data = await request.body()
    return inspection.put_derived(db, node_id, role, data, request.headers.get("Content-Type", ""))


@router.post("/inspect/imports/{import_id}/report", dependencies=[Depends(_auth)])
def inspect_report(import_id: str, body: dict = Body(...), db: Session = Depends(get_session)):
    from ..kernel import inspection

    return inspection.report(db, import_id, body)


# ---- Scheduled kernel work (todo7 Phase 4) ---------------------------------------------------
# The worker's built-in `files.empty_trash` asks every so often; the kernel runs it at most once
# per day across every worker and replica (a `scheduled_runs` row per day, insert-or-ignore).


@router.post("/scheduled/files.empty_trash", dependencies=[Depends(_auth)])
def empty_trash_job(body: dict = Body(default={}), db: Session = Depends(get_session)):
    from datetime import UTC, datetime

    from ..dbutil import insert_ignore
    from ..kernel import fs
    from ..models import ScheduledRun

    period = datetime.now(UTC).strftime("%Y-%m-%d")
    force = bool(body.get("force"))
    if not force:
        insert_ignore(db, ScheduledRun, [{"name": "files.empty_trash", "period": period, "at": datetime.now(UTC)}])
        row = db.get(ScheduledRun, ("files.empty_trash", period))
        if row is None or row.result is not None:
            return {"ran": False, "period": period, "result": row.result if row else None}
        # Claim the period: only the request whose UPDATE moved `result` from NULL runs it.
        claimed = db.execute(update(ScheduledRun).where(ScheduledRun.name == "files.empty_trash", ScheduledRun.period == period, ScheduledRun.result.is_(None)).values(result={"state": "running"})).rowcount  # type: ignore[attr-defined]
        if not claimed:
            return {"ran": False, "period": period, "result": None}
    days = int(body["days"]) if isinstance(body.get("days"), int) else fs.TRASH_DAYS
    result = fs.purge_expired(db, days=max(0, days))
    if not force:
        db.execute(update(ScheduledRun).where(ScheduledRun.name == "files.empty_trash", ScheduledRun.period == period).values(result=result))
    return {"ran": True, "period": period, "result": result}
