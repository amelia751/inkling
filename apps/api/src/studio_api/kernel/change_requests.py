"""Change requests (todo17 D7): how agents change published things.

Drafts and an agent's own scratch apply directly. An operation the catalogue marks
`published: "change-request"` (rules, the environment of a published Studio, the content of a
dataset with a published Studio) does not apply when an agent (the in-house assistant, an MCP or
OAuth client, an API key without `admin`) sends it against something published: `admit` hands it
to `open_or_append`, which adds it to the actor's open change request in the project (or opens
one). People apply directly.

Checks run on open and on every update: the operations replay, in order, through the same kernel
functions their routes use, inside a SAVEPOINT that is rolled back (a dry run with every
cross-operation effect), after `admit(..., dry_run=True)`. State: open → checking → passed |
failed. A clean change request whose operations are all tier *write* merges at once when the
project's `rules.merge.auto` is "write-tier" (the default), as actor `auto-merge`; otherwise a
person with write access merges it. Agents never merge (403).

Merge replays the operations for real with revision checks: each resource's revision when the
change request first touched it is in `base`; if one moved, checks run again on the new base and
a failure leaves the change request `needs-update` (409).

Dataset content: a project dataset's content is its file references (`DatasetRow.definition`);
the versioning service versions annotation manifests of a workspace repo, not dataset
membership, so dataset operations replay like the other project operations here.
"""

from __future__ import annotations

import copy
import json
import uuid
from collections.abc import Callable
from dataclasses import dataclass, replace
from functools import lru_cache
from typing import Any

import jsonpatch
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..context import AUTH_API_KEY, RequestContext
from ..models import AnnotationDocumentRow, ChangeRequest, ChangeRequestComment, DatasetRow, ProjectRow, SourceNode, TaskRow, WorkspaceEnvironment, now
from . import admission, audit
from .lint import Violation

OPEN_STATES = ("open", "checking", "passed", "failed", "needs-update")
AUTO_MERGE = "auto-merge"
AGENT_MERGE_DENIED = "Change requests are merged by people (or automatically when every check passes). Ask a project owner or editor to review it."


# ---- who is an agent ---------------------------------------------------------------------------


def is_agent(ctx: RequestContext) -> bool:
    """The in-house assistant and MCP/OAuth clients (agent sessions, delegated tokens) and
    organization API keys without `admin`. People, services and workers are not."""
    if ctx.principal.startswith("agent:") or ctx.on_behalf_of is not None:
        return True
    return ctx.auth == AUTH_API_KEY and "*" not in ctx.scopes


def agent_name(ctx: RequestContext) -> str | None:
    if not is_agent(ctx):
        return None
    if ctx.profile:
        return ctx.profile
    return ctx.principal.split(":", 1)[-1] or None


# ---- the catalogue's `published` field -----------------------------------------------------------

# Mirror of `published: "change-request"` in packages/contracts/src/operations.ts, used when
# schemas/operations.json is not there (a bare api image); the file wins when it is.
CHANGE_REQUEST_OPS_FALLBACK = frozenset({"rules.update", "studio.patch", "dataset.add_files"})


@lru_cache(maxsize=1)
def _catalogue(root: str) -> dict[str, dict[str, Any]]:
    from pathlib import Path

    try:
        doc = json.loads((Path(root) / "schemas" / "operations.json").read_text())
    except (OSError, ValueError):
        return {}
    return {o["id"]: o for o in doc.get("operations") or [] if isinstance(o, dict) and "id" in o}


def catalogue() -> dict[str, dict[str, Any]]:
    return _catalogue(str(settings().repo_root))


def change_request_ops() -> frozenset[str]:
    cat = catalogue()
    if not cat:
        return CHANGE_REQUEST_OPS_FALLBACK
    return frozenset(i for i, o in cat.items() if o.get("published") == "change-request")


def tier(op_id: str) -> str:
    return str((catalogue().get(op_id) or {}).get("tier") or (admission.OPERATIONS[op_id].tier if op_id in admission.OPERATIONS else "write"))


