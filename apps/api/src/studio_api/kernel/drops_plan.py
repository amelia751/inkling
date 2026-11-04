"""Drop plans (todo13 D5, D6, D9, §4 Milestone 2 items 1–3, 6): classify a drop after inspection,
store and announce its plan, apply it (datasets, collections, Studios) and undo it.

    classify_drop    after inspection: groups (`drop.classified`) and a plan (`drop.planned`);
                     then the fast path (principle 3) or D6's auto-apply, or it waits for a click
    apply            a person (or, for D6-safe plans, an agent or the kernel on the person's
                     behalf) applies the plan: draft dataset and collections, then a draft Studio
                     per new viewable collection (the boot route's `collectionId`); with the
                     pipeline configured and a versioned dataset, also one ingest run per import
                     session (D9); `drop.applied` either way
    undo             within `API_DROP_UNDO_SECONDS`, takes back exactly what the apply created
                     (Files are never touched: principle 2)

A drop's files are found through its import sessions. The `drops` table and
`import_sessions.drop_id` are todo13-drops'; until they merge, `drop_of(session)` also reads
`totals.dropId`, and the drop's context (task, dataset, who dropped) comes from the drop row
when it exists, else from the sessions. Everything here goes through `drop_of` and
`_drop_row`, the two seams the integrator reconciles.

Logs (§7.3): one JSON line per transition, `drop.<state>` (classified, planned, applied, undone,
failed) with dropId, state, elapsed_ms since `drop.received`, origin and counts by kind (never
names).
"""

from __future__ import annotations

import logging
import re
import time
import uuid
from collections import Counter
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session, object_session

from .. import models
from ..config import settings
from ..context import RequestContext
from ..models import (
    AnnotationDocumentRow,
    Boot,
    DatasetCollectionRow,
    DatasetRepo,
    DatasetRow,
    DropPlanRow,
    ImportSession,
    ProjectRow,
    SourceNode,
    TaskRow,
    UploadFile,
    WorkspaceEnvironment,
    WorkspaceEnvironmentRevision,
    now,
)
from . import audit, collections, drop_flags, drops_classify as dc, events, intents, projects, structure, tree
from .kinds import kind_from_extension, mask_volumes, wfdb_parts

log = logging.getLogger("studio_api.drops")
ACTION_TYPES = {"add_to_collection", "new_collection", "new_dataset", "unpack", "keep_reference", "keep_unsupported", "link_existing"}
APPLYABLE = ("planned", "undone", "failed")
# Asks that hold a plan for the person (the rest are offers shown beside an action).
QUESTIONS = ("labels_table", "tabular_collection", "which_dataset")


# ---- Seams with todo13-drops ------------------------------------------------------------------


def drop_of(s: ImportSession) -> str | None:
    """The drop an import session belongs to (`import_sessions.drop_id`, else `totals.dropId`)."""
    v = getattr(s, "drop_id", None) or (s.totals or {}).get("dropId")
    return str(v) if v else None


def _drop_row(db: Session, drop_id: str):
    model = getattr(models, "Drop", None)
    return db.get(model, drop_id) if model is not None else None


# The plan's state as the `drops` row shows it (§5: uploading|inspecting|classified|planned|applied|failed).
_DROP_STATE = {"planned": "planned", "applying": "planned", "undone": "planned", "applied": "applied", "failed": "failed"}


def _sync_drop(db: Session, row: DropPlanRow) -> None:
    """Keep the drop's own state in step with its plan (Datasets' "Needs attention" reads it)."""
    d = _drop_row(db, row.drop_id)
    if d is not None and row.state in _DROP_STATE:
        # todo20 D5: a drop of only known files stays `duplicate` once applied (linked into the Studio).
        acts = (row.plan or {}).get("actions") or []
        if row.state == "applied" and acts and all(x.get("type") == "link_existing" for x in acts):
            d.state = "duplicate"
        elif not (d.state == "duplicate" and row.state == "applied"):
            d.state = _DROP_STATE[row.state]
        ds = (row.applied or {}).get("datasetId") or (row.context or {}).get("datasetId")
        if ds and not getattr(d, "dataset_id", None):
            d.dataset_id = ds


def sessions_of(db: Session, project_id: str, drop_id: str) -> list[ImportSession]:
    """A drop's import sessions: those with `import_sessions.drop_id` (todo13-drops), plus those
    that name it in `totals.dropId` (an archive's unpacked contents, a child drop with no row)."""
    q = select(ImportSession).where(ImportSession.project_id == project_id)
    by_col = list(db.scalars(q.where(ImportSession.drop_id == drop_id)))
    seen = {x.id for x in by_col}
    by_totals = [x for x in db.scalars(q.where(ImportSession.drop_id.is_(None))) if x.id not in seen and drop_of(x) == drop_id]
    return by_col + by_totals


def drop_context(db: Session, project_id: str, drop_id: str, sessions: list[ImportSession]) -> dict:
    """{taskId?, datasetId?, origin, createdBy, request?, parentDropId?}: the drop row's, else the sessions'."""
    row = _drop_row(db, drop_id)
    out: dict = {"origin": "files"}
    if row is not None:
        out.update({k: v for k, v in {"taskId": getattr(row, "task_id", None), "datasetId": getattr(row, "dataset_id", None), "origin": getattr(row, "origin", None) or "chat", "createdBy": getattr(row, "created_by", None)}.items() if v})
    for s in sessions:
        t = s.totals or {}
        for src, dst in (("taskId", "taskId"), ("datasetId", "datasetId"), ("request", "request"), ("parentDropId", "parentDropId"), ("origin", "origin")):
            if t.get(src) and dst not in out:
                out[dst] = t[src]
        out.setdefault("createdBy", s.created_by)
    if out.get("taskId") and not out.get("datasetId"):
        t = db.get(TaskRow, out["taskId"])
        if t is not None and t.project_id == project_id:
            out["datasetId"] = t.dataset_id
    return out


# ---- Gathering the classifier's inputs --------------------------------------------------------


