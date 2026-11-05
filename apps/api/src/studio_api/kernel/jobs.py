"""Job API (docs/plugins.md §6): enqueue, progress, cancel, retry, idempotency, cost.

Workers claim over HTTP; which job a claim picks is the JobQueue's business (`queue.py`:
the DB scan, or a Redis ready list). Leases expire, so a worker that dies mid-job doesn't
strand it; attempts are bounded. Finishing a job (validating and committing its output) is
the gateway's job, not the worker's.

Leases and fencing (todo12 §4 M0 items 1-2, docs/pipeline.md §10.3). The attempt number a
claim hands out is the fencing token: every progress, complete, fail and release call names
it, and the kernel locks the job row and accepts the call only from the worker holding the
current, unexpired lease of that attempt. Anything else is a 409 (lease lost, cancelled, or
already finished), so a worker that lost its lease mid-job can never report a stale result
over its replacement's. The progress call is the heartbeat: it renews the lease. Cancelling
a running job makes its next heartbeat a 409, and the worker kills the job's process group.

`settle` is the single terminal hook: it frees the job's resource lease and publishes
`job.succeeded` / `job.failed` with the service contract payload (todo12 §5).
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session
from studio_observability import traceparent as current_traceparent

from ..context import RequestContext
from ..models import PluginJob
from . import audit, queue

TERMINAL = {"succeeded", "failed", "cancelled"}
# docs/pipeline.md §12, plus `cancelled`. Only service jobs are retried by the kernel itself
# (E2: the kernel is the one retry owner of a pipeline step), and only for these classes.
ERROR_CLASSES = frozenset({"transient", "rate_limited", "worker_crash", "invalid_input", "schema_incompatible", "user_code_error", "policy_denied", "resource_exceeded", "permanent_dependency", "cancelled"})
RETRYABLE = frozenset({"transient", "rate_limited", "worker_crash"})


def job_dict(j: PluginJob) -> dict:
    return {
        "jobId": j.job_id,
        "pluginId": j.plugin_id,
        "version": j.version,
        "capability": j.capability,
        "tool": j.tool,
        "provider": j.provider,
        "state": j.state,
        "progress": j.progress,
        "message": j.message,
        "result": j.result,
        "error": j.error,
        "recoverable": j.recoverable,
        "estimatedCostUsd": j.estimated_cost_usd,
        "costUsd": j.cost_usd,
        "attempts": j.attempts,
        "resourceClass": j.resource_class,
        "errorClass": j.error_class,
        "correlationId": j.correlation_id,
        "createdAt": j.created_at.isoformat(),
        "updatedAt": j.updated_at.isoformat() if j.updated_at else None,
    }


def _task_of_input(db: Session, project_id: str, input: dict) -> str | None:
    """A job started outside a Studio (the project's chat) commits its suggestions to the newest
    Studio whose dataset holds the input's file, so that Studio shows them."""
    from ..models import DatasetRow, SourceNode, TaskRow

    asset_id = input.get("asset_id") if isinstance(input, dict) else None
    if not isinstance(asset_id, str):
        return None
    node = db.scalar(select(SourceNode.id).where(SourceNode.project_id == project_id, SourceNode.asset_id == asset_id).limit(1))
    if node is None:
        return None
    for t in db.scalars(select(TaskRow).where(TaskRow.project_id == project_id, TaskRow.trashed_at.is_(None)).order_by(TaskRow.created_at.desc())):
        ds = db.get(DatasetRow, t.dataset_id) if t.dataset_id else None
        if ds is not None and any(isinstance(r, dict) and r.get("nodeId") == node for r in (ds.definition or {}).get("files") or []):
            return t.id
    return None


def enqueue(db: Session, ctx: RequestContext, *, plugin_id: str, version: str, tool: str, input: dict, capability: str | None, provider: str | None, estimated_cost_usd: float, timeout_s: int, resource_class: str = "cpu") -> tuple[PluginJob, bool]:
    """Returns (job, created). The same idempotency key returns the existing job (§14 #7)."""
    if ctx.idempotency_key:
        prior = db.scalar(select(PluginJob).where(PluginJob.workspace_id == ctx.workspace_id, PluginJob.idempotency_key == ctx.idempotency_key))
        if prior is not None:
            return prior, False
    j = PluginJob(
        workspace_id=ctx.workspace_id,
        plugin_id=plugin_id,
        version=version,
        tool=tool,
        input=input,
        capability=capability,
        provider=provider,
        state="queued",
        estimated_cost_usd=estimated_cost_usd,
        idempotency_key=ctx.idempotency_key,
        correlation_id=ctx.correlation_id,
        principal=ctx.principal,
        timeout_s=timeout_s,
        traceparent=current_traceparent(),
        task_id=ctx.task_id or _task_of_input(db, ctx.workspace_id, input),
        resource_class=resource_class,
    )
    db.add(j)
    db.flush()
    queue.notify(db, j)
    audit.record(db, ctx, "jobs.enqueue", target=j.job_id, after={"plugin": plugin_id, "version": version, "tool": tool, "provider": provider, "estimatedCostUsd": estimated_cost_usd})
    return j, True


def get(db: Session, ctx: RequestContext, job_id: str) -> PluginJob:
    j = db.get(PluginJob, job_id)
    if j is None or j.workspace_id != ctx.workspace_id:
        raise HTTPException(404, "no such job in this workspace")
    return j


def list_jobs(db: Session, ctx: RequestContext, state: str | None = None, limit: int = 100) -> list[dict]:
    q = select(PluginJob).where(PluginJob.workspace_id == ctx.workspace_id)
    if state:
        q = q.where(PluginJob.state == state)
    return [job_dict(j) for j in db.scalars(q.order_by(PluginJob.created_at.desc()).limit(limit))]


def cancel(db: Session, ctx: RequestContext, job_id: str) -> PluginJob:
    """A running job's worker learns it at its next heartbeat (409) and kills the process group."""
    j = get(db, ctx, job_id)
    if j.state not in TERMINAL:
        j.state, j.message = "cancelled", "cancelled by " + ctx.principal
        audit.record(db, ctx, "jobs.cancel", target=job_id)
        settle(db, j, "cancelled")
    return j


def event_payload(j: PluginJob) -> dict:
    """`job.succeeded|failed` (todo12 §5): {job_id, workspace_id, idempotency_key, attempts,
    result_ref?, error_class?}, plus the older camelCase keys plugins subscribe with."""
    out: dict = {"jobId": j.job_id, "pluginId": j.plugin_id, "job_id": j.job_id, "workspace_id": j.workspace_id, "idempotency_key": j.idempotency_key, "attempts": j.attempts}
    ref = result_ref(j)
    if ref:
        out["result_ref"] = ref
    if j.state != "succeeded":
        out["error_class"] = j.error_class or ("cancelled" if j.state == "cancelled" else "user_code_error")
    return out


def result_ref(j: PluginJob) -> str | None:
    r = j.result if isinstance(j.result, dict) else {}
    ref = r.get("result_ref", r.get("resultRef"))
    return ref if isinstance(ref, str) else None


def settle(db: Session, j: PluginJob, error_class: str | None = None, *, publish: bool = True) -> None:
    """The job just reached a terminal state: free its resource slot and announce it once."""
    from . import events

    if j.state != "succeeded":
        j.error_class = error_class or j.error_class or ("cancelled" if j.state == "cancelled" else "user_code_error")
    queue.release_resources(db, j.job_id)
    if not publish:
        return
    ctx = RequestContext(j.workspace_id, f"plugin:{j.plugin_id}@{j.version}", j.correlation_id, task_id=j.task_id)
    kind = "job.succeeded" if j.state == "succeeded" else "job.failed"
    events.publish(db, ctx, kind, event_payload(j), source=j.plugin_id, idempotency_key=f"{kind}:{j.job_id}")


def retry(db: Session, ctx: RequestContext, job_id: str) -> PluginJob:
    j = get(db, ctx, job_id)
    if j.state != "failed" or not j.recoverable:
        raise HTTPException(409, f"job is {j.state}{'' if j.recoverable else ' (not recoverable)'}")
    j.state, j.error, j.progress, j.attempts = "queued", None, 0.0, 0
    audit.record(db, ctx, "jobs.retry", target=job_id)
    queue.notify(db, j)
    return j


# ---- Worker side ---------------------------------------------------------------------------


def claim(db: Session, worker_id: str, plugin_ids: list[str] | None = None, classes: list[str] | None = None, heartbeat: bool = False) -> PluginJob | None:
    """Oldest queued job of these resource classes, or a running one whose lease expired."""
    return queue.backend().claim(db, worker_id, plugin_ids, classes, heartbeat)


def release(db: Session, job_id: str, worker_id: str, attempt: int | None = None) -> PluginJob:
    """A worker shutting down hands its job back: queued again, the attempt not counted."""
    j = _owned(db, job_id, worker_id, attempt)
    j.state, j.worker_id, j.lease_until, j.progress = "queued", None, None, 0.0
    j.attempts = max(0, j.attempts - 1)
    queue.release_resources(db, j.job_id)
    queue.notify(db, j)
    return j


def progress(db: Session, job_id: str, worker_id: str, value: float, message: str | None = None, attempt: int | None = None) -> PluginJob:
    """The heartbeat: records progress and renews the lease of the caller's attempt."""
    j = _owned(db, job_id, worker_id, attempt)
    j.progress = max(0.0, min(1.0, value))
    j.message = message
    queue.renew(db, j, datetime.now(UTC))
    return j


def fail(db: Session, job_id: str, worker_id: str, error: str, recoverable: bool = True, attempt: int | None = None, error_class: str | None = None) -> PluginJob:
    j = _owned(db, job_id, worker_id, attempt)
    cls = error_class if error_class in ERROR_CLASSES and error_class != "cancelled" else "user_code_error"
    if j.principal.startswith("service:") and recoverable and cls in RETRYABLE and j.attempts < j.max_attempts:
        # The kernel retries a service job itself; the pipeline sees only the final outcome.
        j.state, j.worker_id, j.lease_until, j.progress = "queued", None, None, 0.0
        j.error, j.error_class = error[:4000], cls
        queue.release_resources(db, j.job_id)
        queue.notify(db, j)
        return j
    j.state, j.error, j.recoverable = "failed", error[:4000], recoverable
    settle(db, j, cls)
    return j


def _owned(db: Session, job_id: str, worker_id: str, attempt: int | None = None) -> PluginJob:
    """The job, row-locked, if `worker_id` holds its current lease (and `attempt` is that
    lease's attempt). Fencing: anything else is a 409."""
    q = select(PluginJob).where(PluginJob.job_id == job_id)
    if db.get_bind().dialect.name == "postgresql":
        q = q.with_for_update()
    j = db.scalar(q.execution_options(populate_existing=True))
    if j is None:
        raise HTTPException(404, "no such job")
    if j.state == "cancelled":
        raise HTTPException(409, "job was cancelled")
    if j.state != "running":
        raise HTTPException(409, f"job is {j.state}")
    if j.worker_id != worker_id or (attempt is not None and attempt != j.attempts):
        raise HTTPException(409, "lease lost: the job was claimed again")
    lease = j.lease_until if j.lease_until is None or j.lease_until.tzinfo else j.lease_until.replace(tzinfo=UTC)
    if lease is None or lease < datetime.now(UTC):
        raise HTTPException(409, "lease lost: it expired")
    return j
