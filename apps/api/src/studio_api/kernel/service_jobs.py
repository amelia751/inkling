"""Jobs a service principal enqueues (todo12 §5 "Service job routes").

`POST /api/v1/service/jobs {workspace_id, kind, plugin?, input_ref, resource_class,
idempotency_key}`. With `plugin`, the job is that active plugin's tool `kind`, enqueued
through the command gateway exactly as a person's call would be (policy, budget, input
contract), with input `{"inputRef": input_ref}`. Without `plugin`, `kind` names a kernel
job the worker runs itself (`KINDS`). The same idempotency key in the same workspace returns
the same job (200); with a different request it's a 409.

The kernel owns retries for these jobs (E2): a recoverable failure of a retryable class goes
back to the queue until `max_attempts`, and only the final outcome becomes `job.succeeded` /
`job.failed` on the service event feed.
"""

from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..context import RequestContext
from ..models import PluginJob, Workspace
from ..naming import ns
from . import gateway, jobs, queue

PLUGIN = ns("service")
VERSION = "1"
# Kernel job kinds a worker runs without a plugin. `noop` returns its input ref as the result
# ref; `sleep:<seconds>` as the input ref makes it wait first (a stand-in for real work in the
# engine's chaos tests, cancellable like any job).
KINDS: dict[str, int] = {"noop": 600}


def _same(j: PluginJob, kind: str, plugin: str | None, input_ref: str, resource_class: str) -> bool:
    return j.tool == kind and (plugin is None or j.plugin_id == plugin) and (j.input or {}).get("inputRef") == input_ref and j.resource_class == resource_class


def enqueue(db: Session, principal: str, correlation_id: str, body: dict) -> tuple[PluginJob, bool]:
    """→ (job, created)."""
    workspace_id, kind, input_ref, key = (body.get(k) for k in ("workspace_id", "kind", "input_ref", "idempotency_key"))
    plugin = body.get("plugin") or None
    resource_class = body.get("resource_class")
    for name, v in (("workspace_id", workspace_id), ("kind", kind), ("input_ref", input_ref), ("idempotency_key", key)):
        if not isinstance(v, str) or not v:
            raise HTTPException(422, f"{name} is required (a non-empty string)")
    if resource_class not in queue.RESOURCE_CLASSES:
        raise HTTPException(422, f"resource_class must be one of {', '.join(queue.RESOURCE_CLASSES)}")
    if plugin is not None and not isinstance(plugin, str):
        raise HTTPException(422, "plugin must be a string")
    assert isinstance(workspace_id, str) and isinstance(kind, str) and isinstance(input_ref, str) and isinstance(key, str)
    if db.get(Workspace, workspace_id) is None:
        raise HTTPException(404, "no such workspace")
    prior = db.scalar(select(PluginJob).where(PluginJob.workspace_id == workspace_id, PluginJob.idempotency_key == key))
    if prior is not None:
        if prior.principal != principal or not _same(prior, kind, plugin, input_ref, resource_class):
            raise HTTPException(409, "idempotency key already used for a different job")
        return prior, False
    ctx = RequestContext(workspace_id, principal, correlation_id, key)
    if plugin is None:
        if kind not in KINDS:
            raise HTTPException(422, f"unknown kernel job kind {kind!r} (give a plugin, or one of {', '.join(sorted(KINDS))})")
        j, created = jobs.enqueue(db, ctx, plugin_id=PLUGIN, version=VERSION, tool=kind, input={"inputRef": input_ref}, capability=None, provider=None, estimated_cost_usd=0.0, timeout_s=KINDS[kind], resource_class=resource_class)
        return j, created
    status, out = gateway.dispatch(db, ctx, {"tool": f"{plugin}.{kind}", "input": {"inputRef": input_ref}})
    job = out.get("job") if isinstance(out, dict) else None
    if status >= 400 or not job:
        raise HTTPException(status if status >= 400 else 422, out)
    j = db.get(PluginJob, job["jobId"])
    assert j is not None
    if j.plugin_id != plugin:
        raise HTTPException(422, f"{plugin}.{kind} didn't resolve to that plugin")
    # Same transaction as the enqueue: no claimer can see the row before its class is set.
    j.resource_class = resource_class
    return j, True


def status(db: Session, principal: str, job_id: str) -> dict:
    """`{state, attempts, result_ref?, error_class?}`; only jobs this principal enqueued."""
    j = db.get(PluginJob, job_id)
    if j is None or j.principal != principal:
        raise HTTPException(404, "no such job")
    out: dict = {"state": j.state, "attempts": j.attempts}
    ref = jobs.result_ref(j)
    if ref:
        out["result_ref"] = ref
    if j.state in ("failed", "cancelled") and j.error_class:
        out["error_class"] = j.error_class
    return out
