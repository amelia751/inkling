"""Files: the project's drive as a file system (todo7 Phase 1, 4, 6, 7; docs/files-api.md).

*Bytes are immutable; the namespace is yours.* Names, folders and Trash change freely; every
change is an `fs_ops` row with the node's state before and after, grouped in an `fs_batches`
row, so it can be undone (D9) and shown in Activity.

- One root per project (D1, `ensure_drive`), opaque permanent ids (D3), computed paths (D4).
- Sample data is locked (D2): any write that would change it, or put something into it,
  answers 423. Copying out of it is allowed and free (D5: copies share the asset).
- Names are unique per folder case-insensitively among nodes not in Trash (D10); a clash
  answers 409 with every conflict unless the request settles it (`keep_both`, `replace`,
  `skip`, `merge`).
- Trash (D8) marks only the trashed node; purge deletes bytes only when nothing else (another
  node, a version, a dataset, an annotation) references the asset.
- Versions (D6): replace adds a version; restoring one adds another, pointing at the old asset.
- A move is one row update plus count updates along the two ancestor chains (O(depth)).

`apply` runs in the request's transaction: an exception anywhere rolls the whole batch back.
"""

from __future__ import annotations

import json
import unicodedata
import uuid
from collections import Counter
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import HTTPException
from sqlalchemy import String, cast, delete, func, select, update
from sqlalchemy.orm import Session

from .. import aftercommit, blobstore
from ..config import settings
from ..context import RequestContext
from ..dbutil import insert_ignore
from ..models import (
    AnnotationDocumentRow,
    Asset,
    DatasetRow,
    FsBatch,
    FsOp,
    NodeRecent,
    NodeStar,
    NodeVersion,
    ProjectRow,
    Proposal,
    SourceNode,
    now,
)
from . import approvals, assets, audit, events, privacy_names, tree

LOCKED = "Sample data can't be changed. Copy it to make your own"
TRASH_DAYS = 30
RESOLUTIONS = {"keep_both", "replace", "skip", "merge"}
OP_KINDS = {"mkdir", "rename", "move", "copy", "trash", "restore", "purge"}
NAMESPACE = ("parent_id", "name", "name_dup", "sequence_key", "trashed_at", "trashed_by", "trash_batch_id")
CONTENT = ("asset_id", "sha256", "size", "version", "detected_kind", "facts", "flags", "import_session_id")
COLUMNS = [c.key for c in SourceNode.__table__.columns]
DATES = {"trashed_at", "created_at"}
VERBS = {"mkdir": ("new folder", "Created"), "rename": ("rename", "Renamed"), "move": ("move", "Moved"), "copy": ("copy", "Copied"), "trash": ("move to Trash", "Moved to Trash"), "restore": ("restore", "Restored"), "purge": ("delete forever", "Deleted forever"), "replace": ("replace", "Replaced"), "restore_version": ("version restore", "Restored a version of")}
AUDIT = {"mkdir": "files.created", "rename": "files.renamed", "move": "files.moved", "copy": "files.copied", "trash": "files.trashed", "restore": "files.restored", "purge": "files.purged", "replace": "files.version_added", "restore_version": "files.version_restored"}


def person(ctx: RequestContext) -> str:
    return ctx.on_behalf_of or ctx.principal


# todo16 D8: the session scope an assistant token needs to write and trash (operations catalogue).
PROJECT_WRITE = "project.write"


def only_people(ctx: RequestContext, *, destroy: bool = False) -> None:
    """Who may change files (todo16 D8): people, and an assistant acting with the delegated token
    of the person who sent the message (the person's project role still applies). Other scoped
    tokens propose only. A *destroy* (purge) by an assistant also needs the person's signed
    approval from chat (`X-Approval-Id`), checked by `approvals.verify` where the destroy runs."""
    if not ctx.scopes:
        return
    if not ctx.on_behalf_of or not ctx.allows(PROJECT_WRITE):
        raise HTTPException(403, "Only people change files and folders; the assistant can propose a reorganization")


# ---- The drive (D1) ----------------------------------------------------------------------------


def ensure_drive(db: Session, p: ProjectRow) -> SourceNode:
    """The project's root folder, created on first use. Top-level folders that predate it (a
    source root with no parent) move under it."""
    rid = tree.drive_root_id(p.id)
    root = db.get(SourceNode, rid)
    if root is not None:
        return root
    insert_ignore(db, SourceNode, [tree._row(id=rid, source_id=None, project_id=p.id, project_root=rid, parent_id=None, name=tree.ROOT_NAME, original_path="", is_dir=True, created_at=now())])
    root = db.get(SourceNode, rid)
    assert root is not None
    taken: set[str] = set()
    for orphan in db.scalars(select(SourceNode).where(SourceNode.project_id == p.id, SourceNode.parent_id.is_(None), SourceNode.id != rid).order_by(SourceNode.created_at)):
        orphan.name = tree.free_name(orphan.name, taken, is_dir=orphan.is_dir)
        taken.add(orphan.name.lower())
        orphan.parent_id = rid
        db.flush()
        if orphan.trashed_at is None:
            files, size = tree.weight(orphan)
            tree.bump(db, rid, files, size, children=1)
    db.execute(update(SourceNode).where(SourceNode.project_id == p.id, SourceNode.project_root.is_(None)).values(project_root=rid))
    db.expire_all()
    root = db.get(SourceNode, rid)
    assert root is not None
    return root


def drive_info(db: Session, p: ProjectRow) -> dict:
    root = ensure_drive(db, p)
    trash = db.scalar(select(func.count()).select_from(SourceNode).where(SourceNode.project_id == p.id, SourceNode.trashed_at.is_not(None))) or 0
    return {"projectId": p.id, "rootNodeId": root.id, "writable": True, "trashCount": trash}


# ---- Names (D10) -------------------------------------------------------------------------------


def clean_name(raw: Any) -> str:
    # todo17 D1 normalise: trimmed, Unicode NFC (so "Café" typed two ways is one name).
    name = unicodedata.normalize("NFC", str(raw if raw is not None else "")).strip().rstrip(" .")
    if not name.strip():
        raise HTTPException(422, "A name can't be empty")
    if "/" in name:
        raise HTTPException(422, "A name can't contain “/”")
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in name):
        raise HTTPException(422, "A name can't contain control characters")
    if len(name.encode()) > 255:
        raise HTTPException(422, "A name can be at most 255 bytes long")
    return name


def sibling(db: Session, parent_id: str, name: str, exclude: Iterable[str] = ()) -> SourceNode | None:
    """The node not in Trash with this name (any case) in a folder, if there is one."""
    q = select(SourceNode).where(SourceNode.parent_id == parent_id, func.lower(SourceNode.name) == name.lower(), SourceNode.trashed_at.is_(None))
    ex = [x for x in exclude if x]
    if ex:
        q = q.where(SourceNode.id.not_in(ex))
    return db.scalars(q.limit(1)).first()


def taken_names(db: Session, parent_id: str) -> set[str]:
    return {n.lower() for n in db.scalars(select(SourceNode.name).where(SourceNode.parent_id == parent_id, SourceNode.trashed_at.is_(None)))}


# ---- Snapshots for the journal -----------------------------------------------------------------


def _json(v: Any) -> Any:
    if isinstance(v, datetime):
        return (v if v.tzinfo else v.replace(tzinfo=UTC)).isoformat()
    return v


def _unjson(k: str, v: Any) -> Any:
    if k in DATES and isinstance(v, str):
        return datetime.fromisoformat(v)
    return v


def snap(n: SourceNode, fields: Iterable[str]) -> dict:
    return {k: _json(getattr(n, k)) for k in fields}


def row_of(n: SourceNode) -> dict:
    return snap(n, COLUMNS)


def version_row(v: NodeVersion) -> dict:
    return {"node_id": v.node_id, "version": v.version, "project_id": v.project_id, "asset_id": v.asset_id, "sha256": v.sha256, "size": v.size, "detected_kind": v.detected_kind, "facts": v.facts or {}, "flags": v.flags or {}, "created_by": v.created_by, "created_at": _json(v.created_at)}


# ---- A batch -----------------------------------------------------------------------------------


