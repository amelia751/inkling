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
    POST         /api/environments/validate            → 501: dev server only
    GET          /api/catalog[/…]                      → 501: dev server only

Validation needs the TypeScript registry and resolver, which the kernel doesn't have: the
kernel stores environments as given (the Studio validates them client-side before saving),
and `validate` / the catalogue stay on the dev server (seed-server.ts), which runs the
app's own registry through Vite.
"""

from __future__ import annotations

import json
import posixpath
import re
from datetime import UTC, datetime

import jsonpatch
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from .. import blobstore
from ..context import RequestContext, ensure_workspace, get_context, scope_of
from ..db import get_session
from ..kernel import projects, studio_defs
from ..kernel.canonical import content_hash
from ..models import WorkspaceEnvironment, WorkspaceEnvironmentRevision
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

DEV_ONLY = "needs the TypeScript registry and resolver, which only the dev server has (apps/web/dev/seed-server.ts); the kernel stores environments without server-side validation"


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
manifest_environment = projects.manifest_environment


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


def _project(project_id: str, ctx: RequestContext, db: Session) -> RequestContext | JSONResponse:
    """`:projectId` is a task id (todo6 D3); seeds' task, dataset and project share one id."""
    if not PROJECT_ID.fullmatch(project_id):
        return _json(400, {"error": "bad project id"})
    workspace, task = scope_of(db, project_id)
    if ctx.scopes and ctx.workspace_id != workspace:
        return _json(403, {"error": "session token is bound to another workspace"})
    c = ctx.for_scope(workspace, task)
    try:
        projects.project_of_scope(db, c)
    except HTTPException as e:
        return _json(e.status_code, {"error": e.detail})
    return c


def _base_environment(db: Session, c: RequestContext) -> dict | None:
    """What a task boots with when nothing is saved: its seed's manifest environment."""
    return manifest_environment(c.task)


@router.post("/api/environments/validate")
def validate_environment():
    return _json(501, {"error": f"POST /api/environments/validate {DEV_ONLY}"})


@router.api_route("/api/catalog", methods=["GET", "POST"], include_in_schema=False)
@router.api_route("/api/catalog/{rest:path}", methods=["GET", "POST"], include_in_schema=False)
def catalog(rest: str = ""):
    return _json(501, {"error": f"/api/catalog {DEV_ONLY}"})


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
    c = _project(project_id, ctx, db)
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
    c = _project(project_id, ctx, db)
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
    c = _project(project_id, ctx, db)
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


@router.put("/api/environments/{project_id}", operation_id="put_environment")
@router.patch("/api/environments/{project_id}", operation_id="patch_environment")
async def save_environment(project_id: str, request: Request, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    c = _project(project_id, ctx, db)
    if isinstance(c, JSONResponse):
        return c
    try:
        body = await _body(request)
    except _BadBody as e:
        return _json(400, {"error": str(e)})
    if not body:
        return _json(400, {"error": "missing body"})
    ensure_workspace(db, c.workspace_id)
    row = db.get(WorkspaceEnvironment, (c.workspace_id, c.task))
    cur = _doc(row)
    # Same optimistic-concurrency rule for both verbs: a stale revision is a conflict.
    if "revision" in body and body["revision"] is not None and body["revision"] != cur["revision"]:
        return _json(409, {"error": "revision conflict", "current": cur})
    prov = studio_defs.provenance(ctx, request.headers, body)

    if request.method == "PUT":
        environment = body.get("environment")
        if not isinstance(environment, dict):
            return _json(422, {"ok": False, "errors": [{"path": "", "code": "schema", "message": "environment must be an object"}]})
    else:
        base = cur["environment"] if cur["environment"] is not None else _base_environment(db, c)
        if not base:
            return _json(404, {"error": f'no project "{project_id}"'})
        ops = body.get("patch")
        if not isinstance(ops, list):
            return _json(422, {"ok": False, "errors": [{"path": "", "code": "schema", "message": "A JSON Patch is an array of operations"}]})
        errors, spec = [], base
        for i, op in enumerate(ops):
            try:
                spec = jsonpatch.JsonPatch([op]).apply(spec)
            except (jsonpatch.JsonPatchException, jsonpatch.JsonPointerException, KeyError, TypeError, ValueError) as e:
                desc = f"{op.get('op')} {op.get('path')}" if isinstance(op, dict) else "?"
                errors.append({"path": f"/{i}", "code": "schema", "message": f"Patch op {i} ({desc}): {e}"})
        if errors:
            return _json(422, {"ok": False, "errors": errors})
        environment = spec

    base = cur["environment"] if cur["environment"] is not None else _base_environment(db, c)
    saved = _save(db, c, row, cur["revision"], environment, prov, studio_defs.parent_hash(db, c.workspace_id, c.task, cur["revision"], base))
    if saved is None:
        db.rollback()
        return _json(409, {"error": "revision conflict", "current": _doc(db.get(WorkspaceEnvironment, (c.workspace_id, c.task)))})
    return saved


def _save(db: Session, ctx: RequestContext, row: WorkspaceEnvironment | None, seen: int, environment, prov: studio_defs.Provenance, parent: str) -> dict | None:
    """Store revision `seen + 1` (studio_defs.save_revision); None on a lost race."""
    hist = studio_defs.save_revision(db, ctx, row, seen, environment, prov, parent)
    return _revision(hist) if hist is not None else None
