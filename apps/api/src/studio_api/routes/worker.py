"""Worker routes: apps/worker pulls jobs here and reports results to the gateway (todo2 Phase 6).

Workers authenticate with the worker token (<envPrefix>API_WORKER_TOKEN). A claimed job
comes with a session token scoped to what the workspace granted that plugin version, and
one broker use token per provider secret; the plugin process gets nothing else.
"""

from __future__ import annotations

import asyncio
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


def _attempt(body: dict) -> int | None:
    """The fencing token: the attempt number the claim returned (`job.attempts`)."""
    a = body.get("attempt")
    return a if isinstance(a, int) and not isinstance(a, bool) else None


@router.post("/claim", dependencies=[Depends(_auth)])
def claim(body: dict = Body(default={}), db: Session = Depends(get_session)):
    """`resourceClasses`: the pools this worker runs (default cpu, memory); `heartbeat: true`
    means it renews the lease through the progress call, so it gets the short lease."""
    classes = body.get("resourceClasses")
    j = jobs.claim(db, str(body.get("workerId") or "worker"), body.get("plugins"), [str(c) for c in classes] if isinstance(classes, list) else None, bool(body.get("heartbeat")))
    if j is None:
        return {"job": None}
    from ..kernel import boundary, service_jobs

    if j.plugin_id == service_jobs.PLUGIN:
        # A kernel job a service enqueued (todo12 §5): the worker runs it itself.
        return {"job": jobs.job_dict(j) | {"input": j.input, "workspaceId": j.workspace_id, "timeoutSeconds": j.timeout_s, "traceparent": j.traceparent}, "builtin": "service"}
    from ..kernel import url_imports

    if j.plugin_id == url_imports.PLUGIN:
        # A kernel import job (todo16 round 2): the worker asks the kernel to run it.
        return {"job": jobs.job_dict(j) | {"workspaceId": j.workspace_id, "timeoutSeconds": j.timeout_s, "traceparent": j.traceparent}, "builtin": "imports"}
    if j.plugin_id == boundary.PLUGIN:
        # A data-boundary job (todo10 Phase 7): the worker runs it itself; no plugin, no session token.
        return {"job": jobs.job_dict(j) | {"input": j.input, "workspaceId": j.workspace_id, "timeoutSeconds": j.timeout_s, "traceparent": j.traceparent}, "builtin": "boundary"}
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
    """The heartbeat. 409 means stop: the lease was lost or the job was cancelled."""
    j = jobs.progress(db, job_id, str(body.get("workerId")), float(body.get("progress") or 0), body.get("message"), _attempt(body))
    return {"state": j.state, "leaseUntil": j.lease_until.isoformat() if j.lease_until else None}


@router.post("/jobs/{job_id}/complete", dependencies=[Depends(_auth)])
def complete(job_id: str, body: dict = Body(...), db: Session = Depends(get_session)):
    j = jobs._owned(db, job_id, str(body.get("workerId")), _attempt(body))
    from ..kernel import boundary

    if j.plugin_id == boundary.PLUGIN:
        raise HTTPException(409, "boundary jobs report to /boundary/jobs/{id}/complete")
    from ..kernel import url_imports

    if j.plugin_id == url_imports.PLUGIN:
        raise HTTPException(409, "import jobs run through /imports/jobs/{id}/run")
    gateway.finish(db, j, body.get("result"), body.get("costUsd"))
    return jobs.job_dict(j)


@router.post("/jobs/{job_id}/fail", dependencies=[Depends(_auth)])
def fail(job_id: str, body: dict = Body(...), db: Session = Depends(get_session)):
    j = jobs.fail(db, job_id, str(body.get("workerId")), str(body.get("error") or "failed"), bool(body.get("recoverable", True)), _attempt(body), body.get("errorClass"))
    return jobs.job_dict(j)


@router.post("/jobs/{job_id}/release", dependencies=[Depends(_auth)])
def release(job_id: str, body: dict = Body(...), db: Session = Depends(get_session)):
    """A worker that is shutting down (SIGTERM) hands its job back to the queue."""
    j = jobs.release(db, job_id, str(body.get("workerId")), _attempt(body))
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


# ---- Media derivatives (todo18 D4): video → MP4, slide → DZI.