def gather(db: Session, project_id: str, sessions: list[ImportSession]) -> list[dc.FileIn]:
    """The drop's files as classifier inputs: each committed node, and for each file skipped as a
    duplicate, the File that already holds those bytes (`existing`)."""
    ids = [s.id for s in sessions]
    files: list[dc.FileIn] = []
    if not ids:
        return files
    committed = [n for n in db.scalars(select(SourceNode).where(SourceNode.import_session_id.in_(ids), SourceNode.is_dir.is_(False)).order_by(SourceNode.created_at, SourceNode.id)) if not tree.is_hidden(db, n)]
    parts = wfdb_parts([(n.id, n.parent_id, n.name) for n in committed])
    # A subject's reference segmentation (`<subject>_seg`) goes with its volumes, not a Masks group.
    parts.update(mask_volumes([(n.id, n.parent_id, n.name, n.detected_kind or kind_from_extension(n.name)) for n in committed]))
    for n in committed:
        files.append(dc.FileIn(n.id, n.detected_kind, kind_from_extension(n.name), dict(n.facts or {}), dict(n.flags or {}), part_of=parts.get(n.id)))
    dup_shas = [f.sha256 for f in db.scalars(select(UploadFile).where(UploadFile.session_id.in_(ids), UploadFile.state == "skipped_duplicate"))]
    if dup_shas:
        seen = {f.node_id for f in files}
        for n in db.scalars(select(SourceNode).where(SourceNode.project_id == project_id, SourceNode.sha256.in_(dup_shas), SourceNode.is_dir.is_(False), SourceNode.trashed_at.is_(None))):
            if n.id not in seen:
                seen.add(n.id)
                files.append(dc.FileIn(n.id, n.detected_kind, kind_from_extension(n.name), dict(n.facts or {}), dict(n.flags or {}), existing=True))
    return files


def dataset_in(db: Session, d: DatasetRow | None, person: str) -> dc.DatasetIn | None:
    if d is None:
        return None
    rows = collections.ensure(db, None, d)
    return dc.DatasetIn(d.id, draft=projects.is_draft_dataset(db, d), own=d.created_by == person, collections=[dc.CollectionIn(c.id, c.name, c.kind, dict(c.shape or {})) for c in rows])


# ---- Classify ------------------------------------------------------------------------------


def _service_ctx(project_id: str, principal: str) -> RequestContext:
    """The kernel acting for the person who dropped (auto-apply, fast path, unpack)."""
    return RequestContext(workspace_id=project_id, principal=principal, correlation_id=uuid.uuid4().hex)


def _started(row: DropPlanRow) -> datetime | None:
    """When the drop was received (`drops.created_at`), so `elapsed_ms` is since `drop.received`
    (§7.3); the plan's own time for drops without a row (an unpacked archive's child drop)."""
    db = object_session(row)
    d = db.get(models.Drop, row.drop_id) if db is not None else None
    t = d.created_at if d is not None and d.created_at else row.created_at
    return t.replace(tzinfo=UTC) if t and t.tzinfo is None else t


def _log(row: DropPlanRow, state: str, **extra) -> None:
    """One JSON line per transition (§7.3): ids, state, elapsed, origin, counts by kind; never names."""
    started = _started(row)
    elapsed = int((datetime.now(UTC) - started).total_seconds() * 1000) if started else None
    kinds = Counter()
    for g in row.groups or []:
        kinds[g.get("kind") or "unknown"] += int(g.get("count") or 0)
    log.info(f"drop.{state}", extra={"event": f"drop.{state}", "dropId": row.drop_id, "state": state, "elapsed_ms": elapsed, "origin": (row.context or {}).get("origin"), "byKind": dict(kinds), **extra})


def log_failed(drop_id: str, step: str, error_class: str, db: Session | None = None) -> None:
    """`drop.failed` as a log line (the event's twin), for the failures-by-step metric (§7.3)."""
    d = db.get(models.Drop, drop_id) if db is not None and drop_id else None
    started = d.created_at.replace(tzinfo=UTC) if d is not None and d.created_at and d.created_at.tzinfo is None else (d.created_at if d is not None else None)
    elapsed = int((datetime.now(UTC) - started).total_seconds() * 1000) if started else None
    log.info("drop.failed", extra={"event": "drop.failed", "dropId": drop_id, "state": "failed", "step": step, "errorClass": error_class, "elapsed_ms": elapsed, **({"origin": d.origin} if d is not None else {})})


def after_inspection(db: Session, s: ImportSession) -> DropPlanRow | None:
    """Hook at the end of `inspection.report`. Failures never fail the inspection report.

    todo28 D5: for a chat drop with the assistant on, the drop is classified on every inspected
    batch (groups and `suggestedAction` for the assistant to read), never applied or
    fast-pathed: the assistant picks the Studio and the kernel routes ready files into it
    (drops_route). Elsewhere (no conversation, or `aiAssist: false`) the classifier still
    classifies once every session is inspected and fast-paths or auto-applies as before."""
    from . import drops_route

    drop_id = drop_of(s)
    if not drop_id:
        return None
    sessions = sessions_of(db, s.project_id, drop_id)
    busy = [x for x in sessions if x.state in ("uploading", "inspecting")]
    d = _drop_row(db, drop_id)
    suggest_only = d is not None and drops_route.assistant_orchestrates(db, d)
    if busy:
        if not suggest_only:
            return None
        sessions = [x for x in sessions if x not in busy]
        if not sessions:
            return None
    try:
        with db.begin_nested():
            return classify_drop(db, s.project_id, drop_id, sessions, may_apply=not suggest_only)
    except Exception as e:  # noqa: BLE001 — the inspection itself stands; the card says the step failed
        log.exception("drop classification failed", extra={"dropId": drop_id})
        p = db.get(ProjectRow, s.project_id)
        if p is not None:
            events.publish(db, _service_ctx(p.id, "kernel:drops"), "drop.failed", {"dropId": drop_id, "step": "classify", "errorClass": type(e).__name__}, source="kernel")
        log_failed(drop_id, "classify", type(e).__name__, db)
        return None