@dataclass
class Batch:
    db: Session
    ctx: RequestContext
    project: ProjectRow
    kind: str = "ops"
    id: str = field(default_factory=lambda: "bat-" + uuid.uuid4().hex)
    resolutions: dict[str, str] = field(default_factory=dict)
    ops: list[FsOp] = field(default_factory=list)
    parents: set[str] = field(default_factory=set)
    touched: dict[str, SourceNode] = field(default_factory=dict)
    counts: Counter = field(default_factory=Counter)
    top: list[str] = field(default_factory=list)  # nodes the request named, for the summary
    top_names: list[str] = field(default_factory=list)
    summary: str = ""
    conflicts: list[dict] = field(default_factory=list)
    skipped_identical: int = 0
    skipped_resolution: int = 0
    warnings: list[str] = field(default_factory=list)
    renamed: set[str] = field(default_factory=set)
    moved: set[str] = field(default_factory=set)
    undoable: bool = True
    target_name: str | None = None
    kept: list[dict] = field(default_factory=list)
    purged: int = 0
    at: datetime = field(default_factory=now)

    @property
    def actor(self) -> str:
        return person(self.ctx)

    def journal(self, kind: str, node_id: str, before: dict | None, after: dict | None) -> None:
        op = FsOp(project_id=self.project.id, batch_id=self.id, actor=self.actor, kind=kind, node_id=node_id, before=before, after=after, at=self.at)
        self.db.add(op)
        self.ops.append(op)

    def mark(self, n: SourceNode) -> None:
        self.top.append(n.id)
        self.top_names.append(n.name)

    def resolution(self, node_id: str) -> str | None:
        r = self.resolutions.get(node_id) or self.resolutions.get("*")
        return r if r in RESOLUTIONS else None

    def conflict(self, node_id: str, name: str, parent: SourceNode, existing: SourceNode, is_dir: bool, identical: bool = False) -> None:
        self.conflicts.append({"nodeId": node_id, "name": name, "parentId": parent.id, "parentName": parent.name, "existingId": existing.id, "kind": "folder" if is_dir else "file", "identical": identical})


# ---- Lookups and guards ------------------------------------------------------------------------


def _node(b: Batch, node_id: Any, *, visible: bool = True) -> SourceNode:
    n = b.db.get(SourceNode, str(node_id or ""))
    if n is None or n.project_id != b.project.id:
        raise HTTPException(404, "No such file or folder in this project")
    if visible and tree.is_hidden(b.db, n):
        raise HTTPException(422, f"{n.name} is in the Trash: restore it first")
    return n


def _folder(b: Batch, node_id: Any) -> SourceNode:
    f = _node(b, node_id)
    if not f.is_dir:
        raise HTTPException(422, f"{f.name} isn't a folder")
    return f


def _writable(n: SourceNode, what: str = LOCKED) -> None:
    if n.locked:
        raise HTTPException(423, what)


def _not_root(n: SourceNode) -> None:
    if n.parent_id is None:
        raise HTTPException(422, "The project's Files folder can't be changed")


# ---- Changing state (counts follow) ------------------------------------------------------------


def set_state(b: Batch, n: SourceNode, new: dict) -> None:
    """Apply journaled fields to a node and keep the folder counts along its old and new
    ancestor chains right: one pass up each chain (O(depth))."""
    db = b.db
    old_parent, old_visible, old_w = n.parent_id, n.trashed_at is None, tree.weight(n)
    old_name = n.name
    for k, v in new.items():
        setattr(n, k, _unjson(k, v))
    new_parent, new_visible, new_w = n.parent_id, n.trashed_at is None, tree.weight(n)
    if old_parent == new_parent and old_visible == new_visible:
        if new_visible and new_w != old_w:
            tree.bump(db, new_parent, new_w[0] - old_w[0], new_w[1] - old_w[1])
    else:
        if old_visible and old_parent:
            tree.bump(db, old_parent, -old_w[0], -old_w[1], children=-1)
        if new_visible and new_parent:
            tree.bump(db, new_parent, new_w[0], new_w[1], children=1)
    if old_parent != new_parent or old_visible != new_visible or old_name != n.name:
        b.parents.update(x for x in (old_parent, new_parent) if x)
    b.touched[n.id] = n
    db.flush()


def _insert(b: Batch, rows: list[dict], versions: list[dict]) -> None:
    for r in rows:
        b.db.add(SourceNode(**{k: _unjson(k, v) for k, v in r.items()}))
    b.db.flush()
    for v in versions:
        b.db.merge(NodeVersion(**{k: _unjson(k, x) for k, x in v.items()}))
    b.db.flush()


# ---- Operations --------------------------------------------------------------------------------


def _mkdir(b: Batch, op: dict) -> None:
    parent = _folder(b, op.get("parentId"))
    _writable(parent)
    name = clean_name(op.get("name"))
    asked = str(op.get("id") or "")
    key = asked or f"mkdir:{name}"
    existing = sibling(b.db, parent.id, name)
    if existing is not None:
        res = b.resolution(key)
        if res == "merge" and existing.is_dir:
            b.touched[existing.id] = existing
            b.skipped_resolution += 1
            return
        if res == "skip":
            b.skipped_resolution += 1
            return
        if res != "keep_both":
            b.conflict(key, name, parent, existing, True)
            return
        name = tree.free_name(name, taken_names(b.db, parent.id), is_dir=True)
    nid = asked if tree.NEW_ID.fullmatch(asked) and b.db.get(SourceNode, asked) is None else tree.new_node_id()
    row = tree._row(id=nid, source_id=None, project_id=b.project.id, project_root=parent.project_root or parent.id, parent_id=parent.id, name=name, original_path="", is_dir=True, created_at=b.at)
    n = SourceNode(**row)
    b.db.add(n)
    b.db.flush()
    tree.bump(b.db, parent.id, 0, 0, children=1)
    b.parents.add(parent.id)
    b.touched[n.id] = n
    b.journal("mkdir", n.id, None, row_of(n))
    b.counts["mkdir"] += 1
    b.mark(n)
    b.target_name = parent.name


def _rename(b: Batch, op: dict) -> None:
    n = _node(b, op.get("nodeId"))
    _not_root(n)
    _writable(n)
    name = clean_name(op.get("name"))
    if name == n.name:
        return
    existing = sibling(b.db, n.parent_id or "", name, exclude=[n.id])
    if existing is not None:
        res = b.resolution(n.id)
        if res == "skip":
            b.skipped_resolution += 1
            return
        if res != "keep_both":
            parent = b.db.get(SourceNode, n.parent_id)
            assert parent is not None
            b.conflict(n.id, name, parent, existing, n.is_dir)
            return
        name = tree.free_name(name, taken_names(b.db, n.parent_id or "") - {n.name.lower()}, is_dir=n.is_dir)
    before = snap(n, ("name", "name_dup", "sequence_key"))
    set_state(b, n, {"name": name, "name_dup": 0, "sequence_key": None if n.is_dir else tree.sequence_key(name)})
    b.journal("rename", n.id, before, snap(n, ("name", "name_dup", "sequence_key")))
    b.counts["rename"] += 1
    b.renamed.add(n.id)
    b.mark(n)


def _ancestor_ids(b: Batch, folder: SourceNode) -> set[str]:
    return set(tree.chain_of(b.db, folder).ids) | {folder.id}