@router.post("/derivatives/claim", dependencies=[Depends(_auth)])
def claim_derivatives(body: dict = Body(default={}), db: Session = Depends(get_session)):
    from ..kernel import derivatives

    kinds = body.get("kinds")
    rows = derivatives.claim(db, int(body.get("limit") or 1), int(body.get("maxAttempts") or derivatives.DEFAULT_MAX_ATTEMPTS), kinds=[str(k) for k in kinds] if isinstance(kinds, list) else None)
    db.commit()
    return {"derivatives": [derivatives.public(r) for r in rows]}


@router.post("/derivatives/{did}/progress", dependencies=[Depends(_auth)])
def derivative_progress(did: str, body: dict = Body(...), db: Session = Depends(get_session)):
    from ..kernel import derivatives

    derivatives.progress(db, derivatives.get(db, did), int(body.get("progress") or 0))
    db.commit()
    return {"ok": True}


@router.put("/derivatives/{did}/files/{rel:path}", dependencies=[Depends(_auth)])
async def derivative_file(did: str, rel: str, request: Request, db: Session = Depends(get_session)):
    from ..kernel import derivatives

    from .. import blobstore

    row = derivatives.get(db, did)
    key = derivatives.file_key(row, rel)
    ctype = request.headers.get("Content-Type") or "application/octet-stream"
    # Spooled to /tmp and handed to the BlobStore as a file (a converted video can be
    # gigabytes): never held in memory.
    import os
    import tempfile

    size = 0
    with tempfile.NamedTemporaryFile(prefix="derive-", delete=False) as f:
        async for chunk in request.stream():
            size += len(chunk)
            f.write(chunk)
    try:
        blobstore.data().put_file(key, f.name, ctype)
    finally:
        os.unlink(f.name)
    derivatives.register_file(db, row, key, ctype, size)
    db.commit()
    return {"key": key}


@router.post("/derivatives/{did}/complete", dependencies=[Depends(_auth)])
def derivative_complete(did: str, body: dict = Body(...), db: Session = Depends(get_session)):
    from ..kernel import derivatives

    row = derivatives.get(db, did)
    derivatives.complete(db, row, sha=str(body["sha"]), key=str(body["key"]), keys=[str(k) for k in body.get("keys") or []], meta=body.get("meta") or {})
    db.commit()
    return derivatives.public(row)


@router.post("/derivatives/{did}/fail", dependencies=[Depends(_auth)])
def derivative_fail(did: str, body: dict = Body(...), db: Session = Depends(get_session)):
    from ..kernel import derivatives

    row = derivatives.get(db, did)
    derivatives.fail(db, row, str(body.get("reason") or "Conversion failed"), retry=bool(body.get("retry")), max_attempts=int(body.get("maxAttempts") or derivatives.DEFAULT_MAX_ATTEMPTS), unavailable=bool(body.get("unavailable")))
    db.commit()
    return derivatives.public(row)


# ---- Item derivatives (todo11 D8): the worker's built-in `items` processor claims uploaded
# items (visible first), reads their bytes, stores a thumbnail and a preview, and reports stages.


@router.post("/items/claim", dependencies=[Depends(_auth)])
def claim_items(body: dict = Body(default={}), db: Session = Depends(get_session)):
    from ..kernel import ingest

    return {"items": ingest.claim(db, int(body.get("limit") or 4))}


@router.get("/items/{item_id}/content", dependencies=[Depends(_auth)])
def item_content(item_id: int, request: Request, db: Session = Depends(get_session)):
    from ..kernel import assets, ingest
    from ..streaming import blob_response

    key = ingest.content_key(ingest.require_item(db, item_id))
    return blob_response(assets.store_of(key), key, "application/octet-stream", request)


@router.put("/items/{item_id}/derived/{role}", dependencies=[Depends(_auth)])
async def item_derived(item_id: int, role: str, request: Request, db: Session = Depends(get_session)):
    from ..kernel import ingest

    data = await request.body()
    # Off the event loop: a SQLite write waiting for the lock must not stall other requests.
    return await asyncio.to_thread(lambda: ingest.put_derived(db, ingest.require_item(db, item_id), role, data, request.headers.get("Content-Type", "")))


@router.post("/items/{item_id}/report", dependencies=[Depends(_auth)])
def item_report(item_id: int, body: dict = Body(...), db: Session = Depends(get_session)):
    from ..kernel import ingest

    return ingest.report(db, ingest.require_item(db, item_id), body)