def classify_drop(db: Session, project_id: str, drop_id: str, sessions: list[ImportSession] | None = None, context: dict | None = None, *, may_apply: bool = True) -> DropPlanRow | None:
    """Classify, store the plan, announce it, then fast path or auto-apply when allowed
    (`may_apply`; never for a chat drop with the assistant on, todo28 D5)."""
    sessions = sessions if sessions is not None else sessions_of(db, project_id, drop_id)
    ctx_info = {**drop_context(db, project_id, drop_id, sessions), **(context or {})}
    person = str(ctx_info.get("createdBy") or "")
    files = gather(db, project_id, sessions)
    if not files:
        return None
    row = db.get(DropPlanRow, drop_id)
    parent_fast = False
    if row is not None and row.state in ("applied", "applying"):
        # New files of a drop that was already applied (a late session): a follow-up plan for
        # the sessions the first plan didn't cover.
        covered = set((row.context or {}).get("sessionIds") or [])
        parent_fast = bool(row.fast_path)
        # The rest belongs where the first plan put the files: its dataset (never a second one).
        parent_ds = (row.context or {}).get("datasetId") or next(iter((row.applied or {}).get("datasets") or []), None)
        if parent_ds and not ctx_info.get("datasetId"):
            ctx_info["datasetId"] = parent_ds
        sessions = [x for x in sessions if x.id not in covered] or sessions
        files = gather(db, project_id, sessions)
        if not files:
            return row
        drop_id = f"{drop_id}-{len(covered) + len(sessions)}"
        row = db.get(DropPlanRow, drop_id)
        if row is not None and row.state != "planned":
            return row
    d = db.get(DatasetRow, ctx_info["datasetId"]) if ctx_info.get("datasetId") else None
    if d is not None and d.project_id != project_id:
        d = None
    cctx = dc.Context(dataset=dataset_in(db, d, person), request=ctx_info.get("request"))
    groups = dc.classify(files, cctx)
    plan = dc.plan(drop_id, groups, cctx, intents.preset_for_kind)
    gdicts = [g.as_dict() for g in groups]
    if row is None:
        row = DropPlanRow(drop_id=drop_id, project_id=project_id, created_by=person or "user:unknown")
        db.add(row)
    row.state, row.plan, row.groups, row.context, row.error = "planned", plan, gdicts, {**ctx_info, "sessionIds": [x.id for x in sessions]}, None
    _sync_drop(db, row)
    db.flush()
    sctx = _service_ctx(project_id, "kernel:drops")
    events.publish(db, sctx, "drop.classified", {"dropId": drop_id, "groups": [g.as_dict(with_nodes=False) for g in groups]}, source="kernel")
    _log(row, "classified", groups=len(groups))
    fast = _fast_path_preset(groups, cctx, plan) if may_apply else None
    # The rest of a fast-path drop joins what its first files started, as the fast path did.
    auto = may_apply and (bool(fast) or ((drop_flags.enabled("auto_apply") or (parent_fast and drop_flags.enabled("fast_path"))) and dc.safe_to_auto_apply(plan)))
    row.auto = auto
    events.publish(db, sctx, "drop.planned", {"dropId": drop_id, "plan": plan, "auto": auto}, source="kernel")
    _log(row, "planned", auto=auto)
    if auto and person:
        try:
            with db.begin_nested():
                apply(db, _service_ctx(project_id, person), row, auto=True, fast_preset=fast)
        except Exception as e:  # noqa: BLE001 — the plan stays; the person can apply it by hand
            log.exception("drop auto-apply failed", extra={"dropId": drop_id})
            row = db.get(DropPlanRow, drop_id) or row
            row.state, row.error = "failed", {"step": "apply", "errorClass": type(e).__name__, "message": str(getattr(e, "detail", "") or "")[:300]}
            _sync_drop(db, row)
            db.flush()
            events.publish(db, sctx, "drop.failed", {"dropId": drop_id, "step": "apply", "errorClass": type(e).__name__}, source="kernel")
            log_failed(drop_id, "apply", type(e).__name__, db)
    return row


def _fast_path_preset(groups: list[dc.Group], cctx: dc.Context, plan: dict) -> str | None:
    """Principle 3: a drop that makes a new dataset boots now, without the agent: always one
    Studio, each kind with its own profile (todo19 D4/D5), so a mixed drop no longer needs an
    unambiguous preset. Only plans that touch nothing but new drafts. Returns the first profile."""
    if not drop_flags.enabled("fast_path") or cctx.dataset is not None or not dc.safe_to_auto_apply(plan):
        return None
    a = next((a for a in plan.get("actions") or [] if a.get("type") == "new_dataset" and a.get("kind") in dc.VIEWABLE), None)
    if a is None:
        return None
    presets = a.get("presets") or ([a["preset"]] if a.get("preset") else [])
    if not presets:
        m = intents.unambiguous(cctx.request, dc.fast_path_kinds(groups))
        return m.preset if m else None
    return presets[0]


# ---- Apply ----------------------------------------------------------------------------------


def _check_override(plan: dict, override: list) -> list[dict]:
    """"Change" on the card: another action per group, never other files. The person may move a
    group to another type, dataset or collection, or rename it; nodeIds can only shrink."""
    if not isinstance(override, list):
        raise HTTPException(422, "actions must be a list")
    by_group = {a["groupId"]: a for a in plan.get("actions") or []}
    out = []
    for i, a in enumerate(override):
        if not isinstance(a, dict) or a.get("groupId") not in by_group:
            raise HTTPException(422, f"actions[{i}]: no such group in this plan")
        base = by_group[a["groupId"]]
        t = a.get("type", base["type"])
        if t not in ACTION_TYPES:
            raise HTTPException(422, f"actions[{i}].type: unknown action")
        nodes = a.get("nodeIds", base["nodeIds"])
        if not isinstance(nodes, list) or not set(nodes) <= set(base["nodeIds"]):
            raise HTTPException(422, f"actions[{i}].nodeIds: only files of this group")
        merged = {**base, **{k: v for k, v in a.items() if k in ("type", "datasetId", "collectionId", "name", "preset", "relatesTo")}, "nodeIds": nodes}
        if a.get("type") and a["type"] != base["type"]:
            merged.pop("asks", None)  # a person chose: the question is answered
        if a.get("answer") == "yes":
            merged.pop("asks", None)
        out.append(merged)
    seen = {a["groupId"] for a in out}
    out += [a for g, a in by_group.items() if g not in seen]
    return out


def _boot_id(drop_id: str, group_id: str) -> str:
    raw = re.sub(r"[^A-Za-z0-9_-]", "-", f"drop-{drop_id}-{group_id}")
    return raw[:64] if len(raw) >= 8 else (raw + "-xxxxxxxx")[:8]


