"""Routes the SPA needs in production that only the Vite dev server served before
(apps/web/dev/seed-server.ts): seed files and saved environments. Response shapes match
seed-server.ts exactly, so the Studio runs unchanged against either.

    GET          /seed/{path}                          → a seed file from the BlobStore (byte ranges)
    GET          /api/environments/{projectId}         → {revision, environment, savedAt?, author?, effective}
    PUT          /api/environments/{projectId}         → replace; 409 on a stale `revision`
    PATCH        /api/environments/{projectId}         → RFC 6902 patch of the saved (else manifest) environment
    GET          /api/environments/{projectId}/history → every saved revision (hashes, provenance)
    GET          /api/environments/{projectId}/lockfile → the workspace's plugins.lock.json + its hash
    PUT          /api/environments/{projectId}/readme → the task's .studio README (intent and notes)
    GET          /api/environments/{projectId}/last-known-good → the setup safe mode boots (404: none yet)
    PUT          /api/environments/{projectId}/last-known-good → a person marks the current setup known good
    POST         /api/environments/{projectId}/checks → the Studio booted it cleanly (may move last-known-good)
    POST         /api/environments/{projectId}/rollback → restore last-known-good (environment + pins), one transaction
    GET          /api/environments/{projectId}/audit → the workspace's hash-chained audit verifies
    POST         /api/environments/validate            → shape and reference checks (todo11 D2)
    GET          /api/catalog, /api/catalog/schema     → schemas/catalog.json, schemas/environment.v1.json
    GET          /api/catalog/prompt                   → schemas/catalog.md (the MCP `catalog` tool)
    GET          /api/catalog/{capabilities,plugins/…} → 501: dev server only

Every write is checked here (kernel/environment_policy.py, todo11 D2): required `revision`,
who may write the task, the agent's mutation scope, shape and references against the
generated schema. Resolve-level checks (extends merge, overrides) stay in the Studio's
TypeScript resolver; `packages/environment-core` shares these rules with clients.
"""

from __future__ import annotations

import json
import posixpath
import re
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from .. import blobstore
from ..context import RequestContext, ensure_workspace, get_context, scope_of
from ..db import get_session
from ..kernel import boots, environment_admission, environment_policy, projects, studio_defs
from ..kernel.admission import doors
from ..kernel.admission.http import WriteParams, declares, write_params
from ..kernel.canonical import content_hash
from ..models import ProjectRow, WorkspaceEnvironment, WorkspaceEnvironmentRevision
from ..streaming import blob_response

router = APIRouter()

PROJECT_ID = re.compile(r"[a-z0-9-]+")

# Same table as seed-server.ts (what the Studio's loaders expect for seed files).
SEED_TYPES = {
    ".json": "application/json",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".gz": "application/gzip",
    ".mp4": "video/mp4",
    ".dzi": "application/xml",
}

DEV_ONLY = "needs the TypeScript registry, which only the dev server has (apps/web/dev/seed-server.ts)"


def _json(status: int, body) -> JSONResponse:
    return JSONResponse(body, status_code=status)


# ---- Seed files ------------------------------------------------------------------------------


