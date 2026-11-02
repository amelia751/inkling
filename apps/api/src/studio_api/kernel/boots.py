"""Server-side Studio boots (todo11 D1): one API operation makes a **draft** task with its
environment, so a Studio can be created from chat without a Studio tab open.

`boot` runs in the request's transaction: validate everything first (preset, patch, files) so a
refused boot creates nothing, then create the dataset and draft task, write the preset's
environment (revision 1) and the refinement patch (revision 2, so Undo reverts only the
model's part), and publish `boot.started`, `boot.step`…, `boot.ready` on the project stream.
Idempotent on `bootId`: a replay answers with the stored boot; the same id with another body
is a 409. Only a person publishes a draft (`publish`).
"""

from __future__ import annotations

import hashlib
import json
import re
import time

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..context import RequestContext
from ..models import Boot, DatasetRow, ProjectRow, SourceNode, TaskRow, WorkspaceEnvironment, now
from . import audit, environment_policy, events, projects, studio_defs, tree

# A drop id (kernel/drops.py ID_RE, plus unpack and follow-up suffixes).
DROP_RE = re.compile(r"^drp[-_][A-Za-z0-9_-]{1,80}$")

BOOT_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
MAX_NODES = 10_000


def is_agent(ctx: RequestContext) -> bool:
    return ctx.principal.startswith("agent:")


def boot_doc(b: Boot) -> dict:
    out = {"bootId": b.id, "projectId": b.project_id, "taskIds": list(b.task_ids or []), "preset": b.preset, "state": b.state, "steps": list(b.steps or []), "initiator": b.initiator, "createdAt": projects.iso(b.created_at)}
    if b.ms is not None:
        out["ms"] = b.ms
    if b.error:
        out["error"] = b.error
    return out


def agent_may_write(db: Session, ctx: RequestContext, task_id: str) -> bool:
    """D2.1: an agent token writes only the drafts booted for the same person, or the task the
    person had open when they minted the token. Never a published task it wasn't opened on."""
    if ctx.opened_task and ctx.opened_task == task_id:
        return True
    t = db.get(TaskRow, task_id)
    if t is None or t.state != "draft" or not t.boot_id:
        return False
    b = db.get(Boot, t.boot_id)
    return b is not None and b.on_behalf_of == projects.person(ctx)