def _boot(db: Session, ctx: RequestContext, p: ProjectRow, drop_id: str, d: DatasetRow, presets: list[str], kinds: list[str], name: str, patch: list | None) -> list[str]:
    """todo19 D4/D5: the drop's one Studio: every kind's profile preset, accepting those kinds.
    todo20 D6: it's called "Studio" (`name` is the dataset's, for the log only)."""
    from . import boots

    body: dict = {"bootId": _boot_id(drop_id[:20], d.id), "extends": presets, "accepts": kinds, "datasetId": d.id, "name": "Studio", "dropId": drop_id}
    if patch:
        body["patch"] = patch
    status, out = boots.boot(db, ctx, p, body, {})
    if status != 202:
        raise HTTPException(status, out.get("errors") or out.get("error") or "the Studio couldn't be set up")
    return list(out.get("taskIds") or [])


def _boot_collection(db: Session, ctx: RequestContext, p: ProjectRow, drop_id: str, c: DatasetCollectionRow, preset: str, name: str, patch: list | None) -> list[str]:
    """A Studio bound to one collection: how drops booted before todo19 (one per kind). Re-plan
    still uses it for a legacy drop whose Studios are per collection."""
    from . import boots

    body: dict = {"bootId": _boot_id(drop_id[:20], c.id), "preset": preset, "collectionId": c.id, "name": f"{name} Studio", "dropId": drop_id}
    if patch:
        body["patch"] = patch
    status, out = boots.boot(db, ctx, p, body, {})
    if status != 202:
        raise HTTPException(status, out.get("errors") or out.get("error") or "the Studio couldn't be set up")
    return list(out.get("taskIds") or [])


# The rules before todo19 D5 (a Studio per collection), kept for tests that reproduce old drops.
PER_KIND_STUDIOS = False


def _facts_of(db: Session, node_ids: list[str]) -> list[dict]:
    return [dict(n.facts or {}) for n in db.scalars(select(SourceNode).where(SourceNode.id.in_(node_ids[:500])))] if node_ids else []


def _target_task(db: Session, p: ProjectRow, row: DropPlanRow) -> TaskRow | None:
    """todo20 D4: the Studio this drop adds to: the one it was dropped in (the drop's task), else
    the project's default Studio. None: the drop boots the default Studio."""
    tid = (row.context or {}).get("taskId")
    if tid:
        t = db.get(TaskRow, tid)
        if t is not None and t.project_id == p.id and t.trashed_at is None:
            return t
    return projects.default_task(db, p)