# ---- appliers: one per operation that can be in a change request ---------------------------------


class Rejected(Exception):
    def __init__(self, violations: list[Violation]):
        super().__init__(violations[0].message if violations else "rejected")
        self.violations = violations


def _v(rule: str, path: str, message: str) -> Violation:
    return Violation(rule=rule, path=path, message=message, severity="error", fix="")


def _http(e: HTTPException, path: str = "") -> Rejected:
    d = e.detail
    if isinstance(d, dict) and d.get("issues"):
        return Rejected([_v("change.invalid", f"{path}/{i.get('path', '')}".rstrip("/"), str(i.get("message"))) for i in d["issues"]])
    msg = d.get("error") if isinstance(d, dict) else str(d)
    return Rejected([_v("change.conflict" if e.status_code == 409 else "change.invalid", path, str(msg))])


@dataclass(frozen=True)
class Applier:
    resource: Callable[[dict], str]
    revision: Callable[[Session, ProjectRow, dict], int]
    published: Callable[[Session, ProjectRow, dict], bool]
    apply: Callable[[Session, RequestContext, ProjectRow, dict], Any]
    diff: Callable[[Session, ProjectRow, dict], list[dict]]


# rules.update {rules} | {ops: JSON Patch}


def _rules_next(db: Session, p: ProjectRow, inp: dict) -> tuple[dict, dict]:
    from . import rules as krules

    cur = krules.get(db, p)
    if isinstance(inp.get("rules"), dict):
        return cur, inp["rules"]
    ops = inp.get("ops")
    if not isinstance(ops, list):
        raise Rejected([_v("change.invalid", "", "rules.update needs rules (the whole document) or ops (a JSON Patch)")])
    try:
        return cur, jsonpatch.apply_patch(copy.deepcopy(cur["rules"]), ops)
    except (jsonpatch.JsonPatchException, jsonpatch.JsonPointerException, TypeError, ValueError) as e:
        raise Rejected([_v("change.invalid", "/ops", f"patch does not apply: {e}")]) from None


def _rules_apply(db: Session, ctx: RequestContext, p: ProjectRow, inp: dict) -> Any:
    from . import rules as krules

    cur, nxt = _rules_next(db, p, inp)
    try:
        return krules._save(db, ctx, p, nxt, cur["revision"])
    except HTTPException as e:
        raise _http(e, "/rules") from None


def _rules_diff(db: Session, p: ProjectRow, inp: dict) -> list[dict]:
    try:
        cur, nxt = _rules_next(db, p, inp)
    except Rejected:
        return []
    out = []
    for o in jsonpatch.make_patch(cur["rules"], nxt):
        before = jsonpatch.JsonPointer(o["path"]).resolve(cur["rules"], None) if o["op"] != "add" else None
        out.append({"op": "rules.update", "path": "/rules" + o["path"], "before": before, "after": o.get("value")})
    return out


def _rules_revision(db: Session, p: ProjectRow, _inp: dict) -> int:
    from . import rules as krules

    return int(krules.get(db, p)["revision"])


# studio.patch {taskId, patch}


def _task(db: Session, p: ProjectRow, inp: dict) -> TaskRow:
    t = db.get(TaskRow, str(inp.get("taskId") or ""))
    if t is None or t.project_id != p.id or t.trashed_at is not None:
        raise Rejected([_v("change.invalid", "/taskId", "no such Studio in this project")])
    return t


def _env(db: Session, p: ProjectRow, t: TaskRow) -> tuple[WorkspaceEnvironment | None, int, dict | None]:
    from . import projects

    row = db.get(WorkspaceEnvironment, (p.id, t.id))
    rev = row.revision if row is not None else 0
    base = row.environment if row is not None and row.revision else projects.base_environment(db, t.id)
    return row, rev, base


