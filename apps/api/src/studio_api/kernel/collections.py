"""Dataset collections (todo13 D7, D16): one logical kind each ("Chest X-rays", "CT series",
"Labels table"). A dataset pins file refs (`definition.files`); a ref belongs to the collection
named by its `collectionId`, and a ref without one (made before collections) to the collection
whose kind is the ref's pinned kind. A task works on one collection (`tasks.collection_id`), or
on every collection when it has none (tasks made before collections, on mixed datasets).

`ensure` is the backfill's data job for datasets made after the migration: it gives a dataset
one collection per detected kind among its pinned files that no collection covers yet. It's
idempotent and cheap to call on read.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..context import RequestContext
from ..models import DatasetCollectionRow, DatasetRow, TaskRow
from . import audit, projects
from .drops_classify import NAMES
from .kinds import VIEWABLE

VIEWABLE_COLLECTIONS = VIEWABLE | {"dicom-series"}
ORDER = ["dicom-series", "dicom", "volume", "image", "video", "slide", "waveform", "mask", "table", "annotations", "document", "archive", "unknown"]


def new_id() -> str:
    return projects.new_id("col")


def collection_kind(kind: str | None, facts: dict | None) -> str | None:
    """The collection kind of a file: DICOM files that belong to a series are `dicom-series`."""
    if not kind:
        return None
    if kind == "dicom" and isinstance(facts, dict) and isinstance(facts.get("series"), dict):
        return "dicom-series"
    return kind


def of_dataset(db: Session, dataset_id: str) -> list[DatasetCollectionRow]:
    rows = list(db.scalars(select(DatasetCollectionRow).where(DatasetCollectionRow.dataset_id == dataset_id)))
    return sorted(rows, key=lambda c: (ORDER.index(c.kind) if c.kind in ORDER else len(ORDER), c.created_at, c.id))


def create(db: Session, ctx: RequestContext, d: DatasetRow, kind: str, name: str | None = None, shape: dict | None = None, *, suggested: bool = True) -> DatasetCollectionRow:
    c = DatasetCollectionRow(id=new_id(), dataset_id=d.id, project_id=d.project_id, name=(name or NAMES.get(kind, kind.capitalize()))[:256], kind=kind[:32], shape=dict(shape or {}), suggested=suggested, created_by=projects.person(ctx))
    db.add(c)
    db.flush()
    sync_definition(db, d)
    audit.record(db, ctx.for_scope(d.project_id, None), "dataset.collection_created", target=d.id, after={"collectionId": c.id, "kind": c.kind})
    return c


def sync_definition(db: Session, d: DatasetRow) -> None:
    """Mirror the collections into `definition.collections` (`[{id, name, kind, suggested}]`), the
    shape the Datasets views read (`kernel/datasets_views.py` `defined_collections`)."""
    rows = of_dataset(db, d.id)
    want = [{"id": c.id, "name": c.name, "kind": c.kind, "suggested": bool(c.suggested)} for c in rows]
    definition = dict(d.definition or {})
    if definition.get("collections") == want or (not want and "collections" not in definition):
        return
    if want:
        definition["collections"] = want
    else:
        definition.pop("collections", None)
    d.definition = definition
    db.flush()


def _ref_kinds(db: Session, d: DatasetRow) -> list[tuple[dict, str | None]]:
    """(ref, collection kind of its pinned version) for the dataset's files that still exist."""
    out = []
    for n, ref in projects.dataset_files(db, d):
        kind, facts, *_ = projects.pinned_view(db, n, ref)
        out.append((ref, collection_kind(kind, facts)))
    return out


def members(db: Session, d: DatasetRow, c: DatasetCollectionRow, pairs: list[tuple[dict, str | None]] | None = None) -> set[str]:
    """Node ids of the dataset's files in collection `c`."""
    pairs = _ref_kinds(db, d) if pairs is None else pairs
    ids = {x.id for x in of_dataset(db, d.id)}
    out = set()
    for ref, kind in pairs:
        cid = ref.get("collectionId")
        if cid == c.id or ((not cid or cid not in ids) and kind == c.kind):
            out.add(str(ref["nodeId"]))
    return out


def ensure(db: Session, ctx: RequestContext | None, d: DatasetRow) -> list[DatasetCollectionRow]:
    """One collection per detected kind among the dataset's files that no collection covers."""
    have = of_dataset(db, d.id)
    if (d.definition or {}).get("seed"):
        return have
    covered = {c.kind for c in have}
    explicit = {c.id for c in have}
    missing: list[str] = []
    for ref, kind in _ref_kinds(db, d):
        if kind and kind not in covered and ref.get("collectionId") not in explicit and kind not in missing:
            missing.append(kind)
    if not missing:
        sync_definition(db, d)
        return have
    actor = ctx or _system_ctx(d.project_id)
    for k in sorted(missing, key=lambda x: ORDER.index(x) if x in ORDER else len(ORDER)):
        create(db, actor, d, k)
    return of_dataset(db, d.id)