def apply(db: Session, ctx: RequestContext, row: DropPlanRow, override: list | None = None, *, auto: bool = False, fast_preset: str | None = None) -> dict:
    """Apply the plan (or the person's changed plan). Returns the plan state.

    todo20 D4: two outcomes. `new_default_studio`: the project has no Studio to add to, so the
    drop's dataset gets one Studio ("Studio") and it becomes `projects.default_task_id`.
    `add_to_studio`: the drop's files join the target Studio's dataset (a collection per kind)
    and the Studio accepts any new kinds. `link_existing` files (D5) join it the same way when
    it doesn't have them yet. Recorded in `applied.outcome`, `applied.studioTaskId`,
    `applied.new` and `applied.alreadyHere`."""
    if row.state == "applied":
        return state_dict(db, row)
    if row.state not in APPLYABLE:
        raise HTTPException(409, f"this plan is {row.state}")
    p = projects.require_project(db, ctx, row.project_id, write=True) if not auto else db.get(ProjectRow, row.project_id)
    assert p is not None
    actions = _check_override(row.plan, override) if override is not None else list(row.plan.get("actions") or [])
    is_agent = ctx.principal.startswith("agent:")
    if is_agent:
        effective = {**row.plan, "actions": actions, "needsPerson": override is None and bool(row.plan.get("needsPerson")) or any(a.get("asks") in QUESTIONS for a in actions)}
        if not dc.safe_to_auto_apply(effective):
            raise HTTPException(403, "an agent applies only plans that touch nothing but the person's own drafts (D6)")
        if ctx.on_behalf_of and ctx.on_behalf_of != row.created_by:
            raise HTTPException(403, "an agent applies a drop plan only for the person who dropped")
    # A person's Apply answers the card's questions with its default ("yes").
    row.state = "applying"
    db.flush()
    created: dict = {"datasets": [], "collections": [], "tasks": [], "refs": {}, "unpack": [], "pipelineRunIds": [], "pipelineErrors": []}
    request = (row.context or {}).get("request")
    labels = structure.labels_from_request(request)
    group_collection: dict[str, str] = {}
    dataset_of_plan: DatasetRow | None = None
    touched: dict[str, list[tuple[DatasetCollectionRow, list[dict]]]] = {}
    target = None if PER_KIND_STUDIOS else _target_task(db, p, row)
    if target is not None:
        dataset_of_plan = db.get(DatasetRow, target.dataset_id)
        if dataset_of_plan is None:
            target = None
    already_here: list[str] = []

    def new_dataset(name: str) -> DatasetRow:
        d = DatasetRow(id=projects.new_id("ds"), project_id=p.id, title=(name or "Dataset")[:256], description="", definition={"nodeIds": [], "files": [], "followedFolders": [], "draft": True, "dropId": row.drop_id}, created_by=row.created_by)
        db.add(d)
        db.flush()
        created["datasets"].append(d.id)
        audit.record(db, ctx.for_scope(p.id, None), "dataset.created", target=d.id, after={"title": d.title, "files": 0, "dropId": row.drop_id})
        return d

    def dataset(a: dict) -> DatasetRow:
        nonlocal dataset_of_plan
        if a.get("datasetId"):
            d = db.get(DatasetRow, a["datasetId"])
            if d is None or d.project_id != p.id:
                raise HTTPException(422, f"no dataset {a['datasetId']} in this project")
            return d
        if dataset_of_plan is None:
            dataset_of_plan = new_dataset(a.get("name") or "Dataset")
        return dataset_of_plan

    def pin(d: DatasetRow, c: DatasetCollectionRow, node_ids: list[str]) -> None:
        added = collections.add_files(db, d, c.id, node_ids)
        if added:
            created["refs"].setdefault(d.id, []).extend(added)
        touched.setdefault(d.id, []).append((c, _facts_of(db, node_ids)))

    task_ids: list[str] = []
    # todo19 D5: the Studio each dataset of this plan gets (one boot per dataset, not per kind).
    studios: dict[str, dict] = {}
    order = {"new_dataset": 0, "new_collection": 1, "add_to_collection": 2}
    for a in sorted(actions, key=lambda a: order.get(a["type"], 9)):
        t, nodes = a["type"], list(a.get("nodeIds") or [])
        if t in ("new_dataset", "new_collection"):
            d = dataset(a)
            chosen = set(nodes)
            # A folded action (classify.fold_members): a collection per member kind, organisational.
            members = a.get("members") or [{"groupId": a["groupId"], "kind": a.get("kind"), "name": a.get("name"), "preset": a.get("preset"), "nodeIds": nodes}]
            for m in members:
                kind = m.get("kind") or "image"
                shape = next((g.get("shape") for g in row.groups or [] if g.get("groupId") == m["groupId"]), None) or {}
                name = m.get("name") if a.get("members") else a.get("name")
                same = next((x for x in collections.of_dataset(db, d.id) if x.kind == kind), None) if target is not None and d.id == target.dataset_id else None
                if same is not None:
                    c = same
                else:
                    c = collections.create(db, ctx, d, kind, name, {k: v for k, v in shape.items() if k == "modality"})
                    created["collections"].append(c.id)
                group_collection[m["groupId"]] = c.id
                pin(d, c, [n for n in m.get("nodeIds") or [] if n in chosen])
                preset = m.get("preset") or intents.preset_for_kind(kind)
                if preset and c.kind in collections.VIEWABLE_COLLECTIONS and PER_KIND_STUDIOS:
                    ids = _boot_collection(db, ctx, p, row.drop_id, c, preset, name or c.name, None)
                    created["tasks"] += ids
                    task_ids += ids
                elif preset and c.kind in collections.VIEWABLE_COLLECTIONS:
                    s_ = studios.setdefault(d.id, {"d": d, "presets": [], "kinds": [], "name": a.get("name") or c.name, "labels": False})
                    s_["presets"].append(preset)
                    s_["kinds"].append(kind)
                    s_["labels"] = s_["labels"] or t == "new_dataset"
        elif t == "add_to_collection":
            c = db.get(DatasetCollectionRow, a.get("collectionId"))
            if c is None or c.project_id != p.id:
                raise HTTPException(422, "no such collection in this project")
            d = db.get(DatasetRow, c.dataset_id)
            assert d is not None
            pin(d, c, nodes)
            task_ids += [x.id for x in db.scalars(select(TaskRow).where(TaskRow.collection_id == c.id))]
            task_ids += [x.id for x in collections.accepting_tasks(db, d, c.kind)]
        elif t == "link_existing" and a.get("kind") in dc.VIEWABLE and nodes:
            # D5: files already in the project join the Studio when it doesn't have them yet.
            d = dataset(a)
            before = set(created["collections"])
            known = {c.id for c in collections.of_dataset(db, d.id)}
            added, there = collections.add_by_kind(db, ctx, d, nodes)
            created["collections"] += [c.id for c in collections.of_dataset(db, d.id) if c.id not in known and c.id not in before]
            already_here += there
            for kind, ids in added.items():
                created["refs"].setdefault(d.id, []).extend(ids)
                preset = intents.preset_for_kind(kind)
                if preset:
                    s_ = studios.setdefault(d.id, {"d": d, "presets": [], "kinds": [], "name": a.get("name") or "Studio", "labels": False})
                    s_["presets"].append(preset)
                    s_["kinds"].append(kind)
        elif t == "unpack":
            for nid in nodes:
                _request_unpack(db, row, nid)
                created["unpack"].append(nid)
    from . import boots

    for s_ in studios.values():
        presets, kinds = list(dict.fromkeys(s_["presets"])), list(dict.fromkeys(s_["kinds"]))
        if target is not None and s_["d"].id == target.dataset_id:
            boots.extend_task(db, ctx, p, target, presets, kinds)
            created["outcome"], created["studioTaskId"] = "add_to_studio", target.id
            task_ids.append(target.id)
            continue
        patch = structure.label_patch(labels) if labels and s_["labels"] else None
        ids = _boot(db, ctx, p, row.drop_id, s_["d"], presets, kinds, s_["name"] if len(kinds) == 1 else (s_["d"].title or "Dataset"), patch)
        created["tasks"] += ids
        task_ids += ids
        if ids and projects.default_task(db, p) is None:
            p.default_task_id = ids[0]
            created["defaultTaskId"] = ids[0]
        created.setdefault("outcome", "new_default_studio")
        created.setdefault("studioTaskId", ids[0] if ids else None)
    if target is not None and "outcome" not in created and (already_here or created["refs"]):
        # Nothing new for the Studio to accept, but its files are in it (D5).
        created["outcome"], created["studioTaskId"] = "add_to_studio", target.id
        task_ids.append(target.id)
    created["alreadyHere"] = len(set(already_here))
    created["new"] = sum(len(v) for v in created["refs"].values())
    # Labels tables: their relationship to the collection they describe (structure, suggested).
    rels = []
    for a in actions:
        if a.get("relatesTo") and a["groupId"] in group_collection:
            target = group_collection.get(a["relatesTo"], a["relatesTo"])
            rels.append({"id": f"rel-{group_collection[a['groupId']]}", "from": group_collection[a["groupId"]], "to": target, "cardinality": "1:1", "keys": ["name"]})
    for dsid, cols in touched.items():
        d = db.get(DatasetRow, dsid)
        if d is not None and projects.is_draft_dataset(db, d):
            structure.merge(db, ctx, d, cols, labels=labels if dsid in created["datasets"] else None, relationships=rels)
    target_ds = dataset_of_plan.id if dataset_of_plan is not None else next(iter(touched), None)
    _start_pipeline_runs(db, ctx, row, target_ds, created)
    created["taskIds"] = list(dict.fromkeys(task_ids))
    row.state, row.applied, row.applied_by, row.applied_at = "applied", created, ctx.principal, now()
    _sync_drop(db, row)
    row.fast_path = bool(fast_preset)
    reversible = bool(created["datasets"] or created["collections"] or created["tasks"] or created["refs"])
    row.undo_until = now() + timedelta(seconds=settings().drop_undo_seconds) if reversible else None
    row.context = {**(row.context or {}), "appliedActions": actions, "datasetId": (row.context or {}).get("datasetId") or target_ds}
    db.flush()
    payload = {"dropId": row.drop_id, **({"datasetId": target_ds} if target_ds else {}), "taskIds": list(dict.fromkeys(task_ids)), "undoUntil": projects.iso(row.undo_until), "collectionIds": created["collections"], "auto": auto, "fastPath": bool(fast_preset)}
    if created["pipelineRunIds"]:
        payload["pipelineRunIds"] = created["pipelineRunIds"]
    payload.update({"outcome": created.get("outcome"), "studioTaskId": created.get("studioTaskId"), "new": created["new"], "alreadyHere": created["alreadyHere"]})
    events.publish(db, ctx.for_scope(p.id, None), "drop.applied", payload, source="kernel")
    audit.record(db, ctx.for_scope(p.id, None), "drop.applied", target=row.drop_id, after={"auto": auto, "fastPath": bool(fast_preset), "datasets": created["datasets"], "collections": created["collections"], "tasks": created["tasks"], "files": sum(len(v) for v in created["refs"].values())})
    _log(row, "applied", auto=auto, fastPath=bool(fast_preset))
    return state_dict(db, row)