def _request_hash(body: dict) -> str:
    keep = {k: body.get(k) for k in ("preset", "patch", "files", "folders", "name", "intent", "collectionId")}
    # todo19: newer fields join the hash only when present, so stored boots keep their hash.
    keep.update({k: body[k] for k in ("extends", "accepts", "datasetId", "addToTask") if body.get(k) is not None})
    return "sha256:" + hashlib.sha256(json.dumps(keep, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _preset_title(preset: str) -> str:
    return preset.removeprefix("preset:").replace("-", " ").strip().capitalize() or "Studio"


def _ids(body: dict, key: str) -> list[str]:
    raw = body.get(key) or []
    if not isinstance(raw, list) or not all(isinstance(x, str) for x in raw):
        raise HTTPException(422, f"{key} must be a list of node ids")
    if len(raw) > MAX_NODES:
        raise HTTPException(422, f"at most {MAX_NODES} {key} per boot")
    return list(dict.fromkeys(raw))


def _step(db: Session, ctx: RequestContext, b: Boot, step: str, label: str, artefact: str | None = None) -> None:
    entry = {"step": step, "state": "done", "label": label, **({"artefact": artefact} if artefact else {})}
    b.steps = [*(b.steps or []), entry]
    events.publish(db, ctx, "boot.step", {"bootId": b.id, **entry}, source="kernel")


def boot(db: Session, ctx: RequestContext, p: ProjectRow, body: dict, headers) -> tuple[int, dict]:
    """(status, body). 202 with the boot; 403/409/422 refuse and create nothing."""
    started = time.monotonic()
    boot_id = body.get("bootId")
    if not isinstance(boot_id, str) or not BOOT_ID.fullmatch(boot_id):
        return 422, {"ok": False, "errors": [{"path": "/bootId", "code": "schema", "message": "bootId: 8–64 characters of [A-Za-z0-9_-], chosen by the caller (retries reuse it)"}]}
    rh = _request_hash(body)
    existing = db.get(Boot, boot_id)
    if existing is not None:
        if existing.project_id != p.id or existing.request_hash != rh:
            return 409, {"error": "this bootId was used for a different boot", "boot": boot_doc(existing) if existing.project_id == p.id else None}
        return 202, boot_doc(existing)

    # todo19 D4: `extends` lists one profile preset per kind (deep-merged into data.kinds);
    # `preset` stays the one-preset shorthand.
    ext = body.get("extends")
    if ext is not None:
        presets = [ext] if isinstance(ext, str) else ext
        if not isinstance(presets, list) or not presets or not all(isinstance(x, str) and x.startswith("preset:") for x in presets):
            return 422, {"ok": False, "errors": [{"path": "/extends", "code": "schema", "message": "extends: a list of preset ids such as [\"preset:image-2d\", \"preset:ecg\"]"}]}
        presets = list(dict.fromkeys(presets))
    else:
        presets = [body.get("preset")]
    preset = presets[0]
    if not isinstance(preset, str) or not preset.startswith("preset:"):
        return 422, {"ok": False, "errors": [{"path": "/preset", "code": "schema", "message": "preset: a preset id such as preset:image-2d"}]}
    accepts = body.get("accepts")
    if accepts is not None and (not isinstance(accepts, list) or not accepts or not all(isinstance(k, str) and k for k in accepts)):
        return 422, {"ok": False, "errors": [{"path": "/accepts", "code": "schema", "message": "accepts: a non-empty list of item kinds such as [\"image\", \"waveform\"]"}]}
    accepts = list(dict.fromkeys(accepts)) if accepts else None
    patch = body.get("patch")
    if patch is not None and not isinstance(patch, list):
        return 422, {"ok": False, "errors": [{"path": "/patch", "code": "patch", "message": "A JSON Patch is an array of operations"}]}
    name = body.get("name")
    if name is not None and not isinstance(name, str):
        return 422, {"ok": False, "errors": [{"path": "/name", "code": "schema", "message": "name must be a string"}]}

    # Everything is checked before anything is created.
    installed = environment_policy.installed_plugins(db, p.id)
    base: dict = {"extends": preset} if len(presets) == 1 else {"extends": presets}
    first = environment_policy.check_write(principal="person", installed=installed, environment=base)
    if not first.ok:
        return 422, {"ok": False, "errors": [{**e, "path": "/preset" if e["path"] == "/extends" and len(presets) == 1 else e["path"]} for e in first.errors]}
    refined = None
    if patch:
        checked = environment_policy.check_write(principal="agent" if is_agent(ctx) else "person", installed=installed, base=base, patch=patch, is_patch=True)
        if not checked.ok:
            return checked.status, checked.body()
        refined = checked.environment
    try:
        node_ids = _ids(body, "files") + _ids(body, "folders")
    except HTTPException as e:
        return 422, {"ok": False, "errors": [{"path": "/files", "code": "schema", "message": str(e.detail)}]}
    if node_ids:
        found = set(db.scalars(select(SourceNode.id).where(SourceNode.id.in_(node_ids), SourceNode.project_id == p.id)))
        missing = [i for i in node_ids if i not in found]
        if missing:
            return 422, {"ok": False, "errors": [{"path": "/files", "code": "reference", "message": f"not in this project: {missing[:5]}"}]}

    # todo13 D7: a boot on an existing collection makes a Studio for it (no new dataset).
    collection = None
    collection_id = body.get("collectionId")
    if collection_id is not None:
        from ..models import DatasetCollectionRow

        collection = db.get(DatasetCollectionRow, collection_id) if isinstance(collection_id, str) else None
        if collection is None or collection.project_id != p.id:
            return 422, {"ok": False, "errors": [{"path": "/collectionId", "code": "reference", "message": "no such collection in this project"}]}

    # todo19 D5: a boot on an existing dataset (a drop's draft) makes its one Studio over it.
    dataset = None
    dataset_id = body.get("datasetId")
    if dataset_id is not None and collection is None:
        dataset = db.get(DatasetRow, dataset_id) if isinstance(dataset_id, str) else None
        if dataset is None or dataset.project_id != p.id:
            return 422, {"ok": False, "errors": [{"path": "/datasetId", "code": "reference", "message": "no such dataset in this project"}]}
        if node_ids:
            return 422, {"ok": False, "errors": [{"path": "/files", "code": "schema", "message": "a boot on a dataset uses its files; add files to the dataset instead"}]}

    # todo20 D4: a boot can add to an existing Studio (`addToTask`) instead of making one.
    add_to = body.get("addToTask")
    target: TaskRow | None = None
    if add_to is not None:
        target = db.get(TaskRow, add_to) if isinstance(add_to, str) else None
        if target is None or target.project_id != p.id or target.trashed_at is not None:
            return 422, {"ok": False, "errors": [{"path": "/addToTask", "code": "reference", "message": "no such Studio in this project"}]}
        if collection is not None or dataset is not None:
            return 422, {"ok": False, "errors": [{"path": "/addToTask", "code": "schema", "message": "addToTask adds to that Studio's dataset; leave out collectionId and datasetId"}]}

    title = (name or f"{_preset_title(preset)} Studio").strip()[:256] or "Studio"
    run = headers.get(studio_defs.RUN_HEADER) or ""
    initiator: dict[str, str | bool] = {"kind": "agent", **({"runId": run} if studio_defs.RUN_RE.fullmatch(run) else {})} if is_agent(ctx) else {"kind": "person"}
    # todo13 fast path: the drop that booted it, so the tab that dropped opens the Studio (§3.2).
    drop_id = body.get("dropId")
    if isinstance(drop_id, str) and DROP_RE.fullmatch(drop_id):
        initiator["dropId"] = drop_id
        # The project's first Studio: the person who dropped lands in it wherever they dropped.
        if db.scalar(select(TaskRow.id).where(TaskRow.project_id == p.id).limit(1)) is None:
            initiator["firstStudio"] = True
    b = Boot(id=boot_id, project_id=p.id, preset=preset, state="running", task_ids=[], steps=[], initiator=initiator, principal=ctx.principal, on_behalf_of=projects.person(ctx), request_hash=rh)
    db.add(b)
    if target is not None:
        return _boot_into(db, ctx, p, b, target, presets, accepts, node_ids, headers, body, started)
    # todo17 D3: the project's first boot with a preset stores that preset's rules (revision 1).
    from . import rules as project_rules

    project_rules.seed_from_preset(db, p, preset, projects.person(ctx))

    # The draft: a dataset of the given files (possibly none yet) and its task.
    from . import collections

    if dataset is not None:
        d = dataset
    elif collection is not None:
        d = db.get(DatasetRow, collection.dataset_id)
        assert d is not None
        if node_ids:
            collections.add_files(db, d, collection.id, [n.id for n in tree.files_under(db, node_ids)])
    elif node_ids:
        d = projects.create_dataset(db, ctx, p, title, {"nodeIds": node_ids, "draft": True})
    else:
        d = DatasetRow(id=projects.new_id("ds"), project_id=p.id, title=title, description="", definition={"nodeIds": [], "files": [], "followedFolders": [], "draft": True}, created_by=projects.person(ctx))
        db.add(d)
        db.flush()
    if collection is None and accepts is None and dataset is None:
        collection = _default_collection(db, ctx, d, preset)
    t = projects.create_task(db, ctx, d, title, "annotate", None)
    t.state, t.boot_id, t.booted_by = "draft", boot_id, ctx.principal
    t.collection_id = collection.id if collection is not None else None
    # todo19 D2: the item filter is the dataset ∩ accepts (a dataset boot without accepts: all).
    t.accepts = accepts
    b.task_ids = [t.id]
    db.flush()
    scoped = ctx.for_scope(p.id, None)
    events.publish(db, scoped, "boot.started", {"bootId": boot_id, "taskIds": [t.id], "preset": preset, **({"extends": presets} if len(presets) > 1 else {}), **({"accepts": accepts} if accepts else {}), "initiator": initiator}, source="kernel")
    _step(db, scoped, b, "task", f"Created draft “{title}”", title)
    if node_ids:
        n = len((d.definition or {}).get("files") or [])
        _step(db, scoped, b, "files", f"Linked {n} file{'' if n == 1 else 's'}")

    # Revision 1: the preset. Revision 2: the refinement, so Undo reverts only that.
    prov = studio_defs.provenance(ctx, headers, body)
    tc = ctx.for_scope(p.id, t.id)
    from .canonical import NULL_CONTENT_HASH

    h1 = studio_defs.save_revision(db, tc, None, 0, base, prov, NULL_CONTENT_HASH)
    if h1 is None:
        raise HTTPException(409, "the new task's environment was written concurrently")
    _step(db, scoped, b, "environment", f"Set up from {', '.join(presets)}", preset)
    if refined is not None:
        row = db.get(WorkspaceEnvironment, (p.id, t.id))
        h2 = studio_defs.save_revision(db, tc, row, 1, refined, prov, h1.content_hash, patch)
        if h2 is None:
            raise HTTPException(409, "the new task's environment was written concurrently")
        _step(db, scoped, b, "refine", _describe(patch or []))

    b.state, b.ms, b.finished_at = "ready", int((time.monotonic() - started) * 1000), now()
    events.publish(db, scoped, "boot.ready", {"bootId": boot_id, "taskIds": [t.id], "ms": b.ms}, source="kernel")
    audit.record(db, scoped, "boot.ready", target=boot_id, after={"preset": preset, "taskIds": [t.id], "initiator": initiator})
    db.flush()
    return 202, boot_doc(b)


def extend_task(db: Session, ctx: RequestContext, p: ProjectRow, t: TaskRow, presets: list[str], kinds: list[str], headers=None, body: dict | None = None) -> list[str]:
    """todo20 D4: a Studio takes more kinds. `accepts` gains `kinds` (a legacy per-collection
    Studio becomes a dataset Studio accepting its collection's kind plus these) and the
    environment's `extends` gains each kind's profile preset (a new revision). Returns the kinds
    added. A Studio with no kind filter already sees every kind."""
    from ..models import DatasetCollectionRow
    from . import collections

    added: list[str] = []
    if t.accepts or t.collection_id:
        cur = list(t.accepts or [])
        if not cur and t.collection_id and (c := db.get(DatasetCollectionRow, t.collection_id)) is not None:
            cur = [c.kind]
        added = [k for k in dict.fromkeys(kinds) if not collections.accepts_kind(cur, k)]
        if added or not t.accepts:
            t.accepts, t.collection_id = [*cur, *added], None
    row = db.get(WorkspaceEnvironment, (p.id, t.id))
    env = dict((row.environment if row is not None else None) or {})
    ext = env.get("extends")
    have = [ext] if isinstance(ext, str) else [x for x in ext or [] if isinstance(x, str)]
    want = list(dict.fromkeys([*have, *[x for x in presets if x]]))
    if want != have and have:
        env["extends"] = want[0] if len(want) == 1 else want
        checked = environment_policy.check_write(principal="person", installed=environment_policy.installed_plugins(db, p.id), environment=env)
        if checked.ok:
            from .canonical import NULL_CONTENT_HASH, content_hash

            prov = studio_defs.provenance(ctx, headers or {}, body or {})
            parent = content_hash(row.environment) if row is not None and row.environment is not None else NULL_CONTENT_HASH
            studio_defs.save_revision(db, ctx.for_scope(p.id, t.id), row, row.revision if row is not None else 0, env, prov, parent)
    db.flush()
    return added


def _boot_into(db: Session, ctx: RequestContext, p: ProjectRow, b: Boot, t: TaskRow, presets: list[str], accepts: list[str] | None, node_ids: list[str], headers, body: dict, started: float) -> tuple[int, dict]:
    """`addToTask`: the files join that Studio's dataset (a collection per kind) and the Studio
    accepts their kinds; no task is created."""
    from . import collections

    d = db.get(DatasetRow, t.dataset_id)
    assert d is not None
    b.task_ids = [t.id]
    db.flush()
    scoped = ctx.for_scope(p.id, None)
    events.publish(db, scoped, "boot.started", {"bootId": b.id, "taskIds": [t.id], "preset": b.preset, "addToTask": t.id, "initiator": b.initiator}, source="kernel")
    added, _already = collections.add_by_kind(db, ctx, d, node_ids) if node_ids else ({}, [])
    n = sum(len(v) for v in added.values())
    if node_ids:
        _step(db, scoped, b, "files", f"Added {n} file{'' if n == 1 else 's'} to “{t.title}”")
    extend_task(db, ctx, p, t, presets, list(dict.fromkeys([*(accepts or []), *added])), headers, body)
    b.state, b.ms, b.finished_at = "ready", int((time.monotonic() - started) * 1000), now()
    events.publish(db, scoped, "boot.ready", {"bootId": b.id, "taskIds": [t.id], "ms": b.ms}, source="kernel")
    audit.record(db, scoped, "boot.ready", target=b.id, after={"addToTask": t.id, "files": n})
    db.flush()
    return 202, boot_doc(b)


def _default_collection(db: Session, ctx: RequestContext, d: DatasetRow, preset: str):
    """The collection a new draft's Studio works on: one per kind among its files, and the
    viewable one the preset is for (or the first viewable); an empty draft gets an empty
    collection of the preset's first file kind (J2: "an empty collection")."""
    from . import collections, intents

    rows = collections.ensure(db, ctx, d)
    viewable = [c for c in rows if c.kind in collections.VIEWABLE_COLLECTIONS]
    entry = next((e for e in intents.table().get("intents") or [] if e.get("preset") == preset), None)
    kinds = [k for k in (entry or {}).get("fileKinds") or []]
    for k in kinds:
        for c in viewable:
            if c.kind == k:
                return c
    if viewable:
        return viewable[0]
    if not rows and kinds:
        return collections.create(db, ctx, d, kinds[0])
    return None


def record_failure(db: Session, ctx: RequestContext, project_id: str, body: dict, step: str, message: str) -> dict | None:
    """After the boot's transaction rolled back: a `failed` boot and `boot.failed`, in a new
    transaction, so the card shows why and a retry with the same bootId reports it."""
    boot_id = body.get("bootId")
    if not isinstance(boot_id, str) or not BOOT_ID.fullmatch(boot_id) or db.get(Boot, boot_id) is not None:
        return None
    b = Boot(id=boot_id, project_id=project_id, preset=str(body.get("preset") or "")[:128], state="failed", task_ids=[], steps=[{"step": step, "state": "failed", "label": message[:200]}],
             initiator={"kind": "agent"} if is_agent(ctx) else {"kind": "person"}, principal=ctx.principal, on_behalf_of=projects.person(ctx), request_hash=_request_hash(body),
             error={"step": step, "message": message[:500]}, finished_at=now())
    db.add(b)
    events.publish(db, ctx.for_scope(project_id, None), "boot.failed", {"bootId": boot_id, "step": step, "message": message[:500]}, source="kernel")
    db.flush()
    return boot_doc(b)


def _describe(patch: list) -> str:
    """A ledger label that names what changed, not the tool: "Added 5 labels", "Tuned layout"."""
    parts = []
    for op in patch:
        path = str(op.get("path", "")) if isinstance(op, dict) else ""
        top = path.split("/")[1] if path.count("/") >= 1 and len(path) > 1 else ""
        if top == "labels" and isinstance(op.get("value"), list):
            n = sum(len(g.get("classes") or []) for g in op["value"] if isinstance(g, dict))
            parts.append(f"Added {n} label{'' if n == 1 else 's'}")
        elif top == "labels":
            parts.append("Changed labels")
        elif top == "layout":
            parts.append("Tuned layout")
        elif top:
            parts.append(f"Set {top}")
    return ", ".join(dict.fromkeys(parts)) or "Applied changes"


def publish(db: Session, ctx: RequestContext, task_id: str) -> TaskRow:
    """D1: a person publishes a draft. Agents never can (also refused by agent_scope)."""
    if is_agent(ctx) or ctx.principal.startswith(("plugin:", "worker:")):
        raise HTTPException(403, "only a person publishes a Studio")
    t, p = projects.require_task(db, ctx, task_id)
    projects.require_project(db, ctx, p.id, write=True)
    if t.state != "draft":
        return t
    t.state, t.published_by, t.published_at = "published", ctx.principal, now()
    audit.record(db, ctx.for_scope(p.id, t.id), "task.published", target=t.id, after={"bootId": t.boot_id})
    db.flush()
    return t
