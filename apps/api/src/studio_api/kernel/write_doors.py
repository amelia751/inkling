"""Files, imports and datasets through the write pipeline (todo17 D1, D6, D8, D13).

The routes in `routes/files.py`, `routes/sources.py`, `routes/projects.py` and `routes/trash.py`
call these helpers: `check_paths` (layout family on the paths a write would leave behind),
`check_dataset` (datasets family on a dataset's name and metadata), and `idempotent` (the
request's `Idempotency-Key`, stored in the request's own transaction so the reply and the write
commit together). A dry run runs the full pipeline and the route rolls the transaction back.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from datetime import UTC, datetime
from typing import Any

from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..context import RequestContext
from ..models import DatasetRow, IdempotencyKey, ProjectRow, SourceNode
from . import tree
from .admission import Admitted, Ctx, Operation, admit, register
from .admission.http import WriteParams
from .admission.idempotency import TTL, IdempotencyError, Replay, _check, body_hash
from .lint import datasets as lint_datasets
from .lint import layout as lint_layout

# Operation ids follow packages/contracts/src/operations.ts (todo16 D7); source.batch (the fs/ops
# batch), source.redo, import.create, dataset.update, project.create and project.restore are new.
FILES_OPS = register(Operation(id="source.batch", families=[lint_layout.check]))
FILES_UNDO = register(Operation(id="source.undo"))
FILES_REDO = register(Operation(id="source.redo"))
IMPORTS_CREATE = register(Operation(id="import.create", families=[lint_layout.check]))
DATASETS_CREATE = register(Operation(id="dataset.create", families=[lint_datasets.check]))
DATASETS_UPDATE = register(Operation(id="dataset.update", families=[lint_datasets.check]))
PROJECTS_CREATE = register(Operation(id="project.create"))
TRASH_RESTORE = register(Operation(id="trash.restore", tier="trash"))
PROJECTS_RESTORE = register(Operation(id="project.restore", tier="trash"))

METADATA_KEYS = ("modality", "license", "source", "description")
PATH_CAP = 2000  # paths checked per write (a folder move checks the files below it, up to this)


def project_rules(db: Session, p: ProjectRow) -> dict[str, Any]:
    from . import rules as krules

    return dict(krules.get(db, p)["rules"])


def admission_ctx(db: Session, ctx: RequestContext, p: ProjectRow, **extra: Any) -> Ctx:
    return Ctx(project_id=p.id, principal=ctx.principal, on_behalf_of=ctx.on_behalf_of, rules=project_rules(db, p), extra=extra)


def admit_plain(db: Session, ctx: RequestContext, p: ProjectRow, op: Operation, data: dict | None = None, *, dry_run: bool = False) -> Admitted:
    """An operation with no rule family (undo, restore, create): normalise and permit only."""
    return admit(op, data or {}, Ctx(project_id=p.id, principal=ctx.principal, on_behalf_of=ctx.on_behalf_of, rules={}), dry_run=dry_run)


# ---- Files -------------------------------------------------------------------------------------


def check_paths(db: Session, ctx: RequestContext, p: ProjectRow, op: Operation, paths: Iterable[str], folders: Iterable[str] = (), *, dry_run: bool = False) -> Admitted:
    """Raises WriteRejected (422, every violation) on an enforced error; else the findings."""
    data = {"paths": list(dict.fromkeys(paths))[:PATH_CAP], "folders": sorted(set(folders))}
    return admit(op, data, admission_ctx(db, ctx, p), dry_run=dry_run)


def batch_paths(db: Session, ids: Iterable[str]) -> tuple[list[str], list[str]]:
    """Where the nodes a batch created, renamed, moved or copied now live (and, for folders, the
    files below them), relative to the drive root. Returns (paths, folder paths)."""
    nodes = [n for n in (db.get(SourceNode, i) for i in dict.fromkeys(ids)) if n is not None and n.trashed_at is None]
    dirs = [n.id for n in nodes if n.is_dir]
    below = tree.files_under(db, dirs)[:PATH_CAP] if dirs else []
    by_id = tree.paths_of(db, [n.id for n in nodes] + [f.id for f in below])
    paths = [by_id[i] for i in by_id if by_id[i]]
    folders = [by_id[i] for i in dirs if by_id.get(i)]
    return paths, folders


def normalise_rel(rel: str, forbidden: str) -> tuple[str, bool]:
    """Forbidden characters in an upload's path become `_` (layout.forbidden-char is fixable):
    an upload is never refused for a character the project rules forbid."""
    if not forbidden:
        return rel, False
    out = "".join("_" if c in forbidden and c != "/" else c for c in rel)
    return out, out != rel


# ---- Datasets ----------------------------------------------------------------------------------


def dataset_names(db: Session, p: ProjectRow, exclude: str | None = None) -> list[str]:
    q = select(DatasetRow.title).where(DatasetRow.project_id == p.id, DatasetRow.trashed_at.is_(None))
    if exclude:
        q = q.where(DatasetRow.id != exclude)
    return list(db.scalars(q))


def metadata_of(body: dict, *, description: str | None = None, base: dict | None = None) -> dict[str, Any]:
    meta = dict(base or {})
    raw = body.get("metadata")
    if isinstance(raw, dict):
        meta.update({k: v for k, v in raw.items() if isinstance(k, str)})
    for k in METADATA_KEYS:  # top-level fields are accepted too (`{"license": …}`)
        if k in body and k != "description":
            meta[k] = body[k]
    if description is not None:
        meta["description"] = description
    return meta


def modalities(db: Session, node_ids: list[str], meta: dict) -> list[str]:
    mods = {str(meta["modality"])} if meta.get("modality") else set()
    if node_ids:
        for f in tree.files_under(db, node_ids)[:PATH_CAP]:
            m = (f.facts or {}).get("modality") if isinstance(f.facts, dict) else None
            if isinstance(m, str) and m:
                mods.add(m)
    return sorted(mods)


def check_dataset(db: Session, ctx: RequestContext, p: ProjectRow, op: Operation, name: str, meta: dict, mods: list[str], *, exclude: str | None = None, dry_run: bool = False) -> Admitted:
    data = {"dataset": {"name": name, "metadata": meta, "modalities": mods}, "existingNames": dataset_names(db, p, exclude)}
    return admit(op, data, admission_ctx(db, ctx, p), dry_run=dry_run)


# ---- Idempotency in the request's transaction --------------------------------------------------


class SessionIdempotencyStore:
    """`idempotency_keys` through the request's session: the stored reply commits with the
    write, and a rolled-back write leaves no key behind."""

    def __init__(self, db: Session):
        self.db = db

    def begin(self, key: str, principal: str, op_id: str, digest: str) -> Replay | None:
        row = self.db.get(IdempotencyKey, (key, principal))
        now = datetime.now(UTC)
        if row is not None:
            at = row.created_at if row.created_at.tzinfo else row.created_at.replace(tzinfo=UTC)
            if now - at > TTL:
                self.db.delete(row)
                self.db.flush()
                row = None
        if row is None:
            try:
                with self.db.begin_nested():
                    self.db.add(IdempotencyKey(key=key, principal=principal, op_id=op_id, body_hash=digest, status="in_progress", response=None, created_at=now))
                return None
            except IntegrityError:
                row = self.db.get(IdempotencyKey, (key, principal), populate_existing=True)
                if row is None:
                    raise IdempotencyError(409, "idempotency_in_progress", "A request with this Idempotency-Key is still running.") from None
        _check(row.op_id, row.body_hash, row.status, op_id, digest)
        stored = row.response or {}
        return Replay(int(stored.get("status") or 200), stored.get("body"))

    def complete(self, key: str, principal: str, status: int, response: Any) -> None:
        row = self.db.get(IdempotencyKey, (key, principal))
        if row is not None:
            row.status, row.response = "done", {"status": status, "body": response}
            self.db.flush()

    def abort(self, key: str, principal: str) -> None:
        pass  # the failed request's transaction rolls back, key and all


def idempotent(db: Session, ctx: RequestContext, w: WriteParams, op: Operation, body: Any, fn: Callable[[], Any], *, status: int = 200) -> Any:
    """Run `fn()` once per Idempotency-Key; a replay answers with the stored reply (same status).
    A dry run is never stored. Returns `fn()`'s value, or a JSONResponse for a replay."""
    if not w.idempotency_key or w.dry_run:
        return fn()
    store = SessionIdempotencyStore(db)
    replay = store.begin(w.idempotency_key, ctx.on_behalf_of or ctx.principal, op.id, body_hash(body))
    if replay is not None:
        return JSONResponse(replay.response, status_code=replay.status, headers={"Idempotent-Replayed": "true"})
    out = fn()
    store.complete(w.idempotency_key, ctx.on_behalf_of or ctx.principal, status, out)
    return out


def dry_run_reply(db: Session, body: dict[str, Any], admitted: Admitted | None = None) -> dict[str, Any]:
    """Nothing is saved: roll the request's transaction back and say so."""
    db.rollback()
    return {**body, "dryRun": True, "findings": admitted.findings_json() if admitted is not None else body.get("findings", [])}
