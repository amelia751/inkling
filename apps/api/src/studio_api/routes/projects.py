"""Projects, datasets, tasks, resume, activity and live updates (todo6 Phase 1.2).

    GET/POST    /api/v1/projects                     list (with lastActivityAt + resume) / create
    GET/PATCH   /api/v1/projects/{id}
    GET         /api/v1/samples                      {enabled, samples: [{id, title, modality, license, restricted}]} (todo14 D2)
    POST        /api/v1/projects/from-sample         {sampleId, orgId?} → 201, a private copy (the project dict)
    GET         /api/v1/projects/{id}/overview       resume, data cards, attention (blocks omitted when empty)
    GET         /api/v1/projects/{id}/review         the whole review queue (Overview shows its top 5)
    GET/POST    /api/v1/projects/{id}/datasets
    GET         /api/v1/projects/{id}/datasets/{datasetId}         (not /v1/datasets/{id}: versioning has that)
    GET/POST    /api/v1/projects/{id}/datasets/{datasetId}/tasks
    GET         /api/v1/tasks/{id}                   one task
    GET         /api/v1/tasks/{id}/document          a Project-shaped document for the Studio
    GET         /api/v1/tasks/{id}/items?after=      its items, a page at a time (todo11 D8)
    POST        /api/v1/tasks/{id}/items/visible     the items on screen: processed first
    GET/PUT     /api/v1/projects/{id}/resume
    GET         /api/v1/projects/{id}/activity
    GET         /api/v1/projects/{id}/events         SSE: import.updated, source.node.inspected, proposal.*, item.*

Membership comes from the request context (the principal, or the person an agent acts for),
never from a body.
"""

from __future__ import annotations

import asyncio
import json
import unicodedata

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..context import RequestContext, get_context
from ..db import get_session, session_scope
from ..kernel import dataset_profile, datasets_views, events, intents, overview, projects, samples, tree, write_doors
from ..kernel import rules as krules
from ..kernel.admission import Ctx, admit
from ..kernel.admission.http import WriteParams, declares, write_params
from ..kernel.admission.problem import with_findings
from ..models import DatasetRow, PluginEvent, TaskRow

router = APIRouter(prefix="/api/v1")