def _move_one(b: Batch, n: SourceNode, target: SourceNode, chain: set[str], *, top: bool = True) -> None:
    _not_root(n)
    _writable(n, "Sample data can't be moved. Copy it instead")
    if n.id in chain:
        raise HTTPException(422, "Can't move a folder into itself")
    if n.parent_id == target.id:
        return
    name = n.name
    existing = sibling(b.db, target.id, name, exclude=[n.id])
    if existing is not None:
        res = b.resolution(n.id)
        identical = not n.is_dir and not existing.is_dir and bool(n.sha256) and n.sha256 == existing.sha256
        if res == "skip":
            b.skipped_resolution += 1
            return
        if res == "replace" and not n.is_dir and not existing.is_dir:
            _writable(existing)
            _replace(b, existing, n.asset_id, n.sha256, n.size, kind=n.detected_kind, facts=n.facts, flags=n.flags)
            _trash_one(b, n, count=False)
            b.counts["move"] += 1
            return
        if res == "merge" and n.is_dir and existing.is_dir:
            _writable(existing)
            inner = chain | {existing.id}
            for c in list(b.db.scalars(select(SourceNode).where(SourceNode.parent_id == n.id, SourceNode.trashed_at.is_(None)))):
                _move_one(b, c, existing, inner, top=False)
            if not b.conflicts:
                _trash_one(b, n, count=False)
            b.counts["move"] += 1
            return
        if res != "keep_both":
            b.conflict(n.id, name, target, existing, n.is_dir, identical)
            return
        name = tree.free_name(name, taken_names(b.db, target.id), is_dir=n.is_dir)
    before = snap(n, ("parent_id", "name", "name_dup", "sequence_key"))
    set_state(b, n, {"parent_id": target.id, "name": name, "name_dup": 0, "sequence_key": None if n.is_dir else tree.sequence_key(name)})
    b.journal("move", n.id, before, snap(n, ("parent_id", "name", "name_dup", "sequence_key")))
    if name != before["name"]:
        b.renamed.add(n.id)
    b.moved.add(n.id)
    if top:
        b.counts["move"] += 1
        b.mark(n)


def _move(b: Batch, op: dict) -> None:
    target = _folder(b, op.get("parentId"))
    _writable(target)
    chain = _ancestor_ids(b, target)
    b.target_name = target.name
    for nid in dict.fromkeys(str(x) for x in op.get("nodeIds") or []):
        _move_one(b, _node(b, nid), target, chain)


def _copy_rows(b: Batch, n: SourceNode, parent_id: str, name: str, root_id: str) -> tuple[list[dict], list[dict], str]:
    """New rows for a copy of `n` (and everything below it, not in Trash): new ids, same assets."""
    ids = [r.id for r in tree.subtree(b.db, n.id)] if n.is_dir else [n.id]
    originals: dict[str, SourceNode] = {}
    for i in range(0, len(ids), 500):
        for x in b.db.scalars(select(SourceNode).where(SourceNode.id.in_(ids[i : i + 500]))):
            originals[x.id] = x
    mapping = {old: tree.new_node_id() for old in ids}
    rows, versions = [], []
    for old in ids:
        o = originals[old]
        r = row_of(o)
        r.update(id=mapping[old], parent_id=parent_id if old == n.id else mapping.get(o.parent_id or ""), locked=False, project_root=root_id, created_at=_json(b.at), version=1, name_dup=0, trashed_at=None, trashed_by=None, trash_batch_id=None, revision=0)
        if old == n.id:
            r["name"] = name
            r["sequence_key"] = None if o.is_dir else tree.sequence_key(name)
        rows.append(r)
        if not o.is_dir:
            versions.append({"node_id": r["id"], "version": 1, "project_id": b.project.id, "asset_id": o.asset_id, "sha256": o.sha256, "size": o.size, "detected_kind": o.detected_kind, "facts": o.facts or {}, "flags": o.flags or {}, "created_by": b.actor, "created_at": _json(b.at)})
    return rows, versions, mapping[n.id]


def _copy_one(b: Batch, n: SourceNode, target: SourceNode, chain: set[str], *, top: bool = True) -> None:
    if n.is_dir and n.id in chain:
        raise HTTPException(422, "Can't copy a folder into itself")
    name = n.name
    existing = sibling(b.db, target.id, name)
    if existing is not None:
        res = b.resolution(n.id)
        identical = not n.is_dir and not existing.is_dir and bool(n.sha256) and n.sha256 == existing.sha256
        if existing.id == n.id and res in (None, "keep_both"):
            # Duplicate in place: `name (copy).ext`, never a conflict.
            stem, ext = (name, "") if n.is_dir else tree.split_ext(name)
            name = tree.free_name(f"{stem} (copy){ext}", taken_names(b.db, target.id), is_dir=n.is_dir)
        elif res is None and identical:
            b.skipped_identical += 1
            return
        elif res == "skip":
            b.skipped_resolution += 1
            return
        elif res == "replace" and not n.is_dir and not existing.is_dir:
            _writable(existing)
            _replace(b, existing, n.asset_id, n.sha256, n.size, kind=n.detected_kind, facts=n.facts, flags=n.flags)
            b.counts["copy"] += 1
            return
        elif res == "merge" and n.is_dir and existing.is_dir:
            _writable(existing)
            inner = chain | {existing.id}
            for c in list(b.db.scalars(select(SourceNode).where(SourceNode.parent_id == n.id, SourceNode.trashed_at.is_(None)))):
                _copy_one(b, c, existing, inner, top=False)
            b.counts["copy"] += 1
            return
        elif res == "keep_both":
            name = tree.free_name(name, taken_names(b.db, target.id), is_dir=n.is_dir)
        else:
            b.conflict(n.id, name, target, existing, n.is_dir, identical)
            return
    rows, versions, new_id = _copy_rows(b, n, target.id, name, target.project_root or target.id)
    _insert(b, rows, versions)
    copy = b.db.get(SourceNode, new_id)
    assert copy is not None
    files, size = tree.weight(copy)
    tree.bump(b.db, target.id, files, size, children=1)
    b.parents.add(target.id)
    b.touched[copy.id] = copy
    by_id = {v["node_id"]: v for v in versions}
    for r in rows:
        after = dict(r)
        if r["id"] in by_id:
            after["_nv"] = by_id[r["id"]]
        b.journal("copy", r["id"], None, after)
    if top:
        b.counts["copy"] += 1
        b.mark(copy)


def _copy(b: Batch, op: dict) -> None:
    target = _folder(b, op.get("parentId"))
    _writable(target)
    chain = _ancestor_ids(b, target)
    b.target_name = target.name
    for nid in dict.fromkeys(str(x) for x in op.get("nodeIds") or []):
        _copy_one(b, _node(b, nid), target, chain)


def _dataset_files(db: Session, project_id: str) -> dict[str, str]:
    """file node id → the title of a dataset that uses it."""
    out: dict[str, str] = {}
    for d in db.scalars(select(DatasetRow).where(DatasetRow.project_id == project_id)):
        for f in (d.definition or {}).get("files") or []:
            if isinstance(f, dict) and f.get("nodeId"):
                out.setdefault(str(f["nodeId"]), d.title)
    return out


def _trash_one(b: Batch, n: SourceNode, *, count: bool = True) -> None:
    _not_root(n)
    _writable(n)
    before = snap(n, ("trashed_at", "trashed_by", "trash_batch_id"))
    set_state(b, n, {"trashed_at": b.at, "trashed_by": b.actor, "trash_batch_id": b.id})
    b.journal("trash", n.id, before, snap(n, ("trashed_at", "trashed_by", "trash_batch_id")))
    if count:
        b.counts["trash"] += 1
        b.mark(n)


def _trash(b: Batch, op: dict) -> None:
    ids = list(dict.fromkeys(str(x) for x in op.get("nodeIds") or []))
    used = _dataset_files(b.db, b.project.id)
    by_dataset: Counter = Counter()
    for nid in ids:
        n = _node(b, nid)
        if used:
            files = [r.id for r in tree.subtree(b.db, n.id) if not r.is_dir] if n.is_dir else [n.id]
            for f in files:
                if f in used:
                    by_dataset[used[f]] += 1
        _trash_one(b, n)
    for title, k in by_dataset.most_common(3):
        b.warnings.append(f"{title} still uses {k} of these")


