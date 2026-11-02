"""todo16 Milestone 1: delete means "move to Trash", for everything a project owns (D2-D6).

One deletion is one batch (an `fs_batches` row with `resource` = dataset | collection | studio |
project, kind `trash`, so the drive's undo never picks it up). The rows it moved carry its
`trash_batch_id`; restoring the batch clears them all, destroying it deletes them for good.
Trashed rows are hidden from every ORM read by `models._hide_trashed`; this module reads them
with `INCLUDE_TRASHED`. Files (`source_nodes`) keep their own Trash in `kernel/fs.py`; the Trash
listing here shows both.

Files a dataset uses are never trashed with it (D3): they belong to Sources.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from .. import aftercommit, blobstore
from ..auth.audit import record_event
from ..config import settings
from ..context import RequestContext
from ..db import Base
from ..models import (
    INCLUDE_TRASHED,
    AnnotationDocumentRow,
    Asset,
    DatasetCollectionRow,
    DatasetRepo,
    DatasetRow,
    FsBatch,
    ProjectRow,
    SourceNode,
    TaskRow,
    Workspace,
    now,
)
from . import approvals, fs, tree
from .projects import person, project_role, require_project

VIEWER_DENIED = "You can view this project but not delete from it"
KINDS = {"all": None, "sources": "source", "datasets": "dataset", "collections": "collection", "studios": "studio"}
MODELS: dict[str, Any] = {"dataset": DatasetRow, "collection": DatasetCollectionRow, "studio": TaskRow, "project": ProjectRow}
AUDIT = {"trash": "trash.moved", "restore": "trash.restored", "destroy": "trash.destroyed"}


def days() -> int:
    return settings().trash_days


def _utc(d: datetime | None) -> datetime | None:
    return d if d is None or d.tzinfo else d.replace(tzinfo=UTC)


def _iso(d: datetime | None) -> str | None:
    d = _utc(d)
    return d.isoformat().replace("+00:00", "Z") if d else None


def days_left(at: datetime | None) -> int:
    at = _utc(at)
    return max(0, days() - (now() - at).days) if at else days()


def _get(db: Session, model: Any, id_: str) -> Any:
    return db.get(model, id_, execution_options=INCLUDE_TRASHED)


def _name(r: Any) -> str:
    return getattr(r, "name", None) or getattr(r, "title", "") or ""


# ---- Permissions -------------------------------------------------------------------------------


def require_trash(db: Session, ctx: RequestContext, project_id: str, *, include_trashed: bool = False) -> ProjectRow:
    """The project, if the caller may move things to Trash (editors and up): viewers get 403 with
    the sentence the UI shows."""
    if include_trashed:
        p = _get(db, ProjectRow, project_id)
        if p is None:
            raise HTTPException(404, "no such project")
        if p.trashed_at is None:
            return require_trash(db, ctx, project_id)
        # A trashed project: only its owners see it (to restore it).
        if project_role(db, ctx, p) != "owner":
            raise HTTPException(404, "no such project")
        return p
    require_project(db, ctx, project_id)
    try:
        return require_project(db, ctx, project_id, write=True)
    except HTTPException as e:
        if e.status_code == 403:
            raise HTTPException(403, VIEWER_DENIED) from None
        raise


def require_destroy(db: Session, ctx: RequestContext, p: ProjectRow, operation: str, targets: list[str]) -> None:
    """Deleting forever: the project's owners (org admins are owners). An assistant (delegated
    token) also needs the person's signed approval for this operation and these targets
    (`X-Approval-Id`, `approvals.verify`: person, project, expiry, single use)."""
    if project_role(db, ctx, p) != "owner":
        raise HTTPException(403, "Only the project's owners can delete forever")
    approvals.verify(db, ctx, operation=operation, project_id=p.id, targets=targets)


# ---- What a deletion takes with it -------------------------------------------------------------


def _dependents(db: Session, kind: str, row: Any) -> dict[str, list[Any]]:
    """The rows that go to Trash with `row` (D3), by kind, including `row`."""
    out: dict[str, list[Any]] = {"dataset": [], "collection": [], "studio": [], "project": []}
    out[kind].append(row)
    if kind == "dataset":
        out["collection"] += list(db.scalars(select(DatasetCollectionRow).where(DatasetCollectionRow.dataset_id == row.id)))
        out["studio"] += list(db.scalars(select(TaskRow).where(TaskRow.dataset_id == row.id)))
    elif kind == "collection":
        out["studio"] += list(db.scalars(select(TaskRow).where(TaskRow.collection_id == row.id)))
    return out


def _annotation_count(db: Session, project_id: str, task_ids: list[str]) -> int:
    if not task_ids:
        return 0
    docs = db.scalars(select(AnnotationDocumentRow).where(AnnotationDocumentRow.workspace_id == project_id, AnnotationDocumentRow.task_id.in_(task_ids)))
    return sum(len(d.annotations or []) for d in docs)


def impact(db: Session, kind: str, row: Any) -> dict:
    deps = _dependents(db, kind, row)
    items = [{"kind": k, "id": r.id, "name": _name(r)} for k, rows in deps.items() for r in rows]
    files = 0
    if kind == "project":
        files = db.scalar(select(func.count()).select_from(SourceNode).where(SourceNode.project_id == row.id, SourceNode.is_dir.is_(False), SourceNode.trashed_at.is_(None))) or 0
    # Trashing a dataset, collection, Studio or project never takes files out of another dataset
    # (D3: files stay in Sources), so only a file delete fills `datasetsLosingItems`.
    return {"items": items, "files": files, "datasetsLosingItems": []}


# ---- Files a dataset uses (round 2: D3-D5) -----------------------------------------------------


def _dataset_refs(db: Session, d: DatasetRow) -> list[str]:
    """The file node ids a dataset holds (its frozen list, or an older definition's live nodeIds)."""
    definition = d.definition or {}
    refs = definition.get("files")
    if isinstance(refs, list):
        return [str(r["nodeId"]) for r in refs if isinstance(r, dict) and r.get("nodeId")]
    return [n.id for n in tree.files_under(db, [str(x) for x in definition.get("nodeIds") or []])]


def datasets_losing(db: Session, project_id: str, file_ids: set[str]) -> list[dict]:
    """`[{id, name, items}]`: the datasets (not in Trash) holding some of `file_ids`, and how many."""
    out = []
    if not file_ids:
        return out
    for d in db.scalars(select(DatasetRow).where(DatasetRow.project_id == project_id).order_by(DatasetRow.created_at)):
        k = sum(1 for i in _dataset_refs(db, d) if i in file_ids)
        if k:
            out.append({"id": d.id, "name": d.title, "items": k})
    return out


def file_impact(db: Session, p: ProjectRow, node_ids: list[str]) -> dict:
    """What moving files and folders to Trash takes from datasets (`GET …/trash/impact`)."""
    ids = list(dict.fromkeys(str(x) for x in node_ids if x))
    nodes = list(db.scalars(select(SourceNode).where(SourceNode.project_id == p.id, SourceNode.id.in_(ids)))) if ids else []
    if len(nodes) != len(ids):
        raise HTTPException(404, "not in this project: " + ", ".join(sorted(set(ids) - {n.id for n in nodes}))[:300])
    files: set[str] = set()
    for n in nodes:
        files |= {r.id for r in tree.subtree(db, n.id, into_trash=True) if not r.is_dir} if n.is_dir else {n.id}
    return {"items": [{"kind": "source", "id": n.id, "name": n.name} for n in nodes], "files": len(files), "datasetsLosingItems": datasets_losing(db, p.id, files)}


def trashed_files(db: Session, nodes: list[SourceNode]) -> dict[str, str]:
    """node id → the Trash batch that holds it, for the files of `nodes` in Trash (themselves or a
    folder above them). The batch id is what `POST …/trash/{batchId}/restore` takes."""
    ch = tree.chains(db, [n.id for n in nodes])
    holder: dict[str, str] = {}
    for n in nodes:
        c = ch.get(n.id)
        if n.trashed_at is not None:
            holder[n.id] = n.id
        elif c is not None and c.hidden:
            holder[n.id] = next(i for i, t in zip(reversed(c.ids), reversed(c.trashed), strict=True) if t is not None)
    if not holder:
        return {}
    batch = {r.id: r.trash_batch_id or r.id for r in db.scalars(select(SourceNode).where(SourceNode.id.in_(set(holder.values()))))}
    return {nid: batch.get(h, h) for nid, h in holder.items()}


def dataset_trash_facts(db: Session, d: DatasetRow, nodes: list[SourceNode]) -> dict:
    """`filesInTrash`, `filesTrashBatchIds` (the batches to restore them) and `itemCount` (files
    not in Trash) for a dataset response."""
    held = trashed_files(db, nodes)
    return {"filesInTrash": len(held), "filesTrashBatchIds": list(dict.fromkeys(held.values())), "itemCount": len(nodes) - len(held)}


def dataset_trashed(db: Session, t: TaskRow) -> bool:
    d = _get(db, DatasetRow, t.dataset_id)
    return d is None or d.trashed_at is not None


def dataset_trash_batch(db: Session, t: TaskRow) -> str | None:
    """The Trash batch holding a Studio's dataset, so the Studio can offer Restore (None if not trashed)."""
    d = _get(db, DatasetRow, t.dataset_id)
    return d.trash_batch_id if d is not None and d.trashed_at is not None else None


def search_trashed(db: Session, p: ProjectRow, q: str, kind: str | None = None) -> int:
    """How many files in Trash (themselves or inside a trashed folder) match a search."""
    query = select(SourceNode).where(SourceNode.project_id == p.id, SourceNode.parent_id.is_not(None), SourceNode.is_dir.is_(False))
    if q:
        query = query.where(func.lower(SourceNode.name).contains(q.lower()))
    if kind:
        query = query.where(SourceNode.detected_kind == kind)
    rows = list(db.scalars(query.limit(5000)))
    return len(trashed_files(db, rows))


def drop_purged(db: Session, ctx: RequestContext, p: ProjectRow, node_ids: set[str]) -> list[dict]:
    """Files deleted forever leave every dataset that held them. The dataset's definition loses
    them, and a versioned dataset commits their removal as a new version on the purger's work
    branch (`main` is protected: it reaches main through the usual review), so its history still
    has them (D5). `[{id, name, items, commitOid}]`."""
    out: list[dict] = []
    if not node_ids:
        return out
    from .versioning import configured, run
    from .versioning.studio import sample_id

    for d in db.scalars(select(DatasetRow).where(DatasetRow.project_id == p.id).execution_options(**INCLUDE_TRASHED)):
        definition = dict(d.definition or {})
        refs = definition.get("files")
        if not isinstance(refs, list):
            continue
        gone = [r for r in refs if isinstance(r, dict) and str(r.get("nodeId")) in node_ids]
        if not gone:
            continue
        definition["files"] = [r for r in refs if r not in gone]
        for key in ("nodeIds", "followedFolders", "heldNodeIds"):
            if isinstance(definition.get(key), list):
                definition[key] = [i for i in definition[key] if str(i) not in node_ids]
        d.definition = definition
        oid = None
        if configured() and db.get(DatasetRepo, (p.id, d.id)) is not None:
            aids = [str(r["assetId"]) for r in gone if r.get("assetId")]
            paths = list(db.scalars(select(Asset.path).where(Asset.id.in_(aids)))) if aids else []
            body = {"message": f"Removed {len(gone)} {'file' if len(gone) == 1 else 'files'} deleted forever", "changes": {"remove_samples": [sample_id(x) for x in paths]}}
            vctx = ctx.for_scope(p.id, None)
            status, res = run(db, vctx, "branch", d.id, {})
            if status < 300:
                status, res = run(db, vctx, "commit", d.id, body)
            oid = res.get("commit_oid") if status < 300 else None
        record_event(db, org_id=p.org_id, actor=ctx.principal, on_behalf_of=ctx.on_behalf_of, action="dataset.files_purged", target=d.id, detail={"projectId": p.id, "files": len(gone), "commitOid": oid})
        out.append({"id": d.id, "name": d.title, "items": len(gone), "commitOid": oid})
    db.flush()
    return out


# ---- Trash, restore, destroy -------------------------------------------------------------------


def trash(db: Session, ctx: RequestContext, p: ProjectRow, kind: str, row: Any) -> dict:
    """Move `row` and its dependents to Trash in one batch."""
    deps = _dependents(db, kind, row)
    out = impact(db, kind, row)
    batch = "bat-" + uuid.uuid4().hex
    at = now()
    who = person(ctx)
    for rows in deps.values():
        for r in rows:
            if r.trashed_at is None:
                r.trashed_at, r.trashed_by, r.trash_batch_id = at, who, batch
    db.add(FsBatch(id=batch, project_id=p.id, actor=ctx.principal, kind="trash", resource=kind, label=_name(row)[:256], summary=f"Deleted {kind} {_name(row)}"[:2000], undoable=False, on_behalf_of=ctx.on_behalf_of, turn_id=ctx.turn_id, at=at))
    db.flush()
    _audit(db, ctx, p, "trash", kind, row.id, batch, out)
    return {"batchId": batch, "impact": out}


def _batch(db: Session, p: ProjectRow, batch_id: str) -> FsBatch | None:
    b = db.get(FsBatch, batch_id)
    return b if b is not None and b.project_id == p.id and b.kind == "trash" else None


def _batch_rows(db: Session, batch_id: str) -> dict[str, list[Any]]:
    return {k: list(db.scalars(select(m).where(m.trash_batch_id == batch_id).execution_options(**INCLUDE_TRASHED))) for k, m in MODELS.items()}


def _source_roots(db: Session, p: ProjectRow, batch_id: str) -> list[SourceNode]:
    return list(db.scalars(select(SourceNode).where(SourceNode.project_id == p.id, SourceNode.trash_batch_id == batch_id, SourceNode.trashed_at.is_not(None))))


def restore(db: Session, ctx: RequestContext, p: ProjectRow, batch_id: str) -> dict:
    roots = _source_roots(db, p, batch_id)
    if roots:
        items = list_items(db, p, batch_id=batch_id)
        res = fs.apply(db, ctx, p, {"ops": [{"kind": "restore", "nodeIds": [n.id for n in roots]}]})
        relocated = any(it.get("originalLocation") is None for it in items)
        _audit(db, ctx, p, "restore", "source", batch_id, batch_id, {"files": len(roots), "fsBatchId": res.get("batchId")})
        return {"restored": items, "relocatedToRoot": relocated}
    b = _batch(db, p, batch_id)
    if b is None:
        raise HTTPException(404, "nothing in Trash with that id")
    items = list_items(db, p, batch_id=batch_id)
    rows = _batch_rows(db, batch_id)
    relocated = False
    for k, rs in rows.items():
        for r in rs:
            r.trashed_at = r.trashed_by = r.trash_batch_id = None
            # A collection or Studio whose dataset is still in Trash comes back with it.
            parent = getattr(r, "dataset_id", None) if k in ("collection", "studio") else None
            if parent is not None:
                d = _get(db, DatasetRow, parent)
                if d is not None and d.trashed_at is not None:
                    relocated = True
                    d.trashed_at = d.trashed_by = d.trash_batch_id = None
    db.delete(b)
    db.flush()
    _audit(db, ctx, p, "restore", b.resource, batch_id, batch_id, {"items": len(items)})
    return {"restored": items, "relocatedToRoot": relocated}


def _delete_by(db: Session, column: str, values: list[str]) -> None:
    """Delete rows of every table keyed by `column` in `values` (children before parents)."""
    if not values:
        return
    for t in reversed(Base.metadata.sorted_tables):
        if column in t.c and t.name not in ("tasks", "datasets", "dataset_collections", "projects"):
            db.execute(delete(t).where(t.c[column].in_(values)))


def _destroy_rows(db: Session, rows: dict[str, list[Any]]) -> int:
    task_ids = [r.id for r in rows["studio"]]
    ds_ids = [r.id for r in rows["dataset"]]
    _delete_by(db, "task_id", task_ids)
    for m, rs in ((TaskRow, rows["studio"]), (DatasetCollectionRow, rows["collection"])):
        if rs:
            db.execute(delete(m).where(m.id.in_([r.id for r in rs])))
    if ds_ids:
        # Studios and collections of the dataset that weren't in this batch go too (FKs).
        _delete_by(db, "task_id", list(db.scalars(select(TaskRow.id).where(TaskRow.dataset_id.in_(ds_ids)).execution_options(**INCLUDE_TRASHED))))
        db.execute(delete(TaskRow).where(TaskRow.dataset_id.in_(ds_ids)))
        db.execute(delete(DatasetCollectionRow).where(DatasetCollectionRow.dataset_id.in_(ds_ids)))
        _delete_by(db, "dataset_id", ds_ids)
        db.execute(delete(DatasetRow).where(DatasetRow.id.in_(ds_ids)))
    for p in rows["project"]:
        _destroy_project(db, p.id)
    return sum(len(v) for v in rows.values())


def _owner_col(t: Any) -> Any:
    return next((t.c[c] for c in ("project_id", "workspace_id") if c in t.c), None)


def _destroy_project(db: Session, pid: str) -> None:
    """Every row of the project, children before parents (rows keyed only through a foreign key to
    a project-owned table, such as an upload's files, go with their parent), its workspace row,
    and its blobs through the BlobStore, except bytes another project's asset row still names
    (a sample copy shares its template's keys; the same rule as a file purge)."""
    paths = set(db.scalars(select(Asset.path).where(Asset.workspace_id == pid)))
    shared: set[str] = set()
    plist = sorted(paths)
    for i in range(0, len(plist), 500):
        shared |= set(db.scalars(select(Asset.path).where(Asset.path.in_(plist[i : i + 500]), Asset.workspace_id != pid)))
    keys = sorted(paths - shared)
    for t in reversed(Base.metadata.sorted_tables):
        if t.name in ("projects", "workspaces"):
            continue
        own = _owner_col(t)
        if own is not None:
            db.execute(delete(t).where(own == pid))
            continue
        for fk in t.foreign_keys:
            parent = fk.column.table
            pown = _owner_col(parent)
            if pown is not None and parent.name != "workspaces":
                db.execute(delete(t).where(fk.parent.in_(select(fk.column).where(pown == pid))))
    db.execute(delete(ProjectRow).where(ProjectRow.id == pid))
    db.execute(delete(Workspace).where(Workspace.id == pid))
    if keys:
        aftercommit.defer(db, _delete_blobs, keys)


def _delete_blobs(keys: list[str]) -> None:
    store = blobstore.data()
    for k in keys:
        try:
            store.delete(k)
        except Exception:  # noqa: BLE001 - a missing blob is already gone
            pass


def destroy(db: Session, ctx: RequestContext, p: ProjectRow, batch_id: str) -> dict:
    roots = _source_roots(db, p, batch_id)
    if roots:
        plan = fs.purge_plan(db, p, roots)
        b = fs.Batch(db, ctx, p)
        fs.purge_apply(b, plan)
        fs.finish(b)
        _audit(db, ctx, p, "destroy", "source", batch_id, batch_id, {"purged": b.purged})
        return {"purged": b.purged}
    b = _batch(db, p, batch_id)
    if b is None:
        raise HTTPException(404, "nothing in Trash with that id")
    n = _destroy_rows(db, _batch_rows(db, batch_id))
    resource = b.resource
    db.delete(b)
    db.flush()
    _audit(db, ctx, p, "destroy", resource, batch_id, batch_id, {"purged": n})
    return {"purged": n}


def empty(db: Session, ctx: RequestContext, p: ProjectRow, *, dry_run: bool = False, older_than: datetime | None = None, kind: str = "all") -> dict:
    """Empty Trash. `kind="all"` (the project Trash page) purges every kind; `kind="sources"`
    (Sources › Trash) purges files only and never touches datasets, collections or Studios
    (todo18 P0-1). The result carries `byKind`, the count per kind, for the confirm dialog."""
    if kind not in ("all", "sources"):
        raise HTTPException(422, "kind must be all or sources")
    out = fs.empty_trash(db, ctx, p, dry_run=dry_run, older_than=older_than)
    by_kind = {"sources": out.get("purged", 0), "datasets": 0, "collections": 0, "studios": 0}
    if kind == "sources":
        return {**out, "byKind": by_kind}
    q = select(FsBatch).where(FsBatch.project_id == p.id, FsBatch.kind == "trash", FsBatch.resource != "project")
    if older_than is not None:
        q = q.where(FsBatch.at < older_than)
    batches = list(db.scalars(q))
    purged = 0
    for b in batches:
        rows = _batch_rows(db, b.id)
        for k in ("dataset", "collection", "studio"):
            by_kind[k + "s"] += len(rows.get(k) or [])
        if dry_run:
            purged += sum(len(v) for v in rows.values())
            continue
        purged += _destroy_rows(db, rows)
        db.delete(b)
    if batches and not dry_run:
        db.flush()
        _audit(db, ctx, p, "destroy", "all", p.id, None, {"batches": len(batches), "purged": purged})
    out["purged"] = out.get("purged", 0) + purged
    out["byKind"] = by_kind
    return out


# ---- Projects (Deleted projects) ---------------------------------------------------------------


def trash_project(db: Session, ctx: RequestContext, p: ProjectRow) -> dict:
    if project_role(db, ctx, p) != "owner":
        raise HTTPException(403, "Only the project's owners can delete it")
    return trash(db, ctx, p, "project", p)


def restore_project(db: Session, ctx: RequestContext, p: ProjectRow) -> dict:
    if p.trashed_at is None or p.trash_batch_id is None:
        raise HTTPException(409, "this project isn't deleted")
    return restore(db, ctx, p, p.trash_batch_id)


def deleted_projects(db: Session, ctx: RequestContext) -> dict:
    org = ctx.org_id
    q = select(ProjectRow).where(ProjectRow.trashed_at.is_not(None)).execution_options(**INCLUDE_TRASHED)
    rows = [r for r in db.scalars(q.order_by(ProjectRow.trashed_at.desc())) if (org is None or r.org_id == org) and project_role(db, ctx, r) == "owner"]
    return {"projects": [{"id": r.id, "name": r.title, "trashedAt": _iso(r.trashed_at), "trashedBy": _who(db, r.trashed_by, _actor(db, r.trash_batch_id)), "daysLeft": days_left(r.trashed_at)} for r in rows]}


def destroy_project(db: Session, ctx: RequestContext, p: ProjectRow) -> dict:
    require_destroy(db, ctx, p, "project.destroy", [p.id])
    if p.trashed_at is None:
        raise HTTPException(409, "move the project to Deleted projects first")
    org = p.org_id
    _destroy_project(db, p.id)
    db.flush()
    record_event(db, org_id=org, actor=ctx.principal, on_behalf_of=ctx.on_behalf_of, action=AUDIT["destroy"], target=p.id, detail={"kind": "project"})
    return {"purged": 1}


# ---- The Trash listing -------------------------------------------------------------------------


def _actor(db: Session, batch_id: str | None) -> str | None:
    if not batch_id:
        return None
    b = db.get(FsBatch, batch_id)
    return b.actor if b is not None else None


def _who(db: Session, principal: str | None, actor: str | None) -> dict:
    from .overview import display_name

    pid = principal or ""
    name = display_name(db, pid) if pid else ""
    return {"id": pid, "name": name, "viaAssistant": bool(actor and actor.startswith("agent:"))}


def _location(db: Session, kind: str, r: Any) -> str | None:
    if kind in ("collection", "studio"):
        d = _get(db, DatasetRow, r.dataset_id)
        return d.title if d is not None and d.trashed_at is None else None
    return None


def list_items(db: Session, p: ProjectRow, kind: str = "all", *, batch_id: str | None = None) -> list[dict]:
    want = KINDS.get(kind, "?")
    if want == "?":
        raise HTTPException(422, "kind must be all, sources, datasets, collections or studios")
    items: list[dict] = []
    if want in (None, "source"):
        q = select(SourceNode).where(SourceNode.project_id == p.id, SourceNode.trashed_at.is_not(None))
        if batch_id:
            q = q.where(SourceNode.trash_batch_id == batch_id)
        nodes = list(db.scalars(q.order_by(SourceNode.trashed_at.desc())))
        ch = tree.chains(db, [n.id for n in nodes])
        for n in nodes:
            d = fs.trash_item(db, n, ch.get(n.id))
            files = 0 if n.is_dir else 1
            d.update(batchId=n.trash_batch_id or n.id, kind="source", trashedBy=_who(db, n.trashed_by, _actor(db, n.trash_batch_id)), trashedByName=n.trashed_by or "", daysLeft=days_left(n.trashed_at), dependents={"files": files})
            items.append(d)
    q2 = select(FsBatch).where(FsBatch.project_id == p.id, FsBatch.kind == "trash", FsBatch.resource.in_(("dataset", "collection", "studio")))
    if want not in (None, "source"):
        q2 = q2.where(FsBatch.resource == want)
    elif want == "source":
        q2 = q2.where(FsBatch.id.is_(None))
    if batch_id:
        q2 = q2.where(FsBatch.id == batch_id)
    for b in db.scalars(q2.order_by(FsBatch.at.desc())):
        rows = _batch_rows(db, b.id)
        roots = rows.get(b.resource) or []
        if not roots:
            continue
        r = roots[0]
        task_ids = [t.id for t in rows["studio"]]
        deps = {"collections": len(rows["collection"]) - (1 if b.resource == "collection" else 0), "studios": len(rows["studio"]) - (1 if b.resource == "studio" else 0), "annotations": _annotation_count(db, p.id, task_ids)}
        items.append({"batchId": b.id, "kind": b.resource, "id": r.id, "name": _name(r), "originalLocation": _location(db, b.resource, r), "trashedAt": _iso(r.trashed_at), "trashedBy": _who(db, r.trashed_by, b.actor), "daysLeft": days_left(r.trashed_at), "dependents": deps})
    items.sort(key=lambda it: it.get("trashedAt") or "", reverse=True)
    return items


def page(db: Session, p: ProjectRow, kind: str = "all", cursor: str | None = None) -> dict:
    """`GET /projects/{pid}/trash`: the file Trash page's fields (`nextCursor`, `total`, its
    node fields on source items) plus every kind's TrashItems."""
    legacy = fs.trash_page(db, p, cursor)
    items = list_items(db, p, kind)
    return {**legacy, "items": items, "count": len(items), "files": legacy["items"]}


# ---- The purge job (`trash.purge`, alias `files.empty_trash`) -----------------------------------


def purge_expired(db: Session, *, days_: int | None = None) -> dict:
    d = days() if days_ is None else days_
    cutoff = now() - timedelta(days=d)
    out = fs.purge_expired(db, days=d)
    pids = set(db.scalars(select(FsBatch.project_id).where(FsBatch.kind == "trash", FsBatch.at < cutoff).distinct()))
    purged = 0
    for pid in pids:
        p = _get(db, ProjectRow, pid)
        if p is None:
            continue
        ctx = RequestContext(p.id, "system:trash", uuid.uuid4().hex)
        if p.trashed_at is not None and _utc(p.trashed_at) < cutoff:  # type: ignore[operator]
            _destroy_project(db, p.id)
            record_event(db, org_id=p.org_id, actor=ctx.principal, action=AUDIT["destroy"], target=p.id, detail={"kind": "project", "expired": True})
            purged += 1
            continue
        purged += empty(db, ctx, p, older_than=cutoff)["purged"]  # files went above
    out["purged"] = out.get("purged", 0) + purged
    return out


def _audit(db: Session, ctx: RequestContext, p: ProjectRow, verb: str, kind: str, target: str, batch: str | None, detail: dict) -> None:
    record_event(db, org_id=p.org_id, actor=ctx.principal, on_behalf_of=ctx.on_behalf_of, action=AUDIT[verb], target=target, ip=ctx.client_ip, user_agent=ctx.user_agent, detail={"kind": kind, "projectId": p.id, "batchId": batch, **{k: v for k, v in detail.items() if k != "items" or isinstance(v, int)}})