@router.api_route("/seed/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
def seed_file(path: str, request: Request):
    """Seed data (keys = seed-data relative paths). Dot-prefixed keys (`.data/`, `.annotations/`)
    are never served: that's where derived and private data live."""
    try:
        key = blobstore.safe_key(path)
    except blobstore.BlobNotFound:
        return Response(status_code=404)
    if any(part.startswith(".") for part in key.split("/")):
        return Response(status_code=404)
    ext = posixpath.splitext(key)[1].lower()
    return blob_response(blobstore.assets(), key, SEED_TYPES.get(ext, "application/octet-stream"), request)


# ---- Environments ----------------------------------------------------------------------------

# The manifest environment moved to the kernel (projects.py) with the seed backfill.


def _doc(row: WorkspaceEnvironment | None) -> dict:
    if row is None or row.revision == 0:
        return {"revision": 0, "environment": None}
    out: dict = {"revision": row.revision, "environment": row.environment}
    if row.saved_at is not None:
        out["savedAt"] = _iso(row.saved_at)
    if row.author is not None:
        out["author"] = row.author
    out["contentHash"] = content_hash(row.environment)
    return out


def _revision(r: WorkspaceEnvironmentRevision) -> dict:
    return {"revision": r.revision, "environment": r.environment, "savedAt": _iso(r.saved_at), "author": r.author, **studio_defs.revision_meta(r)}


def _iso(d: datetime) -> str:
    """Like JS `toISOString()`: UTC, milliseconds, `Z`."""
    d = d if d.tzinfo else d.replace(tzinfo=UTC)
    return d.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _project(project_id: str, ctx: RequestContext, db: Session, *, write: bool = False) -> RequestContext | JSONResponse:
    """`:projectId` is a task id (todo6 D3); seeds' task, dataset and project share one id."""
    if not PROJECT_ID.fullmatch(project_id):
        return _json(400, {"error": "bad project id"})
    workspace, task = scope_of(db, project_id)
    if ctx.scopes and ctx.workspace_id != workspace:
        return _json(403, {"error": "session token is bound to another workspace"})
    c = ctx.for_scope(workspace, task)
    try:
        projects.project_of_scope(db, c, write=write)
    except HTTPException as e:
        return _json(e.status_code, {"error": e.detail})
    return c


def _base_environment(db: Session, c: RequestContext) -> dict | None:
    """What a task boots with when nothing is saved: its seed's manifest environment."""
    return projects.base_environment(db, c.task)


@router.post("/api/environments/validate")
async def validate_environment(request: Request, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """todo11 D2: the same checks a write gets (shape and references against the generated
    schema and the workspace's installed plugins), without saving. Body: the spec. todo17 D2: the
    resolver's deterministic checks run too; errors reject, warnings come back as `warnings`."""
    try:
        body = await _body(request)
    except _BadBody as e:
        return _json(400, {"error": str(e)})
    checked = environment_policy.check_write(principal="person", installed=environment_policy.installed_plugins(db, ctx.workspace_id), environment=body)
    if not checked.ok:
        return _json(422, {**checked.body(), "warnings": checked.warnings})
    return {"ok": True, "spec": body, "warnings": checked.warnings}


@router.api_route("/api/catalog", methods=["GET"], include_in_schema=False)
def catalog(kind: str | None = None):
    """The generated catalogue (`schemas/catalog.json`), the same file the web server serves.
    `?kind=<detected kind>` (todo13 "Find a plugin"): only the data kinds that open that kind
    of file (their `fileKinds`), and their modules; none means no plugin for it yet."""
    out = _static_json("catalog.json")
    if not kind or not isinstance(out, dict):
        return out
    k = kind.strip().lower()
    contributions = [c for c in out.get("contributions") or [] if c.get("type") == "dataKinds" and k in (c.get("fileKinds") or [])]
    modules = {c["module"] for c in contributions}
    return {"version": 1, "modules": [m for m in out.get("modules") or [] if m.get("id") in modules], "contributions": contributions}


@router.api_route("/api/catalog/schema", methods=["GET"], include_in_schema=False)
def catalog_schema():
    return _static_json("environment.v1.json")


@router.api_route("/api/catalog/prompt", methods=["GET"], include_in_schema=False)
def catalog_prompt():
    """The catalogue as Markdown (`schemas/catalog.md`, served by the web as /catalog.md): what an
    outside agent reads before writing an environment (todo17 M0)."""
    from ..config import settings

    try:
        return Response((settings().repo_root / "schemas" / "catalog.md").read_text(), media_type="text/markdown; charset=utf-8")
    except FileNotFoundError:
        return _json(404, {"error": "schemas/catalog.md isn't in this image"})


@router.api_route("/api/catalog/{rest:path}", methods=["GET", "POST"], include_in_schema=False)
def catalog_rest(rest: str = ""):
    return _json(501, {"error": f"/api/catalog/{rest} {DEV_ONLY}"})


def _static_json(name: str):
    from ..config import settings

    try:
        return json.loads((settings().repo_root / "schemas" / name).read_text())
    except FileNotFoundError:
        return _json(404, {"error": f"schemas/{name} isn't in this image"})


@router.get("/api/environments/{project_id}")
def get_environment(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    c = _project(project_id, ctx, db)
    if isinstance(c, JSONResponse):
        return c
    cur = _doc(db.get(WorkspaceEnvironment, (c.workspace_id, c.task)))
    # `effective`: what the Studio boots with (saved edits, else the manifest's environment).
    return {**cur, "effective": cur["environment"] if cur["environment"] is not None else _base_environment(db, c)}


@router.get("/api/environments/{project_id}/history")
def environment_history(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    c = _project(project_id, ctx, db)
    if isinstance(c, JSONResponse):
        return c
    rows = db.query(WorkspaceEnvironmentRevision).filter(WorkspaceEnvironmentRevision.workspace_id == c.workspace_id, WorkspaceEnvironmentRevision.task_id == c.task).order_by(WorkspaceEnvironmentRevision.revision).all()
    return [_revision(r) for r in rows]


@router.put("/api/environments/{project_id}/readme")
async def put_readme(project_id: str, request: Request, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """The task's `.studio/tasks/<id>/README.md`: intent and notes (todo10 §3.2)."""
    c = _project(project_id, ctx, db, write=True)
    if isinstance(c, JSONResponse):
        return c
    try:
        body = await _body(request) or {}
    except _BadBody as e:
        return _json(400, {"error": str(e)})
    if not isinstance(body.get("text"), str):
        return _json(422, {"error": "text must be a string"})
    prov = studio_defs.provenance(ctx, request.headers, body)
    studio_defs.set_readme(db, c, c.task, body["text"], prov.author)
    return {"readme": studio_defs.readme(db, c.workspace_id, c.task), "author": prov.author}


# ---- todo10 Phase 4: last-known-good, safe mode, rollback ------------------------------------
# Writes are a person's: an agent session gets 403 (the model can't move the baseline it
# would be rolled back to). Nothing here calls a model or the versioning service.


def _person(ctx: RequestContext) -> JSONResponse | None:
    if ctx.principal.startswith("agent:"):
        return _json(403, {"error": "only a person can do this (todo10 §3.4)"})
    return None


@router.get("/api/environments/{project_id}/last-known-good")
def get_known_good(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    c = _project(project_id, ctx, db)
    if isinstance(c, JSONResponse):
        return c
    k = studio_defs.known_good(db, c.workspace_id, c.task)
    return studio_defs.known_good_doc(k) if k is not None else _json(404, {"error": "no last-known-good setup yet"})


@router.put("/api/environments/{project_id}/last-known-good")
async def put_known_good(project_id: str, request: Request, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    c = _project(project_id, ctx, db, write=True)
    if isinstance(c, JSONResponse):
        return c
    if (denied := _person(ctx)) is not None:
        return denied
    try:
        body = await _body(request) or {}
    except _BadBody as e:
        return _json(400, {"error": str(e)})
    ensure_workspace(db, c.workspace_id)
    row = db.get(WorkspaceEnvironment, (c.workspace_id, c.task))
    rev = body.get("revision", row.revision if row is not None else 0)
    if not isinstance(rev, int):
        return _json(422, {"error": "revision must be an integer"})
    out = studio_defs.move_known_good(db, c, c.task, rev, studio_defs.PERSON)
    # A person approving the setup (an agent's change included) is a moment to commit it (§3.2).
    out["committed"] = _commit_studio(db, c, "known good")
    return out


@router.post("/api/environments/{project_id}/checks")
async def boot_checks(project_id: str, request: Request, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """The Studio resolved this revision and loaded every module (`ok`): passing checks may move
    last-known-good, never to an agent's change or to plugins that widen permissions."""
    c = _project(project_id, ctx, db)
    if isinstance(c, JSONResponse):
        return c
    if (denied := _person(ctx)) is not None:
        return denied
    if db.get(ProjectRow, c.workspace_id) is not None and not projects.can_write(db, c, c.workspace_id):
        # todo14 D7: a viewer (the Samples templates) boots fine but never moves last-known-good.
        return {"moved": False, "reason": "you can view this project but not change it"}
    try:
        body = await _body(request) or {}
    except _BadBody as e:
        return _json(400, {"error": str(e)})
    if body.get("ok") is not True or not isinstance(body.get("revision"), int):
        return _json(422, {"error": "send {revision, contentHash, ok: true} after a clean boot"})
    ensure_workspace(db, c.workspace_id)
    current = studio_defs.effective_environment(db, c.workspace_id, c.task)
    if body.get("contentHash") and body["contentHash"] != content_hash(current):
        return {"moved": False, "reason": "the Studio booted another setup than the current one"}
    try:
        return studio_defs.move_known_good(db, c, c.task, body["revision"], studio_defs.CHECKS)
    except HTTPException as e:
        return {"moved": False, "reason": e.detail if isinstance(e.detail, str) else e.detail.get("message")}


@router.post("/api/environments/{project_id}/rollback")
def rollback_environment(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    c = _project(project_id, ctx, db, write=True)
    if isinstance(c, JSONResponse):
        return c
    if (denied := _person(ctx)) is not None:
        return denied
    ensure_workspace(db, c.workspace_id)
    return studio_defs.rollback(db, c, c.task)


@router.get("/api/environments/{project_id}/audit")
def audit_chain(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    from ..kernel import audit

    c = _project(project_id, ctx, db)
    if isinstance(c, JSONResponse):
        return c
    return {**audit.verify_chain(db, c.workspace_id), "entries": audit.entries(db, c, limit=50, action=None)}


def _commit_studio(db: Session, c: RequestContext, reason: str) -> bool:
    """Best effort: commit the setup to the person's work branch when the task's dataset is versioned."""
    from ..kernel.versioning import client as vclient, service as vservice
    from ..models import DatasetRepo

    if not vclient.configured() or db.get(DatasetRepo, (c.workspace_id, c.task)) is None:
        return False
    status, _ = vservice.run(db, c, "studio.commit", c.task, {"reason": reason})
    return status in (200, 201)


@router.get("/api/environments/{project_id}/lockfile")
def environment_lockfile(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """The workspace's `plugins.lock.json` (todo10 §3.2): its ACTIVATED pins by digest."""
    from ..plugins import installer

    c = _project(project_id, ctx, db)
    if isinstance(c, JSONResponse):
        return c
    ensure_workspace(db, c.workspace_id)
    installer.bootstrap(db, c)
    lock = studio_defs.lockfile(db, c.workspace_id)
    return {"lockfile": lock, "contentHash": studio_defs.lockfile_hash(lock)}


async def _body(request: Request) -> dict | None:
    raw = await request.body()
    if not raw:
        return None
    try:
        b = json.loads(raw)
    except ValueError as e:
        raise _BadBody(str(e)) from None
    return b if isinstance(b, dict) else None


class _BadBody(Exception):
    pass


@router.put("/api/environments/{project_id}", operation_id="put_environment", openapi_extra=declares("studio.save"))
@router.patch("/api/environments/{project_id}", operation_id="patch_environment", openapi_extra=declares("studio.patch"))
async def save_environment(project_id: str, request: Request, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session), w: WriteParams = Depends(write_params)):
    """todo11 D2: the API is the authority on every write, whoever the caller is: who may write
    this task, a required `revision` (409 when stale), the agent's mutation scope (403), and
    shape and references (422) — `kernel/environment_policy.py`. todo17: through admit():
    an environment that doesn't resolve is 422 problem JSON (`env.unresolved`, with the legacy
    `errors[]`), label drift from the project's rules comes back as `findings`; `dryRun=true`
    runs everything without saving; `Idempotency-Key` replays a retry."""
    c = _project(project_id, ctx, db, write=True)
    if isinstance(c, JSONResponse):
        return c
    try:
        body = await _body(request)
    except _BadBody as e:
        return _json(400, {"error": str(e)})
    if not body:
        return _json(400, {"error": "missing body"})
    is_patch = request.method == "PATCH"
    op = environment_admission.PATCH_OP if is_patch else environment_admission.SAVE_OP
    if w.dry_run:
        return _save_environment(project_id, request, ctx, db, c, body, is_patch, op, dry_run=True)
    # Idempotency-Key (D13): a retry replays the stored answer before the revision check (which
    # the first attempt moved on); only successes are stored.
    with doors.IdempotentWrite(db, w.idempotency_key, ctx.principal, op.id, {"path": project_id, "body": body}) as idem:
        if idem.replay is not None:
            return _json(idem.replay.status, idem.replay.response)
        out = _save_environment(project_id, request, ctx, db, c, body, is_patch, op, dry_run=False)
        if isinstance(out, dict):
            idem.complete(200, out)
        return out


def _save_environment(project_id: str, request: Request, ctx: RequestContext, db: Session, c: RequestContext, body: dict, is_patch: bool, op, *, dry_run: bool):
    agent = ctx.principal.startswith("agent:")
    if agent and not boots.agent_may_write(db, ctx, c.task):
        return _json(403, {"ok": False, "errors": [{"path": "", "code": "scope", "message": "an agent may change only the drafts it booted, or the task the person opened it on"}]})
    ensure_workspace(db, c.workspace_id)
    row = db.get(WorkspaceEnvironment, (c.workspace_id, c.task))
    cur = _doc(row)
    if not isinstance(body.get("revision"), int) or isinstance(body.get("revision"), bool):
        return _json(422, {"ok": False, "errors": [{"path": "/revision", "code": "schema", "message": "send the revision you edited (revision: <int>, 0 for a first save); a stale one is a 409"}]})
    # Same optimistic-concurrency rule for both verbs: a stale revision is a conflict.
    if body["revision"] != cur["revision"]:
        return _json(409, {"error": "revision conflict", "current": cur})
    prov = studio_defs.provenance(ctx, request.headers, body)
    if request.method == "PATCH" and (deferred := _change_request(db, ctx, c, body, prov)) is not None:
        return deferred

    base = cur["environment"] if cur["environment"] is not None else _base_environment(db, c)
    if is_patch and not base:
        return _json(404, {"error": f'no project "{project_id}"'})
    ops = body.get("patch") if is_patch else None
    checked = environment_policy.check_write(
        principal="agent" if agent else "person",
        installed=environment_policy.installed_plugins(db, c.workspace_id),
        base=base,
        patch=ops,
        environment=None if is_patch else body.get("environment"),
        is_patch=is_patch,
    )
    if checked.status == 403:
        return _json(checked.status, checked.body())
    res = environment_admission.admit_environment(db, c.workspace_id, op, checked, principal=ctx.principal, on_behalf_of=ctx.on_behalf_of, dry_run=dry_run)
    if dry_run:
        return environment_admission.success({"ok": True, "revision": cur["revision"], "environment": res.value}, res, checked.warnings)
    saved = _save(db, c, row, cur["revision"], res.value, prov, studio_defs.parent_hash(db, c.workspace_id, c.task, cur["revision"], base), ops)
    if saved is None:
        db.rollback()
        return _json(409, {"error": "revision conflict", "current": _doc(db.get(WorkspaceEnvironment, (c.workspace_id, c.task)))})
    environment_admission.record(db, c.workspace_id, c.task, res)
    return environment_admission.success(saved, res, checked.warnings)


def _change_request(db: Session, ctx: RequestContext, c: RequestContext, body: dict, prov: studio_defs.Provenance) -> JSONResponse | dict | None:
    """todo17 D7: an agent's patch to a published Studio opens (or adds to) its change request
    (202 `{changeRequest}`); drafts and the agent's scratch fall through and apply directly. When
    it auto-merged at once, the answer is the saved revision as before, plus `changeRequest`."""
    from ..kernel import change_requests as crs

    p = db.get(ProjectRow, c.workspace_id)
    if p is None or not crs.is_agent(ctx):
        return None
    inp = {"taskId": c.task, "patch": body.get("patch"), "provenance": {"author": prov.author, "kind": prov.kind, "runId": prov.run_id, "promptHash": prov.prompt_hash}}
    if not crs.needs_change_request(db, ctx, p, "studio.patch", inp):
        return None
    cr = crs.open_or_append(db, ctx, "studio.patch", inp, project=p)
    if cr["state"] == "merged":
        return {**_doc_revision(db, c), "changeRequest": cr}
    return _json(202, {"changeRequest": cr})


def _doc_revision(db: Session, c: RequestContext) -> dict:
    from sqlalchemy import select

    r = db.scalars(select(WorkspaceEnvironmentRevision).where(WorkspaceEnvironmentRevision.workspace_id == c.workspace_id, WorkspaceEnvironmentRevision.task_id == c.task).order_by(WorkspaceEnvironmentRevision.revision.desc()).limit(1)).first()
    return _revision(r) if r is not None else {}


def _save(db: Session, ctx: RequestContext, row: WorkspaceEnvironment | None, seen: int, environment, prov: studio_defs.Provenance, parent: str, patch: list | None = None) -> dict | None:
    """Store revision `seen + 1` (studio_defs.save_revision); None on a lost race."""
    hist = studio_defs.save_revision(db, ctx, row, seen, environment, prov, parent, patch)
    return _revision(hist) if hist is not None else None