def _restore(b: Batch, op: dict) -> None:
    root = ensure_drive(b.db, b.project)
    for nid in dict.fromkeys(str(x) for x in op.get("nodeIds") or []):
        n = _node(b, nid, visible=False)
        if n.trashed_at is None:
            if not tree.is_hidden(b.db, n):
                continue
            raise HTTPException(422, f"{n.name} is inside a folder in the Trash: restore that folder")
        parent = b.db.get(SourceNode, n.parent_id) if n.parent_id else None
        if parent is None or tree.is_hidden(b.db, parent):
            parent = root
            b.warnings.append(f"{n.name} went back to {root.name}: its folder is gone")
        if parent.locked:
            parent = root
        name = n.name
        existing = sibling(b.db, parent.id, name, exclude=[n.id])
        if existing is not None:
            res = b.resolution(n.id)
            if res == "skip":
                b.skipped_resolution += 1
                continue
            if res != "keep_both":
                b.conflict(n.id, name, parent, existing, n.is_dir)
                continue
            name = tree.free_name(name, taken_names(b.db, parent.id), is_dir=n.is_dir)
        before = snap(n, ("parent_id", "name", "name_dup", "sequence_key", "trashed_at", "trashed_by", "trash_batch_id"))
        set_state(b, n, {"parent_id": parent.id, "name": name, "name_dup": 0, "sequence_key": None if n.is_dir else tree.sequence_key(name), "trashed_at": None, "trashed_by": None, "trash_batch_id": None})
        b.journal("restore", n.id, before, snap(n, ("parent_id", "name", "name_dup", "sequence_key", "trashed_at", "trashed_by", "trash_batch_id")))
        b.counts["restore"] += 1
        b.mark(n)
        if name != before["name"]:
            b.renamed.add(n.id)
        b.moved.add(n.id)


def _purge(b: Batch, op: dict) -> None:
    roots = []
    for nid in dict.fromkeys(str(x) for x in op.get("nodeIds") or []):
        n = _node(b, nid, visible=False)
        if n.trashed_at is None:
            raise HTTPException(422, f"Move {n.name} to the Trash first")
        roots.append(n)
    if roots:
        plan = purge_plan(b.db, b.project, roots)
        purge_apply(b, plan)


# ---- Purge (D8) --------------------------------------------------------------------------------


@dataclass
class PurgePlan:
    roots: list[SourceNode]
    node_ids: list[str]
    delete_assets: list[Asset]
    kept: list[dict]


def purge_plan(db: Session, p: ProjectRow, roots: list[SourceNode]) -> PurgePlan:
    """What purging `roots` (and everything below them) deletes, and which bytes it keeps."""
    ids: list[str] = []
    names: dict[str, str] = {}
    for r in roots:
        for row in tree.subtree(db, r.id, into_trash=True):
            if row.id not in names:
                ids.append(row.id)
                names[row.id] = row.name
    gone = set(ids)
    candidates: dict[str, str] = {}  # asset id → a name to show
    for i in range(0, len(ids), 500):
        chunk = ids[i : i + 500]
        for nid, aid in db.execute(select(SourceNode.id, SourceNode.asset_id).where(SourceNode.id.in_(chunk), SourceNode.asset_id.is_not(None))):
            candidates.setdefault(str(aid), names.get(nid, "a file"))
        for nid, aid in db.execute(select(NodeVersion.node_id, NodeVersion.asset_id).where(NodeVersion.node_id.in_(chunk), NodeVersion.asset_id.is_not(None))):
            candidates.setdefault(str(aid), names.get(nid, "a file"))
    reasons: dict[str, str] = {}
    aids = list(candidates)
    for i in range(0, len(aids), 500):
        chunk = aids[i : i + 500]
        for nid, aid, name in db.execute(select(SourceNode.id, SourceNode.asset_id, SourceNode.name).where(SourceNode.asset_id.in_(chunk))):
            if nid not in gone and aid:
                reasons.setdefault(aid, "another file has the same bytes")
        for nid, aid in db.execute(select(NodeVersion.node_id, NodeVersion.asset_id).where(NodeVersion.asset_id.in_(chunk))):
            if nid not in gone and aid and aid not in reasons:
                owner = db.get(SourceNode, nid)
                reasons[aid] = f"a version of {owner.name if owner else 'another file'} uses it"
    for d in db.scalars(select(DatasetRow).where(DatasetRow.project_id == p.id)):
        for f in (d.definition or {}).get("files") or []:
            if isinstance(f, dict) and f.get("assetId") in candidates:
                reasons.setdefault(str(f["assetId"]), f"the {d.title} dataset uses it")
    by_path = {a.path: a for a in db.scalars(select(Asset).where(Asset.id.in_(aids)))} if aids else {}
    if by_path:
        for doc in db.scalars(select(AnnotationDocumentRow).where(AnnotationDocumentRow.workspace_id == p.id)):
            for a in doc.annotations or []:
                item = a.get("itemId") if isinstance(a, dict) else None
                if item in by_path:
                    reasons.setdefault(by_path[item].id, "annotations are drawn on it")
    # Bytes another asset row still names (a sample copy shares its template's keys, todo14 D2;
    # any other project or workspace) are never deleted with this one.
    paths, shared = [a.path for a in by_path.values()], set()
    for i in range(0, len(paths), 500):
        shared |= set(db.scalars(select(Asset.path).where(Asset.path.in_(paths[i : i + 500]), Asset.id.not_in(aids))))
    for a in by_path.values():
        if a.path in shared:
            reasons.setdefault(a.id, "another project uses the same bytes")
    delete_assets, kept = [], []
    for aid, name in candidates.items():
        a = next((x for x in by_path.values() if x.id == aid), None)
        if aid in reasons:
            kept.append({"name": name, "reason": f"Kept: {reasons[aid]}"})
        elif a is not None and a.path.startswith(assets.UPLOAD_PREFIX):
            delete_assets.append(a)
    return PurgePlan(roots, ids, delete_assets, kept)


def purge_apply(b: Batch, plan: PurgePlan) -> None:
    db = b.db
    from . import trash  # files deleted forever leave the datasets that held them (todo16 D5)

    trash.drop_purged(db, b.ctx, b.project, set(plan.node_ids))
    for r in plan.roots:
        b.journal("purge", r.id, {"name": r.name, "parent_id": r.parent_id, "is_dir": r.is_dir}, None)
        b.parents.add(r.parent_id or "")
        b.mark(r)
    for i in range(0, len(plan.node_ids), 500):
        chunk = plan.node_ids[i : i + 500]
        db.execute(delete(NodeVersion).where(NodeVersion.node_id.in_(chunk)))
        db.execute(delete(NodeStar).where(NodeStar.node_id.in_(chunk)))
        db.execute(delete(NodeRecent).where(NodeRecent.node_id.in_(chunk)))
        db.execute(delete(SourceNode).where(SourceNode.id.in_(chunk)))
    keys = []
    for a in plan.delete_assets:
        keys.append(a.path)
        db.delete(a)
    db.expire_all()
    if keys:
        aftercommit.defer(db, _delete_blobs, keys)
    b.counts["purge"] += len(plan.roots)
    b.purged += len(plan.node_ids)
    b.kept.extend(plan.kept)
    b.undoable = False


def _delete_blobs(keys: list[str]) -> None:
    store = blobstore.data()
    for k in keys:
        store.delete(k)


# ---- Versions (D6) -----------------------------------------------------------------------------


def _next_version(db: Session, n: SourceNode) -> int:
    return max(n.version or 1, db.scalar(select(func.max(NodeVersion.version)).where(NodeVersion.node_id == n.id)) or 0) + 1


def _snapshot_current(db: Session, n: SourceNode) -> None:
    """The current version's row keeps what inspection said, so restoring it brings that back."""
    v = db.get(NodeVersion, (n.id, n.version or 1))
    if v is None:
        db.add(NodeVersion(node_id=n.id, version=n.version or 1, project_id=n.project_id, asset_id=n.asset_id, sha256=n.sha256, size=n.size, detected_kind=n.detected_kind, facts=n.facts or {}, flags=n.flags or {}, created_by="system", created_at=n.created_at))
    else:
        v.detected_kind, v.facts, v.flags = n.detected_kind, n.facts or {}, n.flags or {}
    db.flush()