def _studio_apply(db: Session, ctx: RequestContext, p: ProjectRow, inp: dict) -> Any:
    from . import environment_policy, studio_defs

    t = _task(db, p, inp)
    row, rev, base = _env(db, p, t)
    if not base:
        raise Rejected([_v("change.invalid", "/taskId", "the Studio has no environment to patch")])
    ops = inp.get("patch")
    checked = environment_policy.check_write(principal="agent" if is_agent(ctx) else "person", installed=environment_policy.installed_plugins(db, p.id), base=base, patch=ops, is_patch=True)
    if not checked.ok:
        raise Rejected([_v("env.invalid" if checked.status == 422 else "change.denied", f"/patch{e.get('path') or ''}", str(e.get("message") or e.get("code"))) for e in checked.errors] or [_v("change.invalid", "/patch", "patch rejected")])
    c = ctx.for_scope(p.id, t.id)
    pv = inp.get("provenance") if isinstance(inp.get("provenance"), dict) else {}
    prov = studio_defs.Provenance(str(pv.get("author") or ctx.principal), str(pv.get("kind") or ("agent" if is_agent(ctx) else "person")), pv.get("runId"), pv.get("promptHash"))
    hist = studio_defs.save_revision(db, c, row, rev, checked.environment, prov, studio_defs.parent_hash(db, p.id, t.id, rev, base), ops)
    if hist is None:
        raise Rejected([_v("change.conflict", "/patch", "the Studio's environment changed while merging")])
    return {"revision": hist.revision}


def _studio_diff(db: Session, p: ProjectRow, inp: dict) -> list[dict]:
    try:
        t = _task(db, p, inp)
    except Rejected:
        return []
    _, _, base = _env(db, p, t)
    out = []
    for o in inp.get("patch") or []:
        if not isinstance(o, dict):
            continue
        before = jsonpatch.JsonPointer(str(o.get("path", ""))).resolve(base or {}, None) if o.get("op") != "add" else None
        out.append({"op": "studio.patch", "path": f"/studios/{t.id}/environment{o.get('path', '')}", "before": before, "after": o.get("value")})
    return out


def _studio_revision(db: Session, p: ProjectRow, inp: dict) -> int:
    t = db.get(TaskRow, str(inp.get("taskId") or ""))
    row = db.get(WorkspaceEnvironment, (p.id, t.id)) if t is not None else None
    return row.revision if row is not None else 0


def _studio_published(db: Session, p: ProjectRow, inp: dict) -> bool:
    t = db.get(TaskRow, str(inp.get("taskId") or ""))
    return t is not None and t.project_id == p.id and t.trashed_at is None and (t.state or "published") == "published"


# dataset.add_files {datasetId, nodeIds}


def _dataset(db: Session, p: ProjectRow, inp: dict) -> DatasetRow:
    d = db.get(DatasetRow, str(inp.get("datasetId") or ""))
    if d is None or d.project_id != p.id or d.trashed_at is not None:
        raise Rejected([_v("change.invalid", "/datasetId", "no such dataset in this project")])
    return d


def _dataset_new_files(db: Session, p: ProjectRow, d: DatasetRow, inp: dict) -> list[SourceNode]:
    from . import tree

    ids = [str(x) for x in inp.get("nodeIds") or []]
    if not ids:
        raise Rejected([_v("change.invalid", "/nodeIds", "name at least one file or folder")])
    nodes = [db.get(SourceNode, i) for i in ids]
    missing = [i for i, n in zip(ids, nodes, strict=True) if n is None or n.project_id != p.id or n.trashed_at is not None]
    if missing:
        raise Rejected([_v("change.invalid", f"/nodeIds/{ids.index(m)}", "no such file or folder in this project") for m in missing])
    have = {str(r.get("nodeId")) for r in (d.definition or {}).get("files") or [] if isinstance(r, dict)}
    return [n for n in tree.files_under(db, ids) if n.id not in have]


def _dataset_apply(db: Session, ctx: RequestContext, p: ProjectRow, inp: dict) -> Any:
    d = _dataset(db, p, inp)
    new = _dataset_new_files(db, p, d, inp)
    if new:
        definition = dict(d.definition or {})
        definition["files"] = [*(definition.get("files") or []), *({"nodeId": n.id, "assetId": n.asset_id, "version": n.version or 1} for n in new)]
        d.definition = definition
        audit.record(db, ctx.for_scope(p.id, None), "dataset.files_added", target=d.id, after={"title": d.title, "files": len(new)})
        db.flush()
    return {"datasetId": d.id, "added": len(new)}