# ---- Scheduled kernel work (todo7 Phase 4) ---------------------------------------------------
# The worker's built-in `files.empty_trash` asks every so often; the kernel runs it at most once
# per day across every worker and replica (a `scheduled_runs` row per day, insert-or-ignore).


@router.post("/scheduled/trash.purge", dependencies=[Depends(_auth)])
@router.post("/scheduled/files.empty_trash", dependencies=[Depends(_auth)])
def empty_trash_job(body: dict = Body(default={}), db: Session = Depends(get_session)):
    from datetime import UTC, datetime

    from ..dbutil import insert_ignore
    from ..kernel import trash
    from ..models import ScheduledRun

    period = datetime.now(UTC).strftime("%Y-%m-%d")
    force = bool(body.get("force"))
    if not force:
        insert_ignore(db, ScheduledRun, [{"name": "files.empty_trash", "period": period, "at": datetime.now(UTC)}])
        row = db.get(ScheduledRun, ("files.empty_trash", period))
        if row is None or row.result is not None:
            return {"ran": False, "period": period, "result": row.result if row else None}
        # Claim the period: only the request whose UPDATE moved `result` from NULL runs it.
        claimed = db.execute(update(ScheduledRun).where(ScheduledRun.name == "files.empty_trash", ScheduledRun.period == period, ScheduledRun.result.is_(None)).values(result={"state": "running"}, at=datetime.now(UTC))).rowcount  # type: ignore[attr-defined]
        if not claimed:
            return {"ran": False, "period": period, "result": None}
    days = int(body["days"]) if isinstance(body.get("days"), int) else trash.days()
    # todo16: `trash.purge` (alias `files.empty_trash`): files and every other kind in Trash.
    result = trash.purge_expired(db, days_=max(0, days))
    if not force:
        db.execute(update(ScheduledRun).where(ScheduledRun.name == "files.empty_trash", ScheduledRun.period == period).values(result=result))
    return {"ran": True, "period": period, "result": result}


@router.post("/scheduled/blobs.retry", dependencies=[Depends(_auth)])
def blobs_retry_job(body: dict = Body(default={}), db: Session = Depends(get_session)):
    """todo18 D8: once a day, retry the after-commit blob and repo deletes that failed
    (`blob_delete_retries`). `force` runs it again the same day."""
    from datetime import UTC, datetime

    from ..dbutil import insert_ignore
    from ..kernel import purge
    from ..models import ScheduledRun

    period = datetime.now(UTC).strftime("%Y-%m-%d")
    if not body.get("force"):
        insert_ignore(db, ScheduledRun, [{"name": "blobs.retry", "period": period, "at": datetime.now(UTC)}])
        claimed = db.execute(update(ScheduledRun).where(ScheduledRun.name == "blobs.retry", ScheduledRun.period == period, ScheduledRun.result.is_(None)).values(result={"state": "running"})).rowcount  # type: ignore[attr-defined]
        if not claimed:
            return {"ran": False, "period": period}
    result = purge.sweep(db)
    if not body.get("force"):
        db.execute(update(ScheduledRun).where(ScheduledRun.name == "blobs.retry", ScheduledRun.period == period).values(result=result))
    return {"ran": True, "period": period, "result": result}


@router.post("/scheduled/files.screen_names", dependencies=[Depends(_auth)])
def screen_names_job(body: dict = Body(default={}), db: Session = Depends(get_session)):
    """todo13 D13: the name-screening backfill, a slice at a time (every worker asks about once a
    minute; each call works at most `budgetS` seconds, paced by API_NAME_SCREEN_QPS). Resumable:
    it always takes what is still unscreened. Concurrent calls only share the work."""
    from ..kernel import name_screen

    budget = body.get("budgetS")
    result = name_screen.backfill(db, max_batches=None, budget_s=float(budget) if isinstance(budget, (int, float)) and budget > 0 else 20.0)
    return {"ran": result["screened"] > 0, "result": result}


@router.post("/scheduled/rules.scan", dependencies=[Depends(_auth)])
def rules_scan_job(body: dict = Body(default={}), db: Session = Depends(get_session)):
    """todo17 D10: drain the queued per-project scans (every rules change enqueues one), and run
    the daily scan of every project once per UTC day from API_RULES_SCAN_HOUR on."""
    from ..config import settings
    from ..kernel import findings

    drained = findings.drain(db)
    daily = findings.daily(db, hour=settings().rules_scan_hour)
    return {"ran": bool(drained) or bool(daily.get("ran")), "result": {"scans": drained, "daily": daily}}