def _replace(b: Batch, n: SourceNode, asset_id: str | None, sha: str | None, size: int | None, *, kind: str | None = None, facts: dict | None = None, flags: dict | None = None, session_id: str | None = None, op_kind: str = "replace") -> int:
    if n.is_dir:
        raise HTTPException(422, "Only a file can have versions")
    _writable(n)
    db = b.db
    _snapshot_current(db, n)
    version = _next_version(db, n)
    before = snap(n, CONTENT)
    new = {"asset_id": asset_id, "sha256": sha, "size": size, "version": version, "detected_kind": kind, "facts": dict(facts or {}), "flags": dict(flags or {})}
    if session_id is not None:
        new["import_session_id"] = session_id
    set_state(b, n, new)
    nv = NodeVersion(node_id=n.id, version=version, project_id=n.project_id, asset_id=asset_id, sha256=sha, size=size, detected_kind=kind, facts=dict(facts or {}), flags=dict(flags or {}), created_by=b.actor, created_at=b.at)
    db.add(nv)
    db.flush()
    after = snap(n, CONTENT) | {"_nv": version_row(nv)}
    b.journal(op_kind, n.id, before, after)
    b.counts[op_kind] += 1
    b.mark(n)
    return version


def replace_with_upload(db: Session, ctx: RequestContext, p: ProjectRow, n: SourceNode, asset_id: str, sha: str, size: int, session_id: str) -> Batch:
    """A replace-mode upload completed: the node points at the new asset (D6) and goes back
    to "Checking…" until inspection reports on the new bytes."""
    b = Batch(db, ctx, p)
    if tree.is_hidden(db, n):
        raise HTTPException(422, f"{n.name} is in the Trash: restore it first")
    _replace(b, n, asset_id, sha, size, session_id=session_id)
    finish(b)
    return b


def restore_version(db: Session, ctx: RequestContext, p: ProjectRow, n: SourceNode, version: int) -> dict:
    only_people(ctx)
    v = db.get(NodeVersion, (n.id, version))
    if v is None:
        raise HTTPException(404, "No such version")
    if version == n.version:
        raise HTTPException(409, "That's already the current version")
    b = Batch(db, ctx, p)
    if tree.is_hidden(db, n):
        raise HTTPException(422, f"{n.name} is in the Trash: restore it first")
    _replace(b, n, v.asset_id, v.sha256, v.size, kind=v.detected_kind, facts=v.facts, flags=v.flags, op_kind="restore_version")
    finish(b)
    return result(b)


def versions(db: Session, n: SourceNode) -> list[dict]:
    rows = list(db.scalars(select(NodeVersion).where(NodeVersion.node_id == n.id).order_by(NodeVersion.version.desc())))
    if not rows and not n.is_dir:
        return [{"version": n.version or 1, "assetId": n.asset_id, "sha256": n.sha256, "size": n.size, "createdBy": "system", "createdAt": _iso(n.created_at), "current": True}]
    return [{"version": v.version, "assetId": v.asset_id, "sha256": v.sha256, "size": v.size, "createdBy": v.created_by, "createdAt": _iso(v.created_at), "current": v.version == n.version} for v in rows]


def _iso(d: datetime | None) -> str | None:
    from .projects import iso

    return iso(d)


# ---- apply -------------------------------------------------------------------------------------


def apply(db: Session, ctx: RequestContext, p: ProjectRow, body: dict, *, check: Callable[[Batch], Any] | None = None, dry_run: bool = False) -> dict:
    """`POST /v1/projects/:id/fs/ops`: all or nothing. `check(batch)` runs the write pipeline
    (todo17 D1) on the applied batch before it is recorded; it raises to reject the whole batch
    and returns the admission (its findings ride on the result). `dry_run`: the caller rolls
    the transaction back; the batch is not recorded."""
    ops = body.get("ops")
    purges = [o for o in ops if isinstance(o, dict) and o.get("kind") == "purge"] if isinstance(ops, list) else []
    only_people(ctx, destroy=bool(purges))
    if isinstance(ops, list) and any(isinstance(o, dict) and o.get("kind") == "trash" for o in ops):
        from ..auth import scopes

        scopes.require_tier(ctx, "trash", "Moving files to the Trash")  # todo17 D12 (tokens only)
    if purges:
        approvals.verify(db, ctx, operation="source.purge", project_id=p.id, targets=[str(i) for o in purges for i in (o.get("nodeIds") if isinstance(o.get("nodeIds"), list) else [])])
    if not isinstance(ops, list) or not ops:
        raise HTTPException(422, "ops must list at least one operation")
    if len(ops) > 1000:
        raise HTTPException(413, "At most 1,000 operations per request")
    raw_res = body.get("resolutions") or {}
    if not isinstance(raw_res, dict):
        raise HTTPException(422, "resolutions must be an object")
    bad = {v for v in raw_res.values() if v not in RESOLUTIONS}
    if bad:
        raise HTTPException(422, f"a resolution is one of {', '.join(sorted(RESOLUTIONS))}")
    ensure_drive(db, p)
    b = Batch(db, ctx, p, resolutions={str(k): str(v) for k, v in raw_res.items()})
    expect = body.get("expect") or {}
    if isinstance(expect, dict):
        for fid, rev in expect.items():
            f = db.get(SourceNode, str(fid))
            if f is not None and f.project_id == p.id and isinstance(rev, int) and (f.revision or 0) != rev:
                raise HTTPException(409, f"{f.name} changed since you loaded it. Reload and try again")
    handlers = {"mkdir": _mkdir, "rename": _rename, "move": _move, "copy": _copy, "trash": _trash, "restore": _restore, "purge": _purge}
    for i, op in enumerate(ops):
        if not isinstance(op, dict) or op.get("kind") not in handlers:
            raise HTTPException(422, f"ops[{i}].kind is one of {', '.join(sorted(handlers))}")
        if op["kind"] in ("move", "copy", "trash", "restore", "purge") and not isinstance(op.get("nodeIds"), list):
            raise HTTPException(422, f"ops[{i}].nodeIds must be a list")
        handlers[op["kind"]](b, op)
    if b.conflicts:
        n = len(b.conflicts)
        first = b.conflicts[0]
        what = "An item" if n == 1 else f"{n} items"
        msg = f'An item named "{first["name"]}" already exists in {first["parentName"]}' if n == 1 else f"{what} have the same name as something already there"
        raise HTTPException(409, {"message": msg, "conflicts": b.conflicts})
    admitted = check(b) if check is not None else None
    if dry_run:
        db.flush()
        out = result(b)
    else:
        finish(b)
        out = result(b)
    if admitted is not None:
        out["findings"] = admitted.findings_json()
    return out


def _label(b: Batch) -> str:
    kinds = [k for k in b.counts if b.counts[k]]
    n = sum(b.counts.values())
    noun = "item" if n == 1 else "items"
    if len(kinds) == 1:
        return f"{VERBS[kinds[0]][0]} of {n} {noun}"
    return f"change of {n} {noun}"


def _summary(b: Batch) -> str:
    kinds = [k for k in b.counts if b.counts[k]]
    n = sum(b.counts.values())
    if not kinds:
        return "Nothing changed"
    first = b.touched.get(b.top[0]) if b.top else None
    name = b.top_names[0] if b.top_names and n == 1 else f"{n} items"
    kind = kinds[0] if len(kinds) == 1 else None
    if kind == "mkdir":
        return f"Created folder {name}" if n == 1 else f"Created {n} folders"
    if kind == "rename":
        return f"Renamed to {name}" if n == 1 else f"Renamed {n} items"
    if kind in ("move", "copy") and b.target_name:
        return f"{VERBS[kind][1]} {name} to {b.target_name}"
    if kind == "trash":
        return f"Moved {name} to Trash"
    if kind == "purge":
        return f"Deleted {name} forever"
    if kind == "replace":
        return f"Added version {first.version if first else ''} of {first.name if first else 'a file'}".replace("  ", " ")
    if kind == "restore_version":
        return f"Restored an earlier version of {first.name if first else 'a file'}"
    if kind:
        return f"{VERBS[kind][1]} {name}"
    return f"Changed {n} items"