def _dataset_diff(db: Session, p: ProjectRow, inp: dict) -> list[dict]:
    try:
        d = _dataset(db, p, inp)
        new = _dataset_new_files(db, p, d, inp)
    except Rejected:
        return []
    return [{"op": "dataset.add_files", "path": f"/datasets/{d.id}/files/-", "before": None, "after": {"nodeId": n.id, "version": n.version or 1}} for n in new]


def _dataset_revision(db: Session, p: ProjectRow, inp: dict) -> int:
    d = db.get(DatasetRow, str(inp.get("datasetId") or ""))
    return len((d.definition or {}).get("files") or []) if d is not None else 0


def _dataset_published(db: Session, p: ProjectRow, inp: dict) -> bool:
    did = str(inp.get("datasetId") or "")
    q = select(TaskRow.id).where(TaskRow.project_id == p.id, TaskRow.dataset_id == did, TaskRow.state == "published", TaskRow.trashed_at.is_(None)).limit(1)
    return db.scalars(q).first() is not None


# annotation.relabel {taskId, annotationId, label}


def _annotation(db: Session, p: ProjectRow, inp: dict) -> tuple[AnnotationDocumentRow, int]:
    t = _task(db, p, inp)
    row = db.get(AnnotationDocumentRow, (p.id, t.id))
    aid = str(inp.get("annotationId") or "")
    for i, a in enumerate((row.annotations or []) if row is not None else []):
        if isinstance(a, dict) and str(a.get("id")) == aid:
            return row, i
    raise Rejected([_v("change.invalid", "/annotationId", "no such annotation in this Studio")])


def _canonical_label(db: Session, p: ProjectRow, label: str) -> str:
    labels = _rules_of(db, p).get("labels") or []
    if not labels:
        return label
    k = label.strip().casefold()
    for lb in labels:
        if k in {str(w).strip().casefold() for w in [lb.get("id"), lb.get("name"), *(lb.get("synonyms") or [])] if w}:
            return str(lb.get("name") or lb.get("id"))
    raise Rejected([Violation(rule="label.unknown", path="/label", message="The label is not in the project's label set.", severity="error", allowed=[lb.get("name") for lb in labels])])


def _relabel_apply(db: Session, ctx: RequestContext, p: ProjectRow, inp: dict) -> Any:
    label = inp.get("label")
    if not isinstance(label, str) or not label.strip():
        raise Rejected([_v("change.invalid", "/label", "label: the new label")])
    row, i = _annotation(db, p, inp)
    label = _canonical_label(db, p, label)
    anns = copy.deepcopy(list(row.annotations))
    before = anns[i].get("label")
    anns[i]["label"] = label
    row.annotations, row.revision, row.saved_at = anns, (row.revision or 0) + 1, now()
    audit.record(db, ctx.for_scope(p.id, row.task_id), "annotation.relabeled", target=str(inp.get("annotationId")), after={"from": before, "to": label})
    db.flush()
    return {"revision": row.revision}


def _relabel_diff(db: Session, p: ProjectRow, inp: dict) -> list[dict]:
    try:
        row, i = _annotation(db, p, inp)
    except Rejected:
        return []
    return [{"op": "annotation.relabel", "path": f"/studios/{row.task_id}/annotations/{inp.get('annotationId')}/label", "before": row.annotations[i].get("label"), "after": inp.get("label")}]


def _relabel_revision(db: Session, p: ProjectRow, inp: dict) -> int:
    row = db.get(AnnotationDocumentRow, (p.id, str(inp.get("taskId") or "")))
    return row.revision if row is not None else 0


# source.rename {nodeId, name}


def _rename_apply(db: Session, ctx: RequestContext, p: ProjectRow, inp: dict) -> Any:
    from . import fs

    try:
        return fs.apply(db, ctx.for_scope(p.id, None), p, {"ops": [{"kind": "rename", "nodeId": inp.get("nodeId"), "name": inp.get("name")}]})
    except HTTPException as e:
        raise _http(e, "/name") from None


