"""Job API (docs/plugins.md §6): enqueue, progress, cancel, retry, idempotency, cost.

Workers claim over HTTP; which job a claim picks is the JobQueue's business (`queue.py`:
the DB scan, or a Redis ready list). Leases expire, so a worker that dies mid-job doesn't
strand it; attempts are bounded. Finishing a job (validating and committing its output) is
the gateway's job, not the worker's.
"""

from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session
from studio_observability import traceparent as current_traceparent

from ..context import RequestContext
from ..models import PluginJob
from . import audit, queue

TERMINAL = {"succeeded", "failed", "cancelled"}


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
        "correlationId": j.correlation_id,
        "createdAt": j.created_at.isoformat(),
        "updatedAt": j.updated_at.isoformat() if j.updated_at else None,
    }


def enqueue(db: Session, ctx: RequestContext, *, plugin_id: str, version: str, tool: str, input: dict, capability: str | None, provider: str | None, estimated_cost_usd: float, timeout_s: int) -> tuple[PluginJob, bool]:
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
        task_id=ctx.task_id,
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
    j = get(db, ctx, job_id)
    if j.state not in TERMINAL:
        j.state, j.message = "cancelled", "cancelled by " + ctx.principal
        audit.record(db, ctx, "jobs.cancel", target=job_id)
    return j


def retry(db: Session, ctx: RequestContext, job_id: str) -> PluginJob:
    j = get(db, ctx, job_id)
    if j.state != "failed" or not j.recoverable:
        raise HTTPException(409, f"job is {j.state}{'' if j.recoverable else ' (not recoverable)'}")
    j.state, j.error, j.progress, j.attempts = "queued", None, 0.0, 0
    audit.record(db, ctx, "jobs.retry", target=job_id)
    queue.notify(db, j)
    return j


# ---- Worker side ---------------------------------------------------------------------------


def claim(db: Session, worker_id: str, plugin_ids: list[str] | None = None) -> PluginJob | None:
    """Oldest queued job, or a running one whose lease expired (its worker died)."""
    return queue.backend().claim(db, worker_id, plugin_ids)


def release(db: Session, job_id: str, worker_id: str) -> PluginJob:
    """A worker shutting down hands its job back: queued again, the attempt not counted."""
    j = _owned(db, job_id, worker_id)
    j.state, j.worker_id, j.lease_until, j.progress = "queued", None, None, 0.0
    j.attempts = max(0, j.attempts - 1)
    queue.notify(db, j)
    return j


def progress(db: Session, job_id: str, worker_id: str, value: float, message: str | None = None) -> PluginJob:
    j = _owned(db, job_id, worker_id)
    j.progress = max(0.0, min(1.0, value))
    j.message = message
    return j


def fail(db: Session, job_id: str, worker_id: str, error: str, recoverable: bool = True) -> PluginJob:
    j = _owned(db, job_id, worker_id)
    j.state, j.error, j.recoverable = "failed", error[:4000], recoverable
    return j


def _owned(db: Session, job_id: str, worker_id: str) -> PluginJob:
    j = db.get(PluginJob, job_id)
    if j is None or j.worker_id != worker_id:
        raise HTTPException(404, "job not leased by this worker")
    if j.state == "cancelled":
        raise HTTPException(409, "job was cancelled")
    if j.state != "running":
        raise HTTPException(409, f"job is {j.state}")
    return j