def finish(b: Batch, *, label: str | None = None, summary: str | None = None, reverts: str | None = None) -> None:
    """Write the batch row, one audit entry, `fs.changed`; re-run the name checks."""
    db = b.db
    db.flush()
    b.summary = summary or _summary(b)
    if not b.ops:
        return
    seq = max(op.id for op in b.ops)
    db.add(FsBatch(id=b.id, project_id=b.project.id, actor=b.actor, kind=b.kind, label=label or _label(b), summary=b.summary[:2000], undoable=b.undoable, reverts_batch_id=reverts, seq=seq, on_behalf_of=b.ctx.on_behalf_of, turn_id=b.ctx.turn_id, at=b.at))
    db.flush()
    after_names(b)
    scoped = b.ctx.for_scope(b.project.id, None)
    kinds = [k for k in b.counts if b.counts[k]]
    if b.kind in ("undo", "redo"):
        action = f"files.{'undone' if b.kind == 'undo' else 'redone'}"
    else:
        action = AUDIT.get(kinds[0], "files.changed") if len(kinds) == 1 else "files.changed"
    audit.record(db, scoped, action, target=b.id, after={"batchId": b.id, "counts": dict(b.counts), "items": sum(b.counts.values()), "nodeIds": b.top[:50], "label": label or _label(b)})
    parents = sorted(x for x in b.parents if x)
    events.publish(db, scoped, "fs.changed", {"projectId": b.project.id, "parentIds": parents[:500], "batchId": b.id, "actor": b.actor, "summary": b.summary, "nodeIds": list(b.touched)[:500]}, source="kernel")


def result(b: Batch) -> dict:
    out: dict[str, Any] = {
        "batchId": b.id,
        "nodes": [tree.node_dict(n) for n in b.touched.values() if _alive(b.db, n)],
        "parentIds": sorted(x for x in b.parents if x),
        "summary": b.summary or _summary(b),
    }
    if b.skipped_identical or b.skipped_resolution:
        out["skipped"] = {"identical": b.skipped_identical, "byResolution": b.skipped_resolution}
    if b.warnings:
        out["warnings"] = b.warnings
    return out


def _alive(db: Session, n: SourceNode) -> bool:
    from sqlalchemy import inspect as sa_inspect

    st = sa_inspect(n)
    return not st.deleted and not st.detached and not st.was_deleted


# ---- After a batch: privacy (Phase 7) and stale proposals --------------------------------------


def after_names(b: Batch) -> None:
    changed = b.renamed | b.moved
    if changed:
        recheck_privacy(b.db, b.ctx, b.project, changed, b.id)
    if b.renamed:
        mark_stale(b.db, b.project, b.renamed)


def _flagged_below(db: Session, ids: list[str]) -> list[SourceNode]:
    """Files at or below `ids` (not in Trash) that carry a privacy flag."""
    out: list[SourceNode] = []
    for i in range(0, len(ids), 200):
        batch = ids[i : i + 200]
        down = select(SourceNode.id, SourceNode.is_dir, SourceNode.flags).where(SourceNode.id.in_(batch)).cte("flagged", recursive=True)
        down = down.union_all(select(SourceNode.id, SourceNode.is_dir, SourceNode.flags).select_from(down).join(SourceNode, SourceNode.parent_id == down.c.id).where(SourceNode.trashed_at.is_(None)))
        hit = list(db.scalars(select(down.c.id).where(down.c.is_dir.is_(False), cast(down.c.flags, String).like('%"privacy"%'))))
        if hit:
            out.extend(db.scalars(select(SourceNode).where(SourceNode.id.in_(hit))))
    return out


def recheck_privacy(db: Session, ctx: RequestContext, p: ProjectRow, ids: Iterable[str], batch_id: str) -> list[str]:
    """Re-run the path-name check on the new paths. A hold raised only by a name clears when
    the new path is clean (audit `privacy.cleared`, reason "renamed"), and comes back if a
    later change (an undo) brings an identifying name back."""
    if not db.scalar(select(SourceNode.id).where(SourceNode.project_id == p.id, cast(SourceNode.flags, String).like('%"privacy"%')).limit(1)):
        return []
    files = _flagged_below(db, list(ids))
    if not files:
        return []
    paths = tree.chains(db, [f.id for f in files])
    changed: list[str] = []
    scoped = ctx.for_scope(p.id, None)
    for f in files:
        priv = (f.flags or {}).get("privacy") or {}
        if priv.get("source") != "path":
            continue
        c = paths.get(f.id)
        findings = privacy_names.path_findings(c.path if c else f.name)
        cleared = bool(priv.get("clearedBy"))
        if not findings and not cleared:
            f.flags = {**f.flags, "privacy": {**priv, "clearedBy": person(ctx), "clearedAt": _iso(now()), "clearReason": "renamed"}}
            audit.record(db, scoped, "privacy.cleared", target=f.id, before={"privacy": priv}, after={"reason": "renamed", "batchId": batch_id})
            changed.append(f.id)
        elif findings and cleared and priv.get("clearReason") == "renamed":
            held = {k: v for k, v in priv.items() if k not in ("clearedBy", "clearedAt", "clearReason")}
            f.flags = {**f.flags, "privacy": {**held, "findings": findings[:10], "reason": "Held: " + findings[0]}}
            audit.record(db, scoped, "privacy.held", target=f.id, after={"reason": "renamed back", "batchId": batch_id})
            changed.append(f.id)
    if changed:
        db.flush()
        events.publish(db, scoped, "source.node.inspected", {"projectId": p.id, "nodeIds": changed[:1000]}, source="kernel")
    return changed


def mark_stale(db: Session, p: ProjectRow, renamed: set[str]) -> int:
    """Open proposals that name a renamed node: `evidence.stale` (status unchanged); Explore
    offers "Re-check", which recomputes the proposal and clears it."""
    n = 0
    for pr in db.scalars(select(Proposal).where(Proposal.project_id == p.id, Proposal.status == "proposed")):
        text = json.dumps(pr.payload or {}) + json.dumps(pr.evidence or {})
        if any(r in text for r in renamed):
            if not (pr.evidence or {}).get("stale"):
                pr.evidence = {**(pr.evidence or {}), "stale": True, "staleReason": "Names changed since this was suggested"}
                n += 1
    return n


# ---- Undo and redo (D9) ------------------------------------------------------------------------


def _batch_ops(db: Session, batch_id: str) -> list[FsOp]:
    return list(db.scalars(select(FsOp).where(FsOp.batch_id == batch_id).order_by(FsOp.id)))


def _undo_candidate(db: Session, p: ProjectRow, actor: str) -> FsBatch | None:
    return db.scalars(select(FsBatch).where(FsBatch.project_id == p.id, FsBatch.actor == actor, FsBatch.kind.in_(("ops", "redo")), FsBatch.undone_by.is_(None)).order_by(FsBatch.seq.desc()).limit(1)).first()


def _redo_candidate(db: Session, p: ProjectRow, actor: str) -> FsBatch | None:
    u = db.scalars(select(FsBatch).where(FsBatch.project_id == p.id, FsBatch.actor == actor, FsBatch.kind == "undo", FsBatch.redone_by.is_(None)).order_by(FsBatch.seq.desc()).limit(1)).first()
    if u is None:
        return None
    newer = db.scalar(select(FsBatch.id).where(FsBatch.project_id == p.id, FsBatch.actor == actor, FsBatch.kind == "ops", FsBatch.seq > u.seq).limit(1))
    return None if newer else u


def history(db: Session, ctx: RequestContext, p: ProjectRow) -> dict:
    actor = person(ctx)
    u = _undo_candidate(db, p, actor)
    r = _redo_candidate(db, p, actor)
    return {"undo": {"batchId": u.id, "label": u.label} if u is not None and u.undoable else None, "redo": {"batchId": r.id, "label": r.label} if r is not None else None}


def _name_of(db: Session, op: FsOp) -> str:
    n = db.get(SourceNode, op.node_id)
    if n is not None:
        return n.name
    for state in (op.after, op.before):
        if isinstance(state, dict) and state.get("name"):
            return str(state["name"])
    return "a file"


def _refuse_if_touched_later(db: Session, ops: list[FsOp], verb: str) -> None:
    if not ops:
        return
    last = max(op.id for op in ops)
    touched = list({op.node_id for op in ops})
    for i in range(0, len(touched), 500):
        later = db.scalars(select(FsOp).where(FsOp.node_id.in_(touched[i : i + 500]), FsOp.id > last).order_by(FsOp.id).limit(1)).first()
        if later is not None:
            raise HTTPException(409, f"Can't {verb}: {_name_of(db, later)} changed after that")