def _rename_diff(db: Session, p: ProjectRow, inp: dict) -> list[dict]:
    n = db.get(SourceNode, str(inp.get("nodeId") or ""))
    if n is None or n.project_id != p.id:
        return []
    return [{"op": "source.rename", "path": f"/sources/{n.id}/name", "before": n.name, "after": inp.get("name")}]


def _rename_revision(db: Session, p: ProjectRow, inp: dict) -> int:
    n = db.get(SourceNode, str(inp.get("nodeId") or ""))
    return int(n.revision or 0) if n is not None else 0


def _rename_published(db: Session, p: ProjectRow, inp: dict) -> bool:
    """A file a dataset with a published Studio uses."""
    nid = str(inp.get("nodeId") or "")
    published = select(TaskRow.dataset_id).where(TaskRow.project_id == p.id, TaskRow.state == "published", TaskRow.trashed_at.is_(None))
    for d in db.scalars(select(DatasetRow).where(DatasetRow.id.in_(published), DatasetRow.trashed_at.is_(None))):
        if any(isinstance(r, dict) and str(r.get("nodeId")) == nid for r in (d.definition or {}).get("files") or []):
            return True
    return False


APPLIERS: dict[str, Applier] = {
    "rules.update": Applier(lambda _i: "rules", _rules_revision, lambda *_: True, _rules_apply, _rules_diff),
    "studio.patch": Applier(lambda i: f"studio:{i.get('taskId')}:environment", _studio_revision, _studio_published, _studio_apply, _studio_diff),
    "dataset.add_files": Applier(lambda i: f"dataset:{i.get('datasetId')}:files", _dataset_revision, _dataset_published, _dataset_apply, _dataset_diff),
    "annotation.relabel": Applier(lambda i: f"studio:{i.get('taskId')}:annotations", _relabel_revision, _studio_published, _relabel_apply, _relabel_diff),
    "source.rename": Applier(lambda i: f"source:{i.get('nodeId')}", _rename_revision, _rename_published, _rename_apply, _rename_diff),
}

for _op in APPLIERS:  # registered with admit (validation families come with todo17 M1 slices)
    if _op not in admission.OPERATIONS:
        admission.register(admission.Operation(id=_op, tier="write", published=admission.CHANGE_REQUEST))


def needs_change_request(db: Session, ctx: RequestContext, p: ProjectRow, op_id: str, inp: dict) -> bool:
    """An agent's operation that the catalogue routes through change requests, on something published."""
    return is_agent(ctx) and op_id in change_request_ops() and op_id in APPLIERS and APPLIERS[op_id].published(db, p, inp)


def admission_ctx(db: Session, ctx: RequestContext, p: ProjectRow) -> admission.Ctx:
    """The `admit` context for a request: agents' published writes become change requests."""
    from . import rules as krules

    return admission.Ctx(
        project_id=p.id,
        principal=ctx.principal,
        on_behalf_of=ctx.on_behalf_of,
        rules=lambda _pid: krules.get(db, p)["rules"],
        agent=is_agent(ctx),
        targets_published=lambda op, value, _c: op.id in APPLIERS and APPLIERS[op.id].published(db, p, value),
        open_change_request=lambda op_id, value: open_or_append(db, ctx, op_id, value, project=p),
    )


# ---- JSON --------------------------------------------------------------------------------------


def _iso(d: Any) -> str | None:
    return d.isoformat() if d is not None else None