@router.get("/projects")
def list_projects(q: str | None = None, sort: str = "recent", archived: bool = False, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return {"projects": projects.list_projects(db, ctx, q, sort, archived)}


@router.post("/projects", status_code=201, openapi_extra=declares(write_doors.PROJECTS_CREATE.id))
def create_project(body: dict = Body(...), w: WriteParams = Depends(write_params), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """`{title, description?, visibility?, preset?}`; with a preset the project starts with that
    preset's rules (todo17 D3, revision 1)."""

    def run() -> dict:
        v = admit(write_doors.PROJECTS_CREATE, {"title": str(body.get("title") or ""), "description": str(body.get("description") or "")}, Ctx(principal=ctx.principal, rules={})).value
        p = projects.create_project(db, ctx, v["title"], v["description"], str(body.get("visibility") or "private"))
        if isinstance(body.get("preset"), str):
            krules.seed_from_preset(db, p, body["preset"], projects.person(ctx))
        return projects.project_dict(db, ctx, p)

    if w.dry_run:
        return write_doors.dry_run_reply(db, run())
    return write_doors.idempotent(db, ctx, w, write_doors.PROJECTS_CREATE, body, run, status=201)


@router.get("/samples")
def list_samples(ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """The sample templates a person may copy (todo14 §4.3): `status: available`, restricted
    ones only in dev. `enabled: false` and no samples when API_SAMPLES_ENABLED=0."""
    return samples.list_samples(db)


@router.post("/projects/from-sample", status_code=201)
def project_from_sample(body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """A private copy of a sample in the caller's organization (todo14 D2): 404 for an unknown,
    unavailable or (outside dev) restricted sample, or when samples are off; 403 for agents."""
    sample_id = body.get("sampleId")
    org_id = body.get("orgId")
    if not isinstance(sample_id, str) or not sample_id:
        raise HTTPException(422, "sampleId is required")
    if org_id is not None and not isinstance(org_id, str):
        raise HTTPException(422, "orgId must be a string")
    p = samples.copy_sample(db, ctx, sample_id, org_id)
    return projects.project_dict(db, ctx, p)


@router.get("/projects/{project_id}")
def get_project(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    projects.ensure_seeds_once(db)
    return projects.project_dict(db, ctx, projects.require_project(db, ctx, project_id))


@router.patch("/projects/{project_id}")
def patch_project(project_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    if ctx.scopes:
        raise HTTPException(403, "only people change a project's details")
    p = projects.require_project(db, ctx, project_id, write=True)
    return projects.project_dict(db, ctx, projects.patch_project(db, ctx, p, body))


@router.get("/projects/{project_id}/overview")
def project_overview(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    projects.ensure_seeds_once(db)
    return overview.overview(db, ctx, projects.require_project(db, ctx, project_id))


@router.get("/projects/{project_id}/review")
def project_review(project_id: str, type: str | None = None, severity: str | None = None, dataset: str | None = None, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """The whole queue, filtered by type, severity and dataset; `facets` counts the unfiltered
    queue for the filter controls. The Overview's attention block is its first five rows."""
    projects.ensure_seeds_once(db)
    p = projects.require_project(db, ctx, project_id)
    if type is not None and type not in overview.QUEUE_TYPES:
        raise HTTPException(422, f"type is one of {', '.join(overview.QUEUE_TYPES)}")
    if severity is not None and severity not in overview.SEVERITY:
        raise HTTPException(422, "severity is high, medium or low")
    everything = overview.review_queue(db, p)
    items = overview.filter_queue(everything, type, severity, dataset)
    return {"items": items, "total": len(everything), "facets": overview.review_facets(db, p, everything)}


# ---- Datasets and tasks ------------------------------------------------------------------------


@router.get("/projects/{project_id}/datasets")
def list_datasets(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = projects.require_project(db, ctx, project_id)
    return {"datasets": [projects.dataset_dict(db, d) for d in db.scalars(select(DatasetRow).where(DatasetRow.project_id == p.id).order_by(DatasetRow.created_at))]}


@router.post("/projects/{project_id}/datasets", status_code=201, openapi_extra=declares(write_doors.DATASETS_CREATE.id))
def create_dataset(project_id: str, body: dict = Body(...), w: WriteParams = Depends(write_params), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """The simple form (pick folders, pick a preset); the guided path is confirming a proposal.

    todo17: name and metadata (`metadata: {modality, license, source}`, `description`) run the
    datasets rules (dataset.metadata-missing, dataset.name-taken, dataset.mixed-modality); an
    enforced error is a 422 listing every violation, the rest come back as `findings`."""
    if ctx.scopes:
        raise HTTPException(403, "only people create datasets; the assistant can propose one")
    p = projects.require_project(db, ctx, project_id, write=True)
    title = unicodedata.normalize("NFC", str(body.get("title") or "")).strip()
    description = unicodedata.normalize("NFC", str(body.get("description") or "")).strip()
    node_ids = [str(x) for x in body.get("nodeIds") or []] if isinstance(body.get("nodeIds"), list) else []
    meta = write_doors.metadata_of(body, description=description)
    admitted = write_doors.check_dataset(db, ctx, p, write_doors.DATASETS_CREATE, title, meta, write_doors.modalities(db, node_ids, meta), dry_run=w.dry_run)

    def run() -> dict:
        d = projects.create_dataset(db, ctx, p, title, {"nodeIds": body.get("nodeIds") or [], "metadata": admitted.value["dataset"]["metadata"]}, description)
        task = body.get("task")
        if isinstance(task, dict):
            env = task.get("environment") or ({"extends": task["preset"]} if task.get("preset") else None)
            accepts = None
            if env is None:
                # todo20 D6: no preset chosen → a Studio accepting every kind in the picked
                # folders, each kind with its profile's preset (todo19 D4, as the drop plan boots).
                kinds = list(dict.fromkeys(n.detected_kind for n in tree.files_under(db, node_ids) if n.detected_kind))
                pairs = [(k, pr) for k in kinds if (pr := intents.preset_for_kind(k))]
                if pairs:
                    presets = list(dict.fromkeys(pr for _, pr in pairs))
                    env, accepts = {"extends": presets[0] if len(presets) == 1 else presets}, [k for k, _ in pairs]
            t = projects.create_task(db, ctx, d, str(task.get("title") or "Studio"), str(task.get("kind") or "annotate"), env)
            if accepts:
                t.accepts = accepts
        return with_findings(projects.dataset_dict(db, d), admitted)

    if w.dry_run:
        return write_doors.dry_run_reply(db, run(), admitted)
    return write_doors.idempotent(db, ctx, w, write_doors.DATASETS_CREATE, {"project": p.id, **body}, run, status=201)


def _dataset(db: Session, ctx: RequestContext, project_id: str, dataset_id: str) -> DatasetRow:
    d, p = projects.require_dataset(db, ctx, dataset_id)
    if p.id != project_id:
        raise HTTPException(404, "no such dataset in this project")
    return d


@router.get("/projects/{project_id}/datasets/{dataset_id}")
def get_dataset(project_id: str, dataset_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return projects.dataset_dict(db, _dataset(db, ctx, project_id, dataset_id))


@router.get("/projects/{project_id}/datasets/{dataset_id}/profile")
def get_dataset_profile(project_id: str, dataset_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """What the dataset holds and how it is shaped (docs/datasets.md §11.1): collections, fields,
    formats, relationships and issues, from inspection. Counts and technical facts only."""
    d = _dataset(db, ctx, project_id, dataset_id)
    return datasets_views.overlay_collections(d, dataset_profile.build(db, d))


@router.get("/projects/{project_id}/datasets/{dataset_id}/tasks")
def list_tasks(project_id: str, dataset_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    d = _dataset(db, ctx, project_id, dataset_id)
    rows = db.scalars(select(TaskRow).where(TaskRow.dataset_id == d.id).order_by(TaskRow.created_at))
    return {"tasks": [projects.task_dict(db, t) for t in rows if t.state != "preview"]}  # previews: GET …/previews


@router.post("/projects/{project_id}/datasets/{dataset_id}/tasks", status_code=201)
def create_task(project_id: str, dataset_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    if ctx.scopes:
        raise HTTPException(403, "only people create tasks; the assistant can propose one")
    d = _dataset(db, ctx, project_id, dataset_id)
    projects.require_project(db, ctx, d.project_id, write=True)
    env = body.get("environment") or ({"extends": body["preset"]} if body.get("preset") else None)
    return projects.task_dict(db, projects.create_task(db, ctx, d, str(body.get("title") or ""), str(body.get("kind") or "annotate"), env))


def _gone_if_trashed(db: Session, ctx: RequestContext, task_id: str) -> None:
    """todo18: a Studio in Trash answers 410 with the batch that restores it (not a bare 404),
    so the web can say "moved to Trash" and link there."""
    from ..kernel import trash
    from ..models import INCLUDE_TRASHED, TaskRow

    t = db.get(TaskRow, task_id, execution_options=INCLUDE_TRASHED)
    if t is None:
        return
    batch = trash.dataset_trash_batch(db, t)
    if t.trashed_at is None and batch is None:
        return
    batch = batch or t.trash_batch_id
    projects.require_project(db, ctx, t.project_id)
    raise HTTPException(410, {"code": "trashed", "message": "This Studio is in Trash", "trashBatchId": batch, "projectId": t.project_id})


@router.get("/tasks/{task_id}")
def get_task(task_id: str, includeTrashed: bool = False, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):  # noqa: N803
    """`includeTrashed=true` (the Studio page): a Studio in Trash with its dataset still answers, with
    `trashed: true` and the batch that restores it, so the page can offer Restore (todo16)."""
    projects.ensure_seeds_once(db)
    if includeTrashed:
        from ..kernel import trash
        from ..models import INCLUDE_TRASHED, TaskRow

        t = db.get(TaskRow, task_id, execution_options=INCLUDE_TRASHED)
        if t is not None and t.trashed_at is not None:
            projects.require_project(db, ctx, t.project_id)
            return {**projects.task_dict(db, t), "trashed": True, "datasetTrashed": True, "datasetTrashBatchId": trash.dataset_trash_batch(db, t) or t.trash_batch_id}
    else:
        _gone_if_trashed(db, ctx, task_id)
    t, _ = projects.require_task(db, ctx, task_id)
    return projects.task_dict(db, t)


@router.get("/tasks/{task_id}/document")
def task_document(task_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    projects.ensure_seeds_once(db)
    _gone_if_trashed(db, ctx, task_id)
    t, _ = projects.require_task(db, ctx, task_id)
    return projects.task_document(db, t)


@router.get("/tasks/{task_id}/items")
def task_items(task_id: str, after: str | None = None, limit: int = 200, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """The task document's items, a page at a time (todo11 D8): with `item.*` events, the
    Studio inserts and upgrades items instead of refetching the document."""
    from ..kernel import ingest

    projects.ensure_seeds_once(db)
    t, _ = projects.require_task(db, ctx, task_id)
    return ingest.page(projects.task_document(db, t)["assets"], after, limit)


@router.post("/tasks/{task_id}/items/visible")
def visible_items(task_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """The items on screen: workers process them first (a hint; the latest one wins)."""
    from ..kernel import ingest

    t, _ = projects.require_task(db, ctx, task_id)
    ids = body.get("itemIds")
    if not isinstance(ids, list):
        raise HTTPException(422, "itemIds must be a list")
    return {"prioritised": ingest.set_visible(db, t, ids)}


# ---- Resume and activity -----------------------------------------------------------------------


@router.get("/projects/{project_id}/resume")
def get_resume(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return {"resume": projects.get_resume(db, ctx, projects.require_project(db, ctx, project_id))}


@router.put("/projects/{project_id}/resume")
def put_resume(project_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return {"resume": projects.put_resume(db, ctx, projects.require_project(db, ctx, project_id), body)}


@router.get("/projects/{project_id}/activity")
def project_activity(project_id: str, cursor: int | None = None, limit: int = 100, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return overview.activity(db, projects.require_project(db, ctx, project_id), cursor, max(1, min(limit, 500)))


# ---- Live updates ------------------------------------------------------------------------------

# Polling the outbox 4×/s keeps a change visible in other tabs well inside 1 s (todo7 Phase 9:
# at 1 s a rename took ~1 s to show); keep-alives go out every SSE_KEEPALIVE_S only.
SSE_POLL_S = 0.25
SSE_KEEPALIVE_S = 15.0
SSE_MAX_S = 300.0


@router.get("/projects/{project_id}/events")
async def project_events(project_id: str, request: Request, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """Server-sent events for a project. The stream reads the outbox (the same table every
    replica writes), so it works behind any replica and keeps nothing in process memory; the
    browser reconnects after `SSE_MAX_S` with `Last-Event-ID`, and invalidates its queries."""
    p = projects.require_project(db, ctx, project_id)
    last = request.headers.get("Last-Event-ID") or request.query_params.get("after")
    db.close()

    types = sorted(events.PROJECT_EVENTS - {"source.uploaded", "archive.unpack.requested"})

    def newest() -> str | None:
        with session_scope() as s:
            return s.scalar(select(PluginEvent.event_id).where(PluginEvent.workspace_id == p.id).order_by(PluginEvent.created_at.desc()).limit(1))

    def after(cursor: str | None) -> list[tuple[str, str, dict]]:
        with session_scope() as s:
            q = select(PluginEvent).where(PluginEvent.workspace_id == p.id, PluginEvent.type.in_(types))
            cut = s.get(PluginEvent, cursor) if cursor else None
            if cut is not None:
                # `>=`: events in the same millisecond aren't lost; a repeat only re-invalidates.
                q = q.where(PluginEvent.created_at >= cut.created_at, PluginEvent.event_id != cut.event_id)
            return [(e.event_id, e.type, e.payload) for e in s.scalars(q.order_by(PluginEvent.created_at).limit(200))]

    async def stream():
        cursor = last or newest()
        yield "retry: 3000\n\n"
        waited = quiet = 0.0
        while waited < SSE_MAX_S and not await request.is_disconnected():
            for eid, kind, payload in after(cursor):
                cursor = eid
                quiet = 0.0
                yield f"id: {eid}\nevent: {kind}\ndata: {json.dumps(payload)}\n\n"
            await asyncio.sleep(SSE_POLL_S)
            waited += SSE_POLL_S
            quiet += SSE_POLL_S
            if quiet >= SSE_KEEPALIVE_S:
                quiet = 0.0
                yield ": keep-alive\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})