def _apply_state(b: Batch, op: FsOp, state: dict | None, prior: dict | None, verb: str, created: set[str]) -> None:
    """Move node `op.node_id` from `prior` to `state` (either may be None: created / gone)."""
    db = b.db
    n = db.get(SourceNode, op.node_id)
    if state is None:
        # The op created this node: remove it again (children first: ops run in reverse).
        if n is None:
            return
        extra = db.scalar(select(SourceNode.id).where(SourceNode.parent_id == n.id, SourceNode.id.not_in(list(created) or [""])).limit(1))
        if extra:
            raise HTTPException(409, f"Can't {verb}: {n.name} isn't empty any more")
        b.journal(op.kind, n.id, row_of(n), None)
        if n.trashed_at is None and n.parent_id:
            files, size = tree.weight(n)
            tree.bump(db, n.parent_id, -files, -size, children=-1)
            b.parents.add(n.parent_id)
        db.execute(delete(NodeVersion).where(NodeVersion.node_id == n.id))
        db.execute(delete(NodeStar).where(NodeStar.node_id == n.id))
        db.delete(n)
        db.flush()
        return
    if prior is None:
        # Re-create what an undo removed (redo of mkdir / copy).
        if n is not None:
            return
        row = {k: v for k, v in state.items() if not k.startswith("_")}
        parent = db.get(SourceNode, row.get("parent_id")) if row.get("parent_id") else None
        if parent is None or tree.is_hidden(db, parent):
            raise HTTPException(409, f"Can't {verb}: the folder it was in is gone")
        clash = sibling(db, parent.id, str(row.get("name")))
        if clash is not None and row.get("trashed_at") is None:
            raise HTTPException(409, f"Can't {verb}: an item named {clash.name} is already in {parent.name}")
        node = SourceNode(**{k: _unjson(k, v) for k, v in row.items() if k in COLUMNS})
        # Counts of a re-created folder are rebuilt from its re-created children below.
        if node.is_dir:
            node.child_count = node.descendant_count = node.total_bytes = 0
        db.add(node)
        db.flush()
        if isinstance(state.get("_nv"), dict):
            db.merge(NodeVersion(**{k: _unjson(k, v) for k, v in state["_nv"].items()}))
        if node.trashed_at is None:
            files, size = tree.weight(node)
            tree.bump(db, parent.id, files, size, children=1)
        b.parents.add(parent.id)
        b.touched[node.id] = node
        b.journal(op.kind, node.id, None, state)
        db.flush()
        return
    if n is None:
        raise HTTPException(409, f"Can't {verb}: {_name_of(db, op)} was deleted forever")
    fields = {k: v for k, v in state.items() if not k.startswith("_")}
    target_parent = fields.get("parent_id", n.parent_id)
    target_name = fields.get("name", n.name)
    visible = fields.get("trashed_at", _json(n.trashed_at)) is None
    if visible and target_parent and (target_parent != n.parent_id or str(target_name).lower() != n.name.lower() or n.trashed_at is not None):
        parent = db.get(SourceNode, target_parent)
        if parent is None or tree.is_hidden(db, parent):
            raise HTTPException(409, f"Can't {verb}: the folder {n.name} was in is gone")
        clash = sibling(db, target_parent, str(target_name), exclude=[n.id])
        if clash is not None:
            raise HTTPException(409, f"Can't {verb}: an item named {clash.name} is already in {parent.name}")
    if n.locked:
        raise HTTPException(423, LOCKED)
    before = snap(n, list(fields))
    set_state(b, n, fields)
    # Versions: undoing a replace drops its version row; redoing it brings the row back.
    if isinstance((prior or {}).get("_nv"), dict) and op.kind in ("replace", "restore_version"):
        v = prior["_nv"]
        if state.get("version") != v.get("version"):
            db.execute(delete(NodeVersion).where(NodeVersion.node_id == n.id, NodeVersion.version == v.get("version")))
    if isinstance(state.get("_nv"), dict):
        db.merge(NodeVersion(**{k: _unjson(k, x) for k, x in state["_nv"].items()}))
    b.journal(op.kind, n.id, before, state)
    if "name" in fields and fields["name"] != before.get("name"):
        b.renamed.add(n.id)
    if "parent_id" in fields or "trashed_at" in fields:
        b.moved.add(n.id)


def undo(db: Session, ctx: RequestContext, p: ProjectRow, batch_id: str | None = None) -> dict:
    only_people(ctx)
    actor = person(ctx)
    if batch_id:
        target = db.get(FsBatch, batch_id)
        if target is None or target.project_id != p.id or target.actor != actor:
            raise HTTPException(404, "No such change of yours in this project")
    else:
        target = _undo_candidate(db, p, actor)
    if target is None:
        raise HTTPException(409, "Nothing to undo")
    if target.kind == "undo":
        raise HTTPException(409, "That was an undo: redo it instead")
    if target.undone_by:
        raise HTTPException(409, "That change is already undone")
    if not target.undoable:
        raise HTTPException(409, "Can't undo: deleting forever can't be undone")
    ops = _batch_ops(db, target.id)
    _refuse_if_touched_later(db, ops, "undo")
    b = Batch(db, ctx, p, kind="undo")
    created = {op.node_id for op in ops if op.before is None}
    for op in reversed(ops):
        _apply_state(b, op, op.before, op.after, "undo", created)
        op.undone_by_batch = b.id
        b.counts[op.kind] += 1
    target.undone_by = b.id
    finish(b, label=target.label, summary=f"Undid {target.label}", reverts=target.id)
    out = result(b)
    out["undoneBatchId"] = target.id
    nxt = _undo_candidate(db, p, actor)
    out["next"] = {"batchId": nxt.id, "label": nxt.label} if nxt is not None and nxt.undoable else None
    return out


def redo(db: Session, ctx: RequestContext, p: ProjectRow, batch_id: str | None = None) -> dict:
    only_people(ctx)
    actor = person(ctx)
    u: FsBatch | None
    if batch_id:
        u = db.get(FsBatch, batch_id)
        if u is not None and u.kind != "undo":
            u = db.get(FsBatch, u.undone_by) if u.undone_by else None
        if u is None or u.project_id != p.id or u.actor != actor:
            raise HTTPException(404, "No such undone change of yours in this project")
    else:
        u = _redo_candidate(db, p, actor)
    if u is None or u.redone_by:
        raise HTTPException(409, "Nothing to redo")
    original = db.get(FsBatch, u.reverts_batch_id) if u.reverts_batch_id else None
    if original is None:
        raise HTTPException(409, "Nothing to redo")
    _refuse_if_touched_later(db, _batch_ops(db, u.id), "redo")
    ops = _batch_ops(db, original.id)
    b = Batch(db, ctx, p, kind="redo")
    for op in ops:
        _apply_state(b, op, op.after, op.before, "redo", set())
        b.counts[op.kind] += 1
    u.redone_by = b.id
    finish(b, label=original.label, summary=f"Redid {original.label}", reverts=u.id)
    out = result(b)
    out["undoneBatchId"] = u.id
    nxt = _undo_candidate(db, p, actor)
    out["next"] = {"batchId": nxt.id, "label": nxt.label} if nxt is not None and nxt.undoable else None
    return out


# ---- Trash listing and emptying ----------------------------------------------------------------


def trash_item(db: Session, n: SourceNode, chain: tree.Chain | None, starred: set[str] | None = None) -> dict:
    d = tree.node_dict(n, starred=starred)
    parent_hidden = chain is None or len(chain.ids) < 2 or any(t is not None for t in chain.trashed[:-1])
    location = None if parent_hidden or chain is None else (chain.folder or tree.ROOT_NAME)
    at = n.trashed_at if n.trashed_at is None or n.trashed_at.tzinfo else n.trashed_at.replace(tzinfo=UTC)
    days = settings().trash_days
    left = days - (now() - at).days if at else days
    d.update(trashedAt=_iso(n.trashed_at), trashedBy=n.trashed_by or "", originalLocation=location, purgeInDays=max(0, left))
    return d


