"""todo16 D9: an assistant turn's changes, journaled in Postgres (not in the agent's memory).

Every `fs_batches` row an assistant writes carries the person it acted for (`on_behalf_of`) and
its turn (`turn_id`, the agent's `X-Turn-Id` header). A turn is listed and undone here:

    GET  /api/v1/projects/{pid}/turns/{turnId}        { turnId, summary, batches, undoable }
    POST /api/v1/projects/{pid}/turns/{turnId}/undo   { turnId, undone, batchIds }

`latest` as the turn id means the caller's newest turn other than the one asking (its own
`X-Turn-Id`): "undo what you just did" without the agent remembering anything.

Undo walks the turn's batches newest first: file changes through `fs.undo` (which refuses with
409 if a later change touched the same files), trashed things back from the Trash. One
transaction: a refusal anywhere leaves everything as it was.
"""

from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..context import RequestContext
from ..models import FsBatch, ProjectRow
from . import fs, projects, trash

# Batch kinds a turn is made of (its own undos and redos are not changes to undo).
CHANGES = ("ops", "trash")


LATEST = "latest"


def resolve(db: Session, ctx: RequestContext, p: ProjectRow, turn_id: str) -> str:
    if turn_id != LATEST:
        return turn_id
    q = select(FsBatch.turn_id).where(FsBatch.project_id == p.id, FsBatch.turn_id.is_not(None), FsBatch.on_behalf_of == fs.person(ctx), FsBatch.kind.in_(CHANGES))
    if ctx.turn_id:
        q = q.where(FsBatch.turn_id != ctx.turn_id)
    found = db.scalars(q.order_by(FsBatch.at.desc()).limit(1)).first()
    if found is None:
        raise HTTPException(404, "Nothing to undo")
    return found


def batches(db: Session, project_id: str, turn_id: str) -> list[FsBatch]:
    """The turn's change batches, newest first."""
    q = select(FsBatch).where(FsBatch.project_id == project_id, FsBatch.turn_id == turn_id, FsBatch.kind.in_(CHANGES))
    return list(db.scalars(q.order_by(FsBatch.at.desc(), FsBatch.seq.desc())))


def summary(rows: list[FsBatch]) -> str:
    """'renamed 3 items, deleted dataset X', oldest change first."""
    parts = [r.summary or r.label for r in reversed(rows) if (r.summary or r.label)]
    return ", ".join(p[:1].lower() + p[1:] for p in parts)


def _open(r: FsBatch) -> bool:
    if r.kind == "trash":
        return r.state is None  # todo18: restored / destroyed batches stay as rows with a state
    return r.undoable and not r.undone_by


def is_latest(db: Session, project_id: str, rows: list[FsBatch]) -> bool:
    """Nothing changed in the project after the turn, and the turn still has something to undo."""
    if not rows or not any(_open(r) for r in rows):
        return False
    ids = {r.id for r in rows}
    newer = db.scalars(select(FsBatch.id).where(FsBatch.project_id == project_id, FsBatch.at > rows[0].at, FsBatch.kind != "undo")).all()
    return not [i for i in newer if i not in ids]


def batch_dict(r: FsBatch) -> dict:
    return {"batchId": r.id, "kind": r.kind, "resource": r.resource, "label": r.label, "summary": r.summary, "at": projects.iso(r.at), "undone": bool(r.undone_by), "undoable": _open(r)}


def get(db: Session, ctx: RequestContext, p: ProjectRow, turn_id: str) -> dict:
    turn_id = resolve(db, ctx, p, turn_id)
    rows = batches(db, p.id, turn_id)
    if not rows:
        raise HTTPException(404, "No changes in that turn")
    who = rows[0].on_behalf_of or rows[0].actor
    return {"turnId": turn_id, "onBehalfOf": who, "summary": summary(rows), "batches": [batch_dict(r) for r in rows], "undoable": is_latest(db, p.id, rows)}


def undo(db: Session, ctx: RequestContext, p: ProjectRow, turn_id: str) -> dict:
    turn_id = resolve(db, ctx, p, turn_id)
    rows = batches(db, p.id, turn_id)
    if not rows:
        raise HTTPException(404, "No changes in that turn")
    if any(r.kind == "ops" and not r.undoable and not r.undone_by for r in rows):
        raise HTTPException(409, "Can't undo that turn: it deleted something forever")
    done: list[str] = []
    for r in rows:
        if r.kind == "trash":
            if r.state is not None:
                continue
            trash.restore(db, ctx, p, r.id)
        elif not r.undone_by:
            fs.undo(db, ctx, p, r.id)
        else:
            continue
        done.append(r.id)
    return {"turnId": turn_id, "undone": len(done), "batchIds": done}