def to_json(db: Session, cr: ChangeRequest, *, detail: bool = False) -> dict[str, Any]:
    comments = db.scalars(select(ChangeRequestComment).where(ChangeRequestComment.change_request_id == cr.id).order_by(ChangeRequestComment.created_at))
    out: dict[str, Any] = {
        "id": cr.id, "projectId": cr.project_id, "title": cr.title, "actor": cr.actor, "onBehalfOf": cr.on_behalf_of, "agent": cr.agent,
        "state": cr.state, "operations": cr.operations or [], "findings": cr.findings or [], "base": cr.base or {},
        "createdAt": _iso(cr.created_at), "updatedAt": _iso(cr.updated_at), "mergedBy": cr.merged_by, "mergedAt": _iso(cr.merged_at),
        "comments": [comment_json(c) for c in comments],
    }
    if detail:
        p = db.get(ProjectRow, cr.project_id)
        out["diff"] = [d for o in cr.operations or [] if o.get("op") in APPLIERS for d in APPLIERS[o["op"]].diff(db, p, o.get("input") or {})] if p is not None and cr.state not in ("merged", "closed") else []
    return out


def comment_json(c: ChangeRequestComment) -> dict[str, Any]:
    return {"id": c.id, "author": c.author, "body": c.body, "createdAt": _iso(c.created_at)}


# ---- open, append, check -------------------------------------------------------------------------


def _validate_ops(operations: Any, *, trusted: bool = False) -> list[dict]:
    """`provenance` (who and which run made a Studio change) is set by the kernel only."""
    if not isinstance(operations, list) or not operations:
        raise HTTPException(422, {"error": "operations: a non-empty list of {op, input}"})
    out = []
    for i, o in enumerate(operations):
        if not isinstance(o, dict) or o.get("op") not in APPLIERS or not isinstance(o.get("input", {}), dict):
            raise HTTPException(422, {"error": f"operations/{i}: op must be one of {', '.join(sorted(APPLIERS))} with an input object"})
        inp = dict(o.get("input") or {})
        if not trusted:
            inp.pop("provenance", None)
        out.append({"op": o["op"], "input": inp})
    return out


def _open_cr(db: Session, ctx: RequestContext, p: ProjectRow) -> ChangeRequest | None:
    q = select(ChangeRequest).where(ChangeRequest.project_id == p.id, ChangeRequest.actor == ctx.principal, ChangeRequest.state.in_(OPEN_STATES)).order_by(ChangeRequest.created_at.desc()).limit(1)
    return db.scalars(q.with_for_update()).first()


def _title(ops: list[dict]) -> str:
    kinds = sorted({o["op"] for o in ops})
    return ("Change " + ", ".join(k.replace(".", " ").replace("_", " ") for k in kinds))[:300]


def _append(db: Session, p: ProjectRow, cr: ChangeRequest, ops: list[dict]) -> None:
    base = dict(cr.base or {})
    out = list(cr.operations or [])
    for o in ops:
        a = APPLIERS[o["op"]]
        key = a.resource(o["input"])
        rev = a.revision(db, p, o["input"])
        base.setdefault(key, rev)
        out.append({"op": o["op"], "input": o["input"], "base_revision": rev})
    cr.base, cr.operations, cr.updated_at = base, out, now()


def create(db: Session, ctx: RequestContext, p: ProjectRow, operations: Any, *, title: str | None = None, trusted: bool = False) -> ChangeRequest:
    ops = _validate_ops(operations, trusted=trusted)
    at = now()
    cr = ChangeRequest(id=uuid.uuid4().hex, project_id=p.id, title=(title or _title(ops))[:300], actor=ctx.principal, on_behalf_of=ctx.on_behalf_of, agent=agent_name(ctx), state="open", base={}, operations=[], findings=[], created_at=at, updated_at=at)
    db.add(cr)
    _append(db, p, cr, ops)
    db.flush()
    audit.record(db, ctx.for_scope(p.id, None), "change_request.opened", target=cr.id, after={"operations": [o["op"] for o in ops], "agent": cr.agent})
    _after_update(db, cr, p)
    return cr


def append(db: Session, ctx: RequestContext, cr: ChangeRequest, operations: Any, *, trusted: bool = False) -> ChangeRequest:
    if cr.state not in OPEN_STATES:
        raise HTTPException(409, {"error": f"the change request is {cr.state}"})
    if is_agent(ctx) and cr.actor != ctx.principal:
        raise HTTPException(403, "agents add operations only to their own change requests")
    p = db.get(ProjectRow, cr.project_id)
    assert p is not None
    ops = _validate_ops(operations, trusted=trusted)
    _append(db, p, cr, ops)
    db.flush()
    _after_update(db, cr, p)
    return cr