def trash_page(db: Session, p: ProjectRow, cursor: str | None = None, limit: int = 200) -> dict:
    try:
        start = int(cursor or 0)
    except ValueError:
        raise HTTPException(422, "bad cursor") from None
    q = select(SourceNode).where(SourceNode.project_id == p.id, SourceNode.trashed_at.is_not(None))
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = list(db.scalars(q.order_by(SourceNode.trashed_at.desc(), SourceNode.id).offset(start).limit(limit)))
    ch = tree.chains(db, [n.id for n in rows])
    items = [trash_item(db, n, ch.get(n.id)) for n in rows]
    nxt = start + limit if start + limit < total else None
    return {"items": items, "nextCursor": str(nxt) if nxt is not None else None, "total": total}


def empty_trash(db: Session, ctx: RequestContext, p: ProjectRow, *, dry_run: bool = False, older_than: datetime | None = None) -> dict:
    if not dry_run and older_than is None:
        only_people(ctx, destroy=True)
        approvals.verify(db, ctx, operation="trash.empty", project_id=p.id)
    q = select(SourceNode).where(SourceNode.project_id == p.id, SourceNode.trashed_at.is_not(None))
    if older_than is not None:
        q = q.where(SourceNode.trashed_at < older_than)
    roots = list(db.scalars(q))
    if not roots:
        return {"purged": 0, "keptBytes": []}
    plan = purge_plan(db, p, roots)
    if dry_run:
        return {"purged": len(plan.node_ids), "keptBytes": plan.kept}
    b = Batch(db, ctx, p)
    purge_apply(b, plan)
    finish(b)
    return {"purged": b.purged, "keptBytes": b.kept}


def purge_expired(db: Session, *, days: int = TRASH_DAYS) -> dict:
    """The `files.empty_trash` job: purge what has been in Trash longer than `days`, in every
    project, keeping bytes still referenced (D8)."""
    cutoff = now() - timedelta(days=days)
    projects = list(db.scalars(select(SourceNode.project_id).where(SourceNode.trashed_at.is_not(None), SourceNode.trashed_at < cutoff).distinct()))
    total = 0
    kept = 0
    for pid in projects:
        p = db.get(ProjectRow, pid)
        if p is None:
            continue
        ctx = RequestContext(p.id, "system:trash", uuid.uuid4().hex)
        out = empty_trash(db, ctx, p, older_than=cutoff)
        total += out["purged"]
        kept += len(out["keptBytes"])
    return {"projects": len(projects), "purged": total, "kept": kept}


# ---- Stars and recent --------------------------------------------------------------------------


def starred_ids(db: Session, project_id: str, principal: str) -> set[str]:
    return set(db.scalars(select(NodeStar.node_id).where(NodeStar.project_id == project_id, NodeStar.principal == principal)))


def star(db: Session, ctx: RequestContext, n: SourceNode, on: bool) -> dict:
    who = person(ctx)
    row = db.get(NodeStar, (n.id, who))
    if on and row is None:
        db.add(NodeStar(node_id=n.id, principal=who, project_id=n.project_id))
    elif not on and row is not None:
        db.delete(row)
    db.flush()
    return {"starred": on}


def shortcuts(db: Session, ctx: RequestContext, p: ProjectRow, which: str, limit: int = 50) -> dict:
    who = person(ctx)
    pairs: list[tuple[str, datetime | None]] = []
    if which == "starred":
        pairs = [(s.node_id, s.at) for s in db.scalars(select(NodeStar).where(NodeStar.project_id == p.id, NodeStar.principal == who).order_by(NodeStar.at.desc()).limit(limit * 2))]
    else:
        seen: dict[str, datetime | None] = {}
        for nid, at in db.execute(select(FsOp.node_id, FsOp.at).where(FsOp.project_id == p.id, FsOp.actor == who).order_by(FsOp.id.desc()).limit(400)):
            seen.setdefault(nid, at)
        for r in db.scalars(select(NodeRecent).where(NodeRecent.project_id == p.id, NodeRecent.principal == who).order_by(NodeRecent.at.desc()).limit(200)):
            if r.node_id not in seen or ((prev := _aware(seen[r.node_id])) is not None and r.at and (cur := _aware(r.at)) is not None and cur > prev):
                seen[r.node_id] = r.at
        pairs = sorted(seen.items(), key=lambda kv: _aware(kv[1]) or datetime.min.replace(tzinfo=UTC), reverse=True)
    stars = starred_ids(db, p.id, who)
    ch = tree.chains(db, [nid for nid, _ in pairs[: limit * 2]])
    items = []
    for nid, at in pairs:
        n = db.get(SourceNode, nid)
        c = ch.get(nid)
        if n is None or n.project_id != p.id or n.parent_id is None or (c is not None and c.hidden):
            continue
        items.append({"node": tree.node_dict(n, starred=stars), "at": _iso(at)})
        if len(items) >= limit:
            break
    return {"items": items}


def _aware(d: datetime | None) -> datetime | None:
    return d if d is None or d.tzinfo else d.replace(tzinfo=UTC)


def opened(db: Session, ctx: RequestContext, n: SourceNode) -> None:
    """A person opened a node in the inspector (Recent)."""
    who = person(ctx)
    if ctx.scopes or not who.startswith("user:"):
        return
    row = db.get(NodeRecent, (n.id, who))
    if row is None:
        insert_ignore(db, NodeRecent, [{"node_id": n.id, "principal": who, "project_id": n.project_id, "at": now()}])
    else:
        row.at = now()


# ---- Activity per node -------------------------------------------------------------------------


def activity(db: Session, ctx: RequestContext, n: SourceNode, limit: int = 100) -> dict:
    """The node's own ops and its ancestors' moves and renames, newest first. Old names only
    for members (never for an agent token: they may hold what someone renamed away)."""
    private = not ctx.scopes and person(ctx).startswith("user:")
    chain = tree.chain_of(db, n)
    ancestors = [x for x in chain.ids if x != n.id]
    own = list(db.scalars(select(FsOp).where(FsOp.node_id == n.id).order_by(FsOp.id.desc()).limit(limit)))
    up = list(db.scalars(select(FsOp).where(FsOp.node_id.in_(ancestors), FsOp.kind.in_(("move", "rename"))).order_by(FsOp.id.desc()).limit(limit))) if ancestors else []
    kinds = {b.id: b.kind for b in db.scalars(select(FsBatch).where(FsBatch.id.in_(list({o.batch_id for o in own + up}))))} if own or up else {}
    names: dict[str, str] = {}

    def name(nid: str | None) -> str:
        if not nid:
            return "a folder"
        if nid not in names:
            x = db.get(SourceNode, nid)
            names[nid] = x.name if x is not None else "a folder that's gone"
        return names[nid]

    out = []
    for op in sorted(own + up, key=lambda o: o.id, reverse=True)[:limit]:
        before, after = op.before or {}, op.after or {}
        mine = op.node_id == n.id
        subject = "" if mine else f"{name(op.node_id)} "
        if op.kind == "rename":
            text = f"{subject}renamed from {before.get('name')}" if private else f"{subject}renamed"
        elif op.kind == "move":
            text = f"{subject}moved to {name(after.get('parent_id'))}" + (f" from {name(before.get('parent_id'))}" if private else "")
        elif op.kind == "mkdir":
            text = "created"
        elif op.kind == "copy":
            text = "copied here" if after else "copy removed"
        elif op.kind == "trash":
            text = "moved to Trash" if after.get("trashed_at") else "taken out of the Trash"
        elif op.kind == "restore":
            text = "restored from the Trash" if not after.get("trashed_at") else "put back in the Trash"
        elif op.kind == "replace":
            text = f"replaced: version {after.get('version')}"
        elif op.kind == "restore_version":
            text = f"restored as version {after.get('version')}"
        else:
            text = op.kind.replace("_", " ")
        bk = kinds.get(op.batch_id, "ops")
        if bk in ("undo", "redo"):
            text = f"{'undo' if bk == 'undo' else 'redo'}: {text}"
        text = text[0].upper() + text[1:]
        out.append({"id": f"op:{op.id}", "batchId": op.batch_id, "kind": bk if bk in ("undo", "redo") else op.kind, "actor": op.actor, "at": _iso(op.at), "text": text, "nodeId": op.node_id})
    return {"items": out}