def _request_unpack(db: Session, row: DropPlanRow, node_id: str) -> None:
    depth = int((row.context or {}).get("depth") or 0)
    events.publish(
        db,
        _service_ctx(row.project_id, "kernel:drops"),
        "archive.unpack.requested",
        {"projectId": row.project_id, "dropId": row.drop_id, "nodeId": node_id, "childDropId": f"{row.drop_id}-u{node_id[-8:]}", "depth": depth + 1},
        source="kernel",
        idempotency_key=f"unpack:{row.drop_id}:{node_id}",
    )


def _start_pipeline_runs(db: Session, ctx: RequestContext, row: DropPlanRow, dataset_id: str | None, created: dict) -> None:
    """D9 after todo12 Milestone 1: each import session of the drop starts the implicit ingest
    run, its candidate proposed to the dataset's work branch. Without the pipeline service or a
    versioned dataset the kernel's own apply above is the whole story (the fallback)."""
    from . import pipeline_client

    if not dataset_id or not pipeline_client.configured():
        return
    repo = db.get(DatasetRepo, (row.project_id, dataset_id))
    if repo is None:
        return
    from .versioning.service import work_branch

    for sid in (row.context or {}).get("sessionIds") or []:
        body = {
            "workspace_id": row.project_id,
            "project_id": row.project_id,
            "definition_id": "ingest",
            "inputs": {"upload": {"session_id": sid}},
            "target": {"repo_id": repo.repo_id, "branch": work_branch(ctx, dataset_id)},
            "trigger": {"type": "upload.completed"},
            "idempotency_key": f"drop-apply:{row.drop_id}:{sid}",
            "actor": ctx.principal,
        }
        try:
            run = pipeline_client.client().create_run(ctx.for_scope(row.project_id, None), body, body["idempotency_key"])
            if isinstance(run, dict) and run.get("run_id"):
                created["pipelineRunIds"].append(str(run["run_id"]))
        except pipeline_client.PipelineError as e:
            created["pipelineErrors"].append({"sessionId": sid, "status": e.status})
            log.warning("drop.pipeline_failed", extra={"dropId": row.drop_id, "status": e.status})


def change(db: Session, ctx: RequestContext, row: DropPlanRow, actions: list) -> dict:
    """"Change" before apply (the person on the card, or the agent, D6): another action per
    group. Stays `planned`; `drop.planned` again with the new plan."""
    if row.state not in APPLYABLE:
        raise HTTPException(409, f"this plan is {row.state}")
    if ctx.principal.startswith(("plugin:", "worker:")):
        raise HTTPException(403, "only a person or their assistant changes a plan")
    projects.require_project(db, ctx, row.project_id, write=not ctx.principal.startswith("agent:"))
    merged = _check_override(row.plan, actions)
    plan = {**row.plan, "actions": merged, "needsPerson": any(a.get("asks") in QUESTIONS for a in merged) or any(a.get("type") in ("add_to_collection", "new_collection") and a.get("datasetId") and not _own_draft(db, a["datasetId"], row.created_by) for a in merged)}
    row.plan, row.state = plan, "planned"
    _sync_drop(db, row)
    db.flush()
    events.publish(db, ctx.for_scope(row.project_id, None), "drop.planned", {"dropId": row.drop_id, "plan": plan, "auto": False}, source="kernel")
    audit.record(db, ctx.for_scope(row.project_id, None), "drop.plan_changed", target=row.drop_id, after={"actions": [{"groupId": a["groupId"], "type": a["type"]} for a in merged]})
    return state_dict(db, row)


def _own_draft(db: Session, dataset_id: str, person: str) -> bool:
    d = db.get(DatasetRow, dataset_id)
    return d is not None and d.created_by == person and projects.is_draft_dataset(db, d)


# ---- Undo -----------------------------------------------------------------------------------


def _delete_task(db: Session, t: TaskRow) -> None:
    for model, cond in ((WorkspaceEnvironmentRevision, (WorkspaceEnvironmentRevision.workspace_id == t.project_id) & (WorkspaceEnvironmentRevision.task_id == t.id)), (WorkspaceEnvironment, (WorkspaceEnvironment.workspace_id == t.project_id) & (WorkspaceEnvironment.task_id == t.id))):
        for r in db.scalars(select(model).where(cond)):
            db.delete(r)
    if t.boot_id and (b := db.get(Boot, t.boot_id)) is not None:
        db.delete(b)
    db.delete(t)