def open_or_append(db: Session, ctx: RequestContext, op_id: str, input: dict, *, title: str | None = None, project: ProjectRow | None = None) -> dict:
    """Add one operation to the actor's open change request in the project (or open one); run
    the checks; auto-merge when allowed. Returns the change request's JSON."""
    p = project or db.get(ProjectRow, ctx.workspace_id)
    if p is None:
        raise HTTPException(404, "no such project")
    cr = _open_cr(db, ctx, p)
    if cr is None:
        cr = create(db, ctx, p, [{"op": op_id, "input": input}], title=title, trusted=True)
    else:
        append(db, ctx, cr, [{"op": op_id, "input": input}], trusted=True)
    return to_json(db, cr)


def _replay(db: Session, ctx: RequestContext, p: ProjectRow, cr: ChangeRequest) -> list[Violation]:
    """Every operation in order: admit (dry run), then the real kernel function. Returns the
    findings; raises nothing (errors become findings)."""
    found: list[Violation] = []
    for i, o in enumerate(cr.operations or []):
        inp = o.get("input") or {}
        try:
            adm = admission.admit(o["op"], inp, admission.Ctx(project_id=p.id, principal=ctx.principal, rules=lambda _pid: _rules_of(db, p)), dry_run=True)
            found.extend(adm.findings)
            APPLIERS[o["op"]].apply(db, ctx, p, adm.value)
        except admission.WriteRejected as e:
            found.extend(replace(v, path=f"/operations/{i}{v.path}") for v in e.violations)
        except Rejected as e:
            found.extend(replace(v, path=f"/operations/{i}{v.path}") for v in e.violations)
        except HTTPException as e:
            found.extend(replace(v, path=f"/operations/{i}{v.path}") for v in _http(e).violations)
    return found


def _rules_of(db: Session, p: ProjectRow) -> dict:
    from . import rules as krules

    return krules.get(db, p)["rules"]


def _author_ctx(cr: ChangeRequest, p: ProjectRow, ctx: RequestContext | None = None) -> RequestContext:
    """The change request's author, as the replay's actor (history and audit name who wrote it)."""
    base = ctx or RequestContext(workspace_id=p.id, principal=cr.actor, correlation_id=uuid.uuid4().hex)
    return replace(base, workspace_id=p.id, task_id=None, principal=cr.actor, on_behalf_of=cr.on_behalf_of)


def run_checks(db: Session, cr: ChangeRequest, p: ProjectRow) -> bool:
    """open → checking → passed | failed. The replay runs in a SAVEPOINT that is rolled back."""
    cr.state = "checking"
    db.flush()
    sp = db.begin_nested()
    try:
        found = _replay(db, _author_ctx(cr, p), p, cr)
    finally:
        sp.rollback()
    ok = not any(v.severity == "error" and not v.evaluate for v in found)
    cr.findings = [v.to_json() for v in found]
    cr.state = "passed" if ok else "failed"
    cr.updated_at = now()
    db.flush()
    return ok


def _auto_merge_on(db: Session, p: ProjectRow) -> bool:
    auto = (_rules_of(db, p).get("merge") or {}).get("auto", "write-tier")
    return auto not in ("never", False, None)


def _after_update(db: Session, cr: ChangeRequest, p: ProjectRow) -> None:
    if run_checks(db, cr, p) and _auto_merge_on(db, p) and all(tier(o["op"]) == "write" for o in cr.operations or []):
        _merge(db, cr, p, AUTO_MERGE)


# ---- merge, close, comments ----------------------------------------------------------------------


def _moved(db: Session, cr: ChangeRequest, p: ProjectRow) -> bool:
    base = cr.base or {}
    for o in cr.operations or []:
        a = APPLIERS[o["op"]]
        key = a.resource(o.get("input") or {})
        if key in base and a.revision(db, p, o.get("input") or {}) != base[key]:
            return True
    return False