def _system_ctx(project_id: str) -> RequestContext:
    return RequestContext(workspace_id=project_id, principal="system:collections", correlation_id="collections-backfill")


def add_files(db: Session, d: DatasetRow, collection_id: str, node_ids: list[str]) -> list[str]:
    """Pin these files into the dataset (at their current versions) in `collection_id`; files the
    dataset already pins move to that collection. Returns the node ids newly pinned."""
    definition = dict(d.definition or {})
    refs = [dict(r) for r in definition.get("files") or [] if isinstance(r, dict)]
    have = {str(r.get("nodeId")): r for r in refs}
    from ..models import SourceNode

    nodes = {n.id: n for n in db.scalars(select(SourceNode).where(SourceNode.id.in_(node_ids), SourceNode.project_id == d.project_id, SourceNode.is_dir.is_(False)))} if node_ids else {}
    added = []
    for nid in node_ids:
        n = nodes.get(nid)
        if n is None:
            continue
        if nid in have:
            have[nid]["collectionId"] = collection_id
            continue
        r = {"nodeId": n.id, "assetId": n.asset_id, "version": n.version or 1, "collectionId": collection_id}
        refs.append(r)
        have[nid] = r
        added.append(nid)
    definition["files"] = refs
    definition.setdefault("followedFolders", [])
    definition["nodeIds"] = list(dict.fromkeys([*(definition.get("nodeIds") or []), *added]))
    d.definition = definition
    db.flush()
    return added


def remove_files(db: Session, d: DatasetRow, node_ids: list[str]) -> None:
    drop = set(node_ids)
    definition = dict(d.definition or {})
    definition["files"] = [r for r in definition.get("files") or [] if not (isinstance(r, dict) and str(r.get("nodeId")) in drop)]
    definition["nodeIds"] = [i for i in definition.get("nodeIds") or [] if i not in drop]
    d.definition = definition
    db.flush()


def collection_dict(c: DatasetCollectionRow, files: int | None = None) -> dict:
    out = {"id": c.id, "datasetId": c.dataset_id, "name": c.name, "kind": c.kind, "shape": c.shape or {}, "suggested": bool(c.suggested), "viewable": c.kind in VIEWABLE_COLLECTIONS, "createdAt": projects.iso(c.created_at)}
    if files is not None:
        out["files"] = files
    return out


def list_dicts(db: Session, d: DatasetRow) -> list[dict]:
    rows = of_dataset(db, d.id)
    if not rows:
        return []
    pairs = _ref_kinds(db, d)
    tasks: dict[str, list[str]] = {}
    for t in db.scalars(select(TaskRow).where(TaskRow.dataset_id == d.id)):
        if t.collection_id:
            tasks.setdefault(t.collection_id, []).append(t.id)
    return [{**collection_dict(c, len(members(db, d, c, pairs))), "taskIds": tasks.get(c.id, [])} for c in rows]


def item_filter(db: Session, t: TaskRow, d: DatasetRow | None):
    """For `task_document`: a predicate over node ids (None = no filter) for the task's collection."""
    if not t.collection_id or d is None:
        return None
    c = db.get(DatasetCollectionRow, t.collection_id)
    if c is None or c.dataset_id != d.id:
        return None
    keep = members(db, d, c)
    viewable = c.kind in VIEWABLE_COLLECTIONS
    return lambda node_id: viewable and node_id in keep


def backfill_all(db: Session) -> dict:
    """The D16 data job, for datasets made after the migration ran: ensure collections, and give
    each task of a single-viewable-kind dataset its collection. Resumable and idempotent."""
    datasets = tasks = 0
    for d in db.scalars(select(DatasetRow)):
        before = len(of_dataset(db, d.id))
        rows = ensure(db, None, d)
        datasets += len(rows) != before
        if (d.definition or {}).get("seed"):
            continue
        viewable = [c for c in rows if c.kind in VIEWABLE_COLLECTIONS]
        if len(viewable) == 1:
            for t in db.scalars(select(TaskRow).where(TaskRow.dataset_id == d.id, TaskRow.collection_id.is_(None))):
                t.collection_id = viewable[0].id
                tasks += 1
    db.flush()
    return {"datasets": datasets, "tasks": tasks}