def undo(db: Session, ctx: RequestContext, row: DropPlanRow) -> dict:
    if ctx.principal.startswith(("agent:", "plugin:", "worker:")):
        raise HTTPException(403, "only a person undoes an applied drop")
    projects.require_project(db, ctx, row.project_id, write=True)
    if row.state != "applied":
        raise HTTPException(409, f"this plan is {row.state}")
    until = row.undo_until.replace(tzinfo=UTC) if row.undo_until and row.undo_until.tzinfo is None else row.undo_until
    if until is None or datetime.now(UTC) > until:
        raise HTTPException(409, "the undo window has passed")
    a = row.applied or {}
    tasks = [t for t in (db.get(TaskRow, i) for i in a.get("tasks") or []) if t is not None]
    for t in tasks:
        doc = db.get(AnnotationDocumentRow, (t.project_id, t.id))
        if doc is not None and doc.annotations:
            raise HTTPException(409, "a Studio this drop made already has annotations: undo isn't safe any more")
        if t.state != "draft":
            raise HTTPException(409, "a Studio this drop made was published")
    p = db.get(ProjectRow, row.project_id)
    for t in tasks:
        if p is not None and p.default_task_id == t.id:
            p.default_task_id = None
        _delete_task(db, t)
    db.flush()
    for dsid, nodes in (a.get("refs") or {}).items():
        d = db.get(DatasetRow, dsid)
        if d is not None:
            collections.remove_files(db, d, nodes)
    for cid in a.get("collections") or []:
        c = db.get(DatasetCollectionRow, cid)
        if c is not None:
            db.delete(c)
    db.flush()
    for dsid in {*(a.get("refs") or {}), *(a.get("datasets") or [])}:
        d = db.get(DatasetRow, dsid)
        if d is not None:
            collections.sync_definition(db, d)
    for dsid in a.get("datasets") or []:
        d = db.get(DatasetRow, dsid)
        if d is not None and not db.scalar(select(TaskRow.id).where(TaskRow.dataset_id == dsid).limit(1)):
            for c in collections.of_dataset(db, dsid):
                db.delete(c)
            structure.delete_all(db, dsid)
            db.delete(d)
    db.flush()
    _cancel_pipeline_runs(ctx, row)
    row.state, row.undo_until = "undone", None
    _sync_drop(db, row)
    db.flush()
    events.publish(db, ctx.for_scope(row.project_id, None), "drop.applied", {"dropId": row.drop_id, "taskIds": [], "undoUntil": None, "collectionIds": [], "undone": True}, source="kernel")
    audit.record(db, ctx.for_scope(row.project_id, None), "drop.undone", target=row.drop_id, after={"tasks": a.get("tasks"), "collections": a.get("collections"), "datasets": a.get("datasets")})
    _log(row, "undone", auto=bool(row.auto))
    return state_dict(db, row)


def _cancel_pipeline_runs(ctx: RequestContext, row: DropPlanRow) -> None:
    from . import pipeline_client

    ids = (row.applied or {}).get("pipelineRunIds") or []
    if not ids or not pipeline_client.configured():
        return
    for rid in ids:
        try:
            pipeline_client.client().cancel_run(ctx.for_scope(row.project_id, None), rid, f"drop-undo:{row.drop_id}:{rid}")
        except pipeline_client.PipelineError:
            log.warning("drop.pipeline_cancel_failed", extra={"dropId": row.drop_id})


# ---- Re-plan --------------------------------------------------------------------------------

# Groups that put files into a collection (the rest stay in Sources: reference, unpack, …).
_PLACING = ("new_dataset", "new_collection", "add_to_collection")


def _has_annotations(db: Session, t: TaskRow) -> bool:
    doc = db.get(AnnotationDocumentRow, (t.project_id, t.id))
    return doc is not None and bool(doc.annotations)