# ---- Import jobs (todo16 round 2) -------------------------------------------------------------
# `imports.fetch_url`: the worker claims the job (builtin "imports") and asks the kernel to run
# it; the kernel fetches the link (pinned address, capped) and lands it in the queued session.


@router.post("/imports/jobs/{job_id}/run", dependencies=[Depends(_auth)])
def run_import_job(job_id: str, body: dict = Body(default={}), db: Session = Depends(get_session)):
    from ..kernel import url_imports

    out = url_imports.run_fetch(db, url_imports.worker_job(db, job_id, str(body.get("workerId"))))
    return {"state": out.get("state"), "error": out.get("error")}


# ---- Data-boundary jobs (todo10 Phase 7) ------------------------------------------------------
# The worker reads a boundary job's sample (fingerprint, verify, probe only) or the agent's source
# (verify, build), uploads fixtures or our rebuilt bundle, and reports a fixed-schema result that
# the kernel validates (kernel/boundary.py). Failures carry an error class, never a message.


@router.get("/boundary/jobs/{job_id}/sample", dependencies=[Depends(_auth)])
def boundary_sample(job_id: str, workerId: str, request: Request, db: Session = Depends(get_session)):
    from ..kernel import assets, boundary
    from ..streaming import blob_response

    a = boundary.job_sample(db, boundary.worker_job(db, job_id, workerId))
    return blob_response(assets.store_of(a.path), assets.asset_key(a), "application/octet-stream", request)


@router.get("/boundary/jobs/{job_id}/source", dependencies=[Depends(_auth)])
def boundary_source(job_id: str, workerId: str, db: Session = Depends(get_session)):
    from fastapi import Response

    from ..kernel import boundary

    return Response(boundary.job_source(boundary.worker_job(db, job_id, workerId)), media_type="application/x-tar")


@router.put("/boundary/jobs/{job_id}/fixtures/{name}", dependencies=[Depends(_auth)])
async def boundary_fixture(job_id: str, name: str, workerId: str, request: Request, db: Session = Depends(get_session)):
    from ..kernel import boundary

    return boundary.put_fixture(boundary.worker_job(db, job_id, workerId), name, await request.body(), request.headers.get("Content-Type", ""))


@router.put("/boundary/jobs/{job_id}/bundle", dependencies=[Depends(_auth)])
async def boundary_bundle(job_id: str, workerId: str, request: Request, db: Session = Depends(get_session)):
    from ..kernel import boundary

    return boundary.put_bundle(boundary.worker_job(db, job_id, workerId), await request.body())


@router.post("/boundary/jobs/{job_id}/complete", dependencies=[Depends(_auth)])
def boundary_complete(job_id: str, body: dict = Body(...), db: Session = Depends(get_session)):
    from ..kernel import boundary

    j = boundary.complete(db, boundary.worker_job(db, job_id, str(body.get("workerId"))), body.get("result"))
    return {"state": j.state}


@router.post("/boundary/jobs/{job_id}/fail", dependencies=[Depends(_auth)])
def boundary_fail(job_id: str, body: dict = Body(...), db: Session = Depends(get_session)):
    from ..kernel import boundary

    j = boundary.fail(db, boundary.worker_job(db, job_id, str(body.get("workerId"))), str(body.get("errorClass") or "Other"), bool(body.get("recoverable", False)))
    return {"state": j.state}



# ---- Worker capabilities (todo19 D10): which converters each worker has, with a TTL.

workers_router = APIRouter(prefix="/api/v1/workers")


@workers_router.post("/capabilities", dependencies=[Depends(_auth)])
def report_capabilities(body: dict = Body(...), db: Session = Depends(get_session)):
    from ..kernel import capabilities

    caps = body.get("capabilities") if isinstance(body.get("capabilities"), dict) else {}
    requeued = capabilities.report(db, str(body.get("workerId") or "worker"), caps, ttl_s=int(body.get("ttlS") or capabilities.TTL_S))
    db.commit()
    return {"requeued": requeued, "kinds": capabilities.kinds_for(caps)}


@workers_router.get("/capabilities", dependencies=[Depends(_auth)])
def list_capabilities(db: Session = Depends(get_session)):
    from ..kernel import capabilities

    return {"capabilities": capabilities.live(db)}
