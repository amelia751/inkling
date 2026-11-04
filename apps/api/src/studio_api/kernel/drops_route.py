"""Routing a drop's files one by one (todo28 D1, D2, D5, D6, D7; W2).

A file is *ready* the moment it is checked and clear (a kind the Studio can show, no privacy
hold), whatever its neighbours are doing. A drop attached to a Studio (`drops.task_id`: the
Studio it was dropped in, or the one the assistant booted with `dropId`) sends each ready file
into that Studio's dataset as it's reported, if the Studio takes its kind; otherwise the file
waits in Sources and counts as `waiting_kind`. Unchecked and held files are never routed.

The kernel publishes milestones for the assistant (never one per file), each at most once per
reason: `drop.kind_waiting` the first time a kind has ready files the Studio doesn't take,
`drop.files_failed` when more files have failed than last said, `drop.settled` when the drop
settles (drops.settle). The agent service claims them with subscriber `agent-drops`.

Who decides (D5): for a chat drop (it has a conversation) in an org with the assistant on, the
assistant does; the classifier only suggests. Elsewhere (Sources, Datasets, `aiAssist: false`)
the classifier's fast path and auto-apply place the files, so routing leaves those drops to it
unless a boot attached them explicitly.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..context import RequestContext
from ..models import Drop, ImportSession, Organization, ProjectRow, SourceNode, TaskRow
from . import collections, drops, events

SUBSCRIBER = "agent-drops"
MILESTONES = ("drop.kind_waiting", "drop.files_failed", "drop.settled")


def assistant_orchestrates(db: Session, d: Drop) -> bool:
    """D5: a chat drop (it has a conversation) in an org whose assistant is on."""
    if not d.conversation_id:
        return False
    p = db.get(ProjectRow, d.project_id)
    org = db.get(Organization, p.org_id) if p is not None and p.org_id else None
    return org is None or bool(org.ai_assist)


def routes(db: Session, d: Drop) -> bool:
    """Whether the kernel routes this drop's ready files into its Studio as they're checked."""
    if not d.task_id:
        return False
    return bool((d.declared or {}).get("attached")) or assistant_orchestrates(db, d)


def attached_task(db: Session, d: Drop) -> TaskRow | None:
    t = db.get(TaskRow, d.task_id) if d.task_id else None
    return t if t is not None and t.project_id == d.project_id and t.trashed_at is None else None


def _ctx(ctx_or_project_id: RequestContext | str) -> RequestContext:
    if isinstance(ctx_or_project_id, RequestContext):
        return ctx_or_project_id
    return RequestContext(ctx_or_project_id, "kernel:drops", uuid.uuid4().hex)


def _drop_of(db: Session, s: ImportSession | None) -> Drop | None:
    if s is None:
        return None
    did = s.drop_id or (s.totals or {}).get("dropId")
    return db.get(Drop, did) if did else None


def attach(db: Session, ctx: RequestContext, d: Drop, t: TaskRow) -> list[str]:
    """D6: the drop fills Studio `t` from now on; its files already ready join now (one write).
    Returns the node ids newly pinned."""
    d.task_id = t.id
    d.declared = {**(d.declared or {}), "attached": True}
    db.flush()
    take = [n.id for _s, _f, n in drops._rows(db, d) if n is not None and drops._node_state(n, d) == "ready" and collections.task_takes(db, t, collections.collection_kind(n.detected_kind, n.facts))]
    added = collections.add_for_task(db, ctx, t, take) if take else []
    milestones(db, ctx, d)
    return added


def route_ready(db: Session, ctx_or_project_id: RequestContext | str, node_ids: list[str]) -> None:
    """Send the ready files among `node_ids` into their drop's Studio (one write per drop, so a
    group joins together), then publish whatever milestone that changed."""
    if not node_ids:
        return
    ctx = _ctx(ctx_or_project_id)
    by_drop: dict[str, tuple[Drop, list[SourceNode]]] = {}
    sessions: dict[str, ImportSession | None] = {}
    ids = list(dict.fromkeys(node_ids))
    for i in range(0, len(ids), 500):
        for n in db.scalars(select(SourceNode).where(SourceNode.id.in_(ids[i : i + 500]), SourceNode.is_dir.is_(False))):
            sid = n.import_session_id or ""
            if sid not in sessions:
                sessions[sid] = db.get(ImportSession, sid) if sid else None
            d = _drop_of(db, sessions[sid])
            if d is not None:
                by_drop.setdefault(d.id, (d, []))[1].append(n)
    for d, nodes in by_drop.values():
        if not routes(db, d):
            continue
        t = attached_task(db, d)
        if t is None:
            continue
        take = [n.id for n in nodes if drops._node_state(n, d) == "ready" and collections.task_takes(db, t, collections.collection_kind(n.detected_kind, n.facts))]
        if take:
            collections.add_for_task(db, ctx, t, take)
        milestones(db, ctx, d)


def milestones(db: Session, ctx: RequestContext | None, d: Drop, *, settled: bool = False) -> None:
    """`drop.kind_waiting` once per kind, `drop.files_failed` when the failed count grew, and
    `drop.settled` (when `settled`). Recorded in `declared.milestones` so each is said once."""
    c = drops.counts(db, d)
    ctx = ctx or _ctx(d.project_id)
    said = dict((d.declared or {}).get("milestones") or {})
    kinds = list(said.get("kinds") or [])
    changed = False
    for kind, n in sorted(c["waitingForKind"].items()):
        if kind not in kinds:
            kinds.append(kind)
            changed = True
            _publish(db, ctx, d, "drop.kind_waiting", {"kind": kind, "count": n})
    if c["failed"] > int(said.get("failed") or 0):
        said["failed"] = c["failed"]
        changed = True
        _publish(db, ctx, d, "drop.files_failed", {"count": c["failed"], "reasons": c["failedReasons"]})
    if settled:
        _publish(db, ctx, d, "drop.settled", {"inStudio": c["inStudio"], "waitingForKind": c["waitingForKind"], "failed": c["failed"], **({"studioTaskId": c["studioTaskId"]} if c["studioTaskId"] else {})})
    if changed:
        d.declared = {**(d.declared or {}), "milestones": {**said, "kinds": kinds}}
        db.flush()


def _publish(db: Session, ctx: RequestContext, d: Drop, type_: str, payload: dict) -> None:
    extra = {"conversationId": d.conversation_id} if d.conversation_id else {}
    events.publish(db, ctx.for_scope(d.project_id, None), type_, {"projectId": d.project_id, "dropId": d.id, **extra, **payload}, source="kernel")