def replan(db: Session, ctx: RequestContext, row: DropPlanRow) -> dict:
    """Re-run classification for the drop's files with the current rules.

    A plan not applied yet is simply replaced (it stays `planned`, nothing is applied on its
    own). An applied plan is reconciled without losing work: the drop's dataset stays; each
    group's files move to the collection of that kind that already holds most of them (else one
    this drop made, else any of that kind, else a new collection with a Studio booted the way
    `apply` boots one); a collection this drop made that is left empty goes to Trash with its
    Studios, unless one of them has annotations (kept and reported). Running it again with the
    same rules changes nothing."""
    if ctx.principal.startswith(("agent:", "plugin:", "worker:", "event:")):
        raise HTTPException(403, "only a person re-plans a drop")
    p = projects.require_project(db, ctx, row.project_id, write=True)
    if row.state == "applying":
        raise HTTPException(409, "this plan is being applied")
    sids = list((row.context or {}).get("sessionIds") or [])
    sessions = list(db.scalars(select(ImportSession).where(ImportSession.id.in_(sids)))) if sids else sessions_of(db, row.project_id, row.drop_id)
    files = gather(db, row.project_id, sessions)
    if not files:
        raise HTTPException(409, "this drop has no files left to plan")
    summary: dict = {"moved": [], "createdCollections": [], "createdStudios": [], "retiredStudios": [], "retiredCollections": [], "keptAnnotated": []}
    if row.state != "applied":
        d0 = db.get(DatasetRow, (row.context or {}).get("datasetId")) if (row.context or {}).get("datasetId") else None
        cctx = dc.Context(dataset=dataset_in(db, d0 if d0 is not None and d0.project_id == p.id else None, row.created_by), request=(row.context or {}).get("request"))
        groups = dc.classify(files, cctx)
        row.plan, row.groups, row.state, row.error = dc.plan(row.drop_id, groups, cctx, intents.preset_for_kind), [g.as_dict() for g in groups], "planned", None
        _sync_drop(db, row)
        db.flush()
        events.publish(db, ctx.for_scope(p.id, None), "drop.planned", {"dropId": row.drop_id, "plan": row.plan, "auto": False}, source="kernel")
        audit.record(db, ctx.for_scope(p.id, None), "drop.replanned", target=row.drop_id, after={"applied": False, "groups": len(groups)})
        return {**state_dict(db, row), "replan": summary}

    a = dict(row.applied or {})
    dsid = (row.context or {}).get("datasetId") or next(iter(a.get("datasets") or []), None) or next(iter(a.get("refs") or {}), None)
    d = db.get(DatasetRow, dsid) if dsid else None
    if d is None or d.project_id != p.id or d.trashed_at is not None:
        raise HTTPException(409, "this drop's dataset is gone; re-plan isn't possible")
    # Classified as for a new dataset: the groups are the rules' own; placing them is below.
    cctx = dc.Context(dataset=None, request=(row.context or {}).get("request"))
    groups = dc.classify(files, cctx)
    plan = dc.plan(row.drop_id, groups, cctx, intents.preset_for_kind)
    mine = list(a.get("collections") or [])
    live = lambda: [c for c in collections.of_dataset(db, d.id) if c.trashed_at is None]  # noqa: E731
    pairs = collections._ref_kinds(db, d)
    held = {c.id: collections.members(db, d, c, pairs) for c in live()}
    labels = structure.labels_from_request((row.context or {}).get("request"))
    new_tasks: list[str] = []
    actions = []
    # A task of this dataset that accepts kinds (todo19): a new kind joins it, no new Studio.
    accepting = next((t for t in db.scalars(select(TaskRow).where(TaskRow.dataset_id == d.id)) if t.trashed_at is None and t.accepts), None)
    flat: list[dict] = []
    for act in plan.get("actions") or []:
        if act.get("members"):
            flat += [{**act, **m, "type": act["type"]} for m in act["members"]]
        else:
            flat.append(act)
    for act in flat:
        act = {k: v for k, v in act.items() if k not in ("members", "kinds", "presets")}
        nodes = list(act.get("nodeIds") or [])
        if act.get("type") not in _PLACING or not nodes:
            actions.append(act)
            continue
        kind = act.get("kind") or "image"
        same = [c for c in live() if c.kind == kind]
        best = max(same, key=lambda c: (len(held.get(c.id, set()) & set(nodes)), c.id in mine), default=None)
        if best is None:
            shape = next((dict(g.shape or {}) for g in groups if g.group_id == act["groupId"]), {})
            best = collections.create(db, ctx, d, kind, act.get("name"), {k: v for k, v in shape.items() if k == "modality"})
            held[best.id] = set()
            mine.append(best.id)
            summary["createdCollections"].append(best.id)
            if accepting is not None and best.kind in collections.VIEWABLE_COLLECTIONS:
                if best.kind not in (accepting.accepts or []):
                    accepting.accepts = [*(accepting.accepts or []), best.kind]
            elif act.get("preset") and best.kind in collections.VIEWABLE_COLLECTIONS:
                ids = _boot_collection(db, ctx, p, row.drop_id, best, act["preset"], act.get("name") or best.name, structure.label_patch(labels) if labels else None)
                new_tasks += ids
                summary["createdStudios"] += ids
        moving = [n for n in nodes if n not in held[best.id]]
        if moving:
            added = collections.add_files(db, d, best.id, moving)
            if added:
                a.setdefault("refs", {}).setdefault(d.id, []).extend(added)
            for c in held:
                held[c] -= set(moving)
            held[best.id] |= set(moving)
            summary["moved"].append({"collectionId": best.id, "nodeIds": moving})
        actions.append({**act, "type": "add_to_collection", "collectionId": best.id, "datasetId": d.id})
    # Collections this drop made that the new plan leaves empty.
    for cid in list(mine):
        c = db.get(DatasetCollectionRow, cid)
        if c is None or c.trashed_at is not None or held.get(cid):
            continue
        tasks = [t for t in db.scalars(select(TaskRow).where(TaskRow.collection_id == cid)) if t.trashed_at is None]
        annotated = [t.id for t in tasks if _has_annotations(db, t)]
        if annotated:
            summary["keptAnnotated"] += annotated
            continue
        from . import trash

        trash.trash(db, ctx, p, "collection", c)
        summary["retiredCollections"].append(cid)
        summary["retiredStudios"] += [t.id for t in tasks]
    collections.sync_definition(db, d)
    gone = set(summary["retiredCollections"])
    a["collections"] = [c for c in mine if c not in gone]
    retired = set(summary["retiredStudios"])
    a["tasks"] = [t for t in [*(a.get("tasks") or []), *new_tasks] if t not in retired]
    a["taskIds"] = [t for t in dict.fromkeys([*(a.get("taskIds") or []), *new_tasks]) if t not in retired]
    changed = any(summary[k] for k in ("moved", "createdCollections", "createdStudios", "retiredStudios", "retiredCollections"))
    row.applied, row.plan, row.groups = a, {**plan, "actions": actions, "needsPerson": False}, [g.as_dict() for g in groups]
    row.context = {**(row.context or {}), "appliedActions": actions}
    if changed:
        # What undo would take back no longer matches what the apply made: the window closes.
        row.undo_until = None
    _sync_drop(db, row)
    db.flush()
    if changed:
        events.publish(db, ctx.for_scope(p.id, None), "drop.applied", {"dropId": row.drop_id, "datasetId": d.id, "taskIds": a["taskIds"], "undoUntil": None, "collectionIds": a["collections"], "replanned": True}, source="kernel")
    audit.record(db, ctx.for_scope(p.id, None), "drop.replanned", target=row.drop_id, after={"applied": True, "changed": changed, "moved": sum(len(m["nodeIds"]) for m in summary["moved"]), "collections": summary["createdCollections"], "studios": summary["createdStudios"], "retired": summary["retiredStudios"], "keptAnnotated": summary["keptAnnotated"]})
    _log(row, "replanned", changed=changed)
    return {**state_dict(db, row), "replan": {**summary, "changed": changed}}


# ---- Reads ----------------------------------------------------------------------------------


def require(db: Session, ctx: RequestContext, drop_id: str) -> DropPlanRow:
    row = db.get(DropPlanRow, drop_id)
    if row is None:
        raise HTTPException(404, "no plan for this drop yet")
    projects.require_project(db, ctx, row.project_id)
    return row


def state_dict(db: Session, row: DropPlanRow) -> dict:
    a = row.applied or {}
    out: dict = {
        "dropId": row.drop_id,
        "projectId": row.project_id,
        "state": row.state,
        "plan": row.plan,
        "groups": row.groups or [],
        "auto": bool(row.auto),
        "fastPath": bool(row.fast_path),
        "datasetId": (row.context or {}).get("datasetId"),
        "taskIds": list(a.get("taskIds") or a.get("tasks") or []) if row.state == "applied" else [],
        "collectionIds": list(a.get("collections") or []) if row.state == "applied" else [],
        "undoUntil": projects.iso(row.undo_until) if row.state == "applied" else None,
    }
    if a.get("pipelineRunIds"):
        out["pipelineRunIds"] = a["pipelineRunIds"]
    if row.state == "applied":
        # todo20 D4/D5: where the files went and how many were already here.
        out.update({"outcome": a.get("outcome"), "studioTaskId": a.get("studioTaskId"), "new": int(a.get("new") or 0), "alreadyHere": int(a.get("alreadyHere") or 0)})
    if row.error:
        out["error"] = row.error
    return out


def elapsed_ms(t0: float) -> int:
    return int((time.monotonic() - t0) * 1000)
