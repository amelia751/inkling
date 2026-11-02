"""Purge deletes everything it made (todo18 D8).

`run(db, kind, ids)` is called by `kernel/trash.py` *before* the rows go, for `files` (node ids),
`datasets` (dataset ids) and `project` (one project id). It finds what the rows don't own
directly:

- derived blobs: thumbnails and previews the ingest worker wrote (`TaskItem.meta`), inspection
  derivatives (`SourceNode` facts/flags), and transcodes/tiles from `kernel/derivatives.py`
  when that module exists (W2; imported lazily);
- versioning repos of the datasets (`dataset_repos`): the service deletes each repo, then GCs.

It deletes the rows it found (assets of the derived keys) in the same transaction and defers
the blob and repo deletes to after commit. A delete that fails there is a `blob_delete_retries`
row (logged, counted), retried by the daily `blobs.retry` worker route. Annotation payloads
(`versioned_annotation_payloads`) are keyed by the project, so a project destroy deletes them
with its rows; a dataset's repo delete drops its revisions in the service.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .. import aftercommit, blobstore
from ..context import RequestContext
from ..models import Asset, BlobDeleteRetry, DatasetRepo, SourceNode, TaskItem, now

log = logging.getLogger(__name__)

DERIVED = "/derived/"
FAILED = {"blob": 0, "repo": 0}  # process counters for /metrics-style logging (tests read them)


def _strings(v: Any) -> Iterable[str]:
    if isinstance(v, str):
        yield v
    elif isinstance(v, dict):
        for x in v.values():
            yield from _strings(x)
    elif isinstance(v, list):
        for x in v:
            yield from _strings(x)


def _derived_in(*blobs: Any) -> set[str]:
    return {s for b in blobs for s in _strings(b) if DERIVED in s}


def _derivative_keys(db: Session, node_ids: list[str]) -> set[str]:
    try:
        from . import derivatives  # W2 (todo18): transcodes and tiles
    except ImportError:
        return set()
    return set(derivatives.derived_keys(db, node_ids))


def _file_keys(db: Session, project_id: str, node_ids: list[str]) -> set[str]:
    ids = set(node_ids)
    keys: set[str] = set()
    for i in range(0, len(node_ids), 500):
        chunk = node_ids[i : i + 500]
        for ti in db.scalars(select(TaskItem).where(TaskItem.node_id.in_(chunk))):
            keys |= _derived_in(ti.meta)
        for n in db.scalars(select(SourceNode).where(SourceNode.id.in_(chunk))):
            keys |= _derived_in(getattr(n, "facts", None), getattr(n, "flags", None))
    keys |= _derivative_keys(db, node_ids)
    if not keys or not project_id:
        return keys
    # Derived blobs are content-addressed: a file that stays may share one (same thumbnail).
    for ti in db.scalars(select(TaskItem).where(TaskItem.project_id == project_id, TaskItem.node_id.not_in(ids))):
        keys -= _derived_in(ti.meta)
    return keys


def _shared(db: Session, project_id: str, keys: set[str]) -> set[str]:
    out: set[str] = set()
    kl = sorted(keys)
    for i in range(0, len(kl), 500):
        out |= set(db.scalars(select(Asset.path).where(Asset.path.in_(kl[i : i + 500]), Asset.workspace_id != project_id)))
    return out


def run(db: Session, kind: str, ids: list[str], *, project_id: str | None = None) -> dict:
    """Collect and schedule the deletes for `kind` in files | datasets | project (see module doc)."""
    ids = [str(i) for i in ids if i]
    if not ids:
        return {"blobs": 0, "repos": 0}
    keys: set[str] = set()
    repos: list[tuple[str, str]] = []
    if kind == "files":
        pid = project_id or db.scalar(select(SourceNode.project_id).where(SourceNode.id == ids[0])) or ""
        keys = _file_keys(db, pid, ids)
    elif kind == "datasets":
        pid = project_id or ""
        repos = [(r.workspace_id, r.repo_id) for r in db.scalars(select(DatasetRepo).where(DatasetRepo.dataset_id.in_(ids)))]
    elif kind == "project":
        pid = ids[0]
        node_ids = list(db.scalars(select(SourceNode.id).where(SourceNode.project_id == pid)))
        keys = _derivative_keys(db, node_ids) if node_ids else set()
        repos = [(r.workspace_id, r.repo_id) for r in db.scalars(select(DatasetRepo).where(DatasetRepo.workspace_id == pid))]
    else:
        raise ValueError(f"unknown purge kind {kind!r}")
    keys -= _shared(db, pid, keys)
    if keys and pid:
        kl = sorted(keys)
        for i in range(0, len(kl), 500):
            db.execute(delete(Asset).where(Asset.workspace_id == pid, Asset.path.in_(kl[i : i + 500])))
    if keys or repos:
        aftercommit.defer(db, apply, sorted(keys), repos)
    return {"blobs": len(keys), "repos": len(repos)}


# ---- After commit ------------------------------------------------------------------------------


def _delete_blob(key: str) -> None:
    try:
        blobstore.data().delete(key)
    except blobstore.BlobNotFound:
        pass  # already gone


def _delete_repo(workspace_id: str, repo_id: str) -> None:
    from .versioning import auth, client

    c = client.client()
    if not hasattr(c, "delete_repo"):
        raise NotImplementedError("the versioning client can't delete repos yet")
    ctx = RequestContext(workspace_id, "kernel:purge", "purge")
    c.delete_repo(auth.mint(ctx, ["versioning:admin"]), repo_id)
    if hasattr(c, "gc"):
        c.gc(auth.mint(ctx, ["versioning:admin"]))


def _attempt(kind: str, target: str) -> str | None:
    try:
        if kind == "blob":
            _delete_blob(target)
        else:
            ws, _, rid = target.partition(":")
            _delete_repo(ws, rid)
        return None
    except Exception as e:  # noqa: BLE001
        return f"{type(e).__name__}: {e}"[:512]


def _record(failed: list[tuple[str, str, str]]) -> None:
    from ..db import session_scope

    for kind, target, err in failed:
        FAILED[kind] += 1
        log.warning("purge: %s delete failed (%s); queued for blobs.retry: %s", kind, err, target)
    with session_scope() as s:
        for kind, target, err in failed:
            s.add(BlobDeleteRetry(kind=kind, target=target, attempts=1, last_error=err))


def apply(keys: list[str], repos: list[tuple[str, str]]) -> None:
    """Delete the blobs and repos; what fails becomes a `blob_delete_retries` row."""
    todo = [("blob", k) for k in keys] + [("repo", f"{ws}:{rid}") for ws, rid in repos]
    failed = [(k, t, e) for k, t in todo if (e := _attempt(k, t)) is not None]
    if failed:
        _record(failed)


def defer_blob_deletes(db: Session, keys: list[str]) -> None:
    """After commit, delete these BlobStore keys; failures go to the retry table."""
    if keys:
        aftercommit.defer(db, apply, list(keys), [])


def sweep(db: Session, *, limit: int = 1000) -> dict:
    """The daily `blobs.retry`: try every queued delete again; a success removes its row."""
    done = still = 0
    for r in db.scalars(select(BlobDeleteRetry).order_by(BlobDeleteRetry.id).limit(limit)).all():
        err = _attempt(r.kind, r.target)
        if err is None:
            db.delete(r)
            done += 1
        else:
            r.attempts, r.last_error, r.updated_at = r.attempts + 1, err, now()
            still += 1
    db.flush()
    if still:
        log.warning("blobs.retry: %d deletes still failing", still)
    log.info("blobs.retry: deleted %d, %d still failing", done, still)
    return {"deleted": done, "failing": still}