def _rebase(db: Session, cr: ChangeRequest, p: ProjectRow) -> None:
    base: dict[str, int] = {}
    ops = []
    for o in cr.operations or []:
        a = APPLIERS[o["op"]]
        rev = a.revision(db, p, o.get("input") or {})
        base.setdefault(a.resource(o.get("input") or {}), rev)
        ops.append({**o, "base_revision": rev})
    cr.base, cr.operations = base, ops


def _merge(db: Session, cr: ChangeRequest, p: ProjectRow, merged_by: str) -> ChangeRequest:
    """Replay for real. Not merged (state `needs-update`) when the base moved and checks now
    fail, or an operation no longer applies; the caller reads `cr.state`."""
    if _moved(db, cr, p):
        if not run_checks(db, cr, p):
            cr.state = "needs-update"
            db.flush()
            return cr
        _rebase(db, cr, p)
    sp = db.begin_nested()
    found = _replay(db, _author_ctx(cr, p), p, cr)
    if any(v.severity == "error" and not v.evaluate for v in found):
        sp.rollback()
        cr.findings, cr.state = [v.to_json() for v in found], "needs-update"
        db.flush()
        return cr
    sp.commit()
    at = now()
    cr.state, cr.merged_by, cr.merged_at, cr.updated_at = "merged", merged_by, at, at
    cr.findings = [v.to_json() for v in found]
    audit.record(db, RequestContext(workspace_id=p.id, principal=merged_by, correlation_id=uuid.uuid4().hex), "change_request.merged", target=cr.id, after={"operations": [o["op"] for o in cr.operations or []], "author": cr.actor})
    db.flush()
    return cr


def merge(db: Session, ctx: RequestContext, cr: ChangeRequest) -> ChangeRequest:
    if is_agent(ctx):
        raise HTTPException(403, AGENT_MERGE_DENIED)
    p = db.get(ProjectRow, cr.project_id)
    assert p is not None
    if cr.state in ("merged", "closed"):
        raise HTTPException(409, {"error": f"the change request is {cr.state}"})
    if cr.state in ("open", "checking", "failed", "needs-update") and not run_checks(db, cr, p):
        return cr  # still failing: the route answers 409 with the findings (state saved)
    return _merge(db, cr, p, ctx.principal)


def close(db: Session, ctx: RequestContext, cr: ChangeRequest) -> ChangeRequest:
    if is_agent(ctx) and cr.actor != ctx.principal:
        raise HTTPException(403, "agents close only their own change requests")
    if cr.state not in OPEN_STATES:
        raise HTTPException(409, {"error": f"the change request is {cr.state}"})
    cr.state, cr.updated_at = "closed", now()
    audit.record(db, ctx.for_scope(cr.project_id, None), "change_request.closed", target=cr.id)
    db.flush()
    return cr


def comment(db: Session, ctx: RequestContext, cr: ChangeRequest, body: Any) -> ChangeRequestComment:
    if not isinstance(body, str) or not body.strip():
        raise HTTPException(422, {"error": "body: the comment text"})
    c = ChangeRequestComment(id=uuid.uuid4().hex, change_request_id=cr.id, author=ctx.principal, body=body.strip()[:20000], created_at=now())
    db.add(c)
    cr.updated_at = c.created_at
    db.flush()
    return c


def require(db: Session, p: ProjectRow, cid: str) -> ChangeRequest:
    cr = db.get(ChangeRequest, cid)
    if cr is None or cr.project_id != p.id:
        raise HTTPException(404, "no such change request")
    return cr


def listing(db: Session, p: ProjectRow, state: str = "open") -> list[ChangeRequest]:
    q = select(ChangeRequest).where(ChangeRequest.project_id == p.id)
    if state == "open":
        q = q.where(ChangeRequest.state.in_(OPEN_STATES))
    elif state != "all":
        q = q.where(ChangeRequest.state == state)
    return list(db.scalars(q.order_by(ChangeRequest.updated_at.desc()).limit(200)))
