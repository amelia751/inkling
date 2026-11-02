"""todo16 Milestone 1: delete and recover everything (docs: todo/todo16.md §2 D2-D6).

    GET    /api/v1/projects/{pid}/trash?kind=all|sources|datasets|collections|studios&cursor=
    POST   /api/v1/projects/{pid}/trash/{batchId}/restore     { batchIds? } → { restored, relocatedToRoot }
    DELETE /api/v1/projects/{pid}/trash/{batchId}             destroy (owners) → { purged }
    POST   /api/v1/projects/{pid}/trash/empty?kind=all|sources  → { purged, keptBytes, byKind }
    GET    /api/v1/projects/{pid}/trash/empty/preview         the same, without doing it
    GET    /api/v1/projects/{pid}/trash/impact?nodeIds=a,b    a file delete's { items, files, datasetsLosingItems }
    PATCH  /api/v1/projects/{pid}/datasets/{id}               { name?, description? }
    DELETE /api/v1/projects/{pid}/datasets/{id}?dryRun=       { impact } | { batchId, impact }
    PATCH|DELETE /api/v1/projects/{pid}/collections/{id}      the same
    PATCH|DELETE /api/v1/projects/{pid}/studios/{taskId}      the same
    DELETE /api/v1/projects/{pid}?dryRun=                     to Deleted projects (owners)
    POST   /api/v1/projects/{pid}/restore                     back from Deleted projects
    GET    /api/v1/org/deleted-projects                       { projects }
    DELETE /api/v1/org/deleted-projects/{pid}                 forever (owners / org admins)
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.orm import Session

from ..context import RequestContext, get_context
from ..db import get_session
from ..kernel import names, projects, trash, turns
from ..models import DatasetCollectionRow, DatasetRow, ProjectRow, TaskRow

router = APIRouter(prefix="/api/v1")

KIND_MODEL: dict[str, Any] = {"datasets": ("dataset", DatasetRow), "collections": ("collection", DatasetCollectionRow), "studios": ("studio", TaskRow)}


def _row(db: Session, p: ProjectRow, what: str, id_: str) -> tuple[str, Any]:
    kind, model = KIND_MODEL[what]
    r = db.get(model, id_)
    if r is None or r.project_id != p.id:
        raise HTTPException(404, f"no such {kind}")
    return kind, r


@router.get("/projects/{project_id}/trash")
def list_trash(project_id: str, kind: str = "all", cursor: str | None = None, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    projects.ensure_seeds_once(db)
    return trash.page(db, projects.require_project(db, ctx, project_id), kind, cursor)


@router.post("/projects/{project_id}/trash/empty")
def empty(project_id: str, kind: str = "all", ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = trash.require_trash(db, ctx, project_id)
    return trash.empty(db, ctx, p, kind=kind)


@router.get("/projects/{project_id}/trash/empty/preview")
def empty_preview(project_id: str, kind: str = "all", ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = trash.require_trash(db, ctx, project_id)
    return trash.empty(db, ctx, p, dry_run=True, kind=kind)


@router.get("/projects/{project_id}/trash/impact")
def file_impact(project_id: str, nodeIds: str = "", ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):  # noqa: N803
    p = projects.require_project(db, ctx, project_id)
    ids = [x for x in nodeIds.split(",") if x.strip()]
    if not ids:
        raise HTTPException(422, "nodeIds lists at least one file or folder")
    return {"impact": trash.file_impact(db, p, [x.strip() for x in ids])}


@router.post("/projects/{project_id}/trash/{batch_id}/restore")
def restore(project_id: str, batch_id: str, body: dict | None = Body(default=None), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """`{ batchIds? }` restores those batches too, in this one request and transaction
    (todo18 B: a dataset's "Restore files" with several batches)."""
    p = trash.require_trash(db, ctx, project_id)
    more = (body or {}).get("batchIds") or []
    if not isinstance(more, list) or not all(isinstance(x, str) for x in more):
        raise HTTPException(422, "batchIds lists batch ids")
    return trash.restore_many(db, ctx, p, [batch_id, *more])


@router.delete("/projects/{project_id}/trash/{batch_id}")
def destroy(project_id: str, batch_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = trash.require_trash(db, ctx, project_id)
    trash.require_destroy(db, ctx, p, "trash.destroy", [batch_id])
    return trash.destroy(db, ctx, p, batch_id)


def _patch(db: Session, ctx: RequestContext, project_id: str, what: str, id_: str, body: dict) -> dict:
    p = trash.require_trash(db, ctx, project_id)
    kind, r = _row(db, p, what, id_)
    name = body.get("name")
    if name is not None:
        if not isinstance(name, str):
            raise HTTPException(422, "A name is text")
        clean = names.clean(name)
        if kind == "collection":
            r.name = clean
        else:
            r.title = clean
    desc = body.get("description")
    if desc is not None:
        if kind != "dataset" or not isinstance(desc, str):
            raise HTTPException(422, "only a dataset has a description")
        r.description = desc[:10000]
    db.flush()
    return {"kind": kind, "id": r.id, "name": trash._name(r), "description": getattr(r, "description", None)}


def _delete(db: Session, ctx: RequestContext, project_id: str, what: str, id_: str, dry_run: bool) -> dict:
    p = trash.require_trash(db, ctx, project_id)
    kind, r = _row(db, p, what, id_)
    if dry_run:
        return {"impact": trash.impact(db, kind, r)}
    return trash.trash(db, ctx, p, kind, r)


@router.patch("/projects/{project_id}/datasets/{item_id}")
def patch_dataset(project_id: str, item_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return _patch(db, ctx, project_id, "datasets", item_id, body)


@router.delete("/projects/{project_id}/datasets/{item_id}")
def delete_dataset(project_id: str, item_id: str, dryRun: bool = False, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):  # noqa: N803
    return _delete(db, ctx, project_id, "datasets", item_id, dryRun)


@router.patch("/projects/{project_id}/collections/{item_id}")
def patch_collection(project_id: str, item_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return _patch(db, ctx, project_id, "collections", item_id, body)


@router.delete("/projects/{project_id}/collections/{item_id}")
def delete_collection(project_id: str, item_id: str, dryRun: bool = False, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):  # noqa: N803
    return _delete(db, ctx, project_id, "collections", item_id, dryRun)


@router.patch("/projects/{project_id}/studios/{item_id}")
def patch_studio(project_id: str, item_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return _patch(db, ctx, project_id, "studios", item_id, body)


@router.delete("/projects/{project_id}/studios/{item_id}")
def delete_studio(project_id: str, item_id: str, dryRun: bool = False, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):  # noqa: N803
    return _delete(db, ctx, project_id, "studios", item_id, dryRun)


@router.delete("/projects/{project_id}")
def delete_project(project_id: str, dryRun: bool = False, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):  # noqa: N803
    p = trash.require_trash(db, ctx, project_id)
    if dryRun:
        return {"impact": trash.impact(db, "project", p)}
    return trash.trash_project(db, ctx, p)


@router.post("/projects/{project_id}/restore")
def restore_project(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = trash.require_trash(db, ctx, project_id, include_trashed=True)
    return trash.restore_project(db, ctx, p)


@router.get("/org/deleted-projects")
def deleted_projects(ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return trash.deleted_projects(db, ctx)


@router.delete("/org/deleted-projects/{project_id}")
def destroy_project(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = trash.require_trash(db, ctx, project_id, include_trashed=True)
    return trash.destroy_project(db, ctx, p)


# ---- todo16 D9: an assistant turn (kernel/turns.py) --------------------------------------------


@router.get("/projects/{project_id}/turns/{turn_id}")
def get_turn(project_id: str, turn_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return turns.get(db, ctx, projects.require_project(db, ctx, project_id), turn_id)


@router.post("/projects/{project_id}/turns/{turn_id}/undo")
def undo_turn(project_id: str, turn_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return turns.undo(db, ctx, trash.require_trash(db, ctx, project_id), turn_id)
