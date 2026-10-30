"""Routes the SPA needs in production that only the Vite dev server served before
(apps/web/dev/seed-server.ts): seed files and saved environments. Response shapes match
seed-server.ts exactly, so the Studio runs unchanged against either.

    GET          /seed/{path}                          → a seed file from the BlobStore (byte ranges)
    GET          /api/environments/{projectId}         → {revision, environment, savedAt?, author?, effective}
    PUT          /api/environments/{projectId}         → replace; 409 on a stale `revision`
    PATCH        /api/environments/{projectId}         → RFC 6902 patch of the saved (else manifest) environment
    GET          /api/environments/{projectId}/history → every saved revision
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
from typing import Any

import jsonpatch
from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import blobstore
from ..context import RequestContext, ensure_workspace, get_context
from ..db import get_session
from ..kernel import assets
from ..models import WorkspaceEnvironment, WorkspaceEnvironmentRevision, now
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

LEGACY_PRESETS = {
    "image-2d": "preset:image-2d",
    "volume-3d": "preset:volume-3d",
    "signal": "preset:ecg",
    "temporal": "preset:video",
    "cine-4d": "preset:cine-4d",
    "pathology": "preset:pathology",
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


def _label_groups(labels: list[str], task: str | None) -> list[dict]:
    classes = [{"id": label} for label in labels]
    groups = [{"name": "labels", "control": "Labels", "classes": classes}]
    if task == "classification":
        groups.insert(0, {"name": "class", "control": "Choices", "classes": classes})
    return groups


def manifest_environment(project_id: str) -> dict | None:
    """The environment a manifest project boots with: `normalizeProject` in
    apps/web/src/studio/lib/api.ts (v1 `viewer` + string labels are migrated)."""
    raw = next((p for p in (assets.seed_manifest() or {}).get("projects", []) if p.get("id") == project_id), None)
    if raw is None:
        return None
    labels = raw.get("labels")
    string_labels = labels if isinstance(labels, list) and all(isinstance(x, str) for x in labels) else None
    env: dict[str, Any] = dict(raw["environment"]) if raw.get("environment") else {"extends": LEGACY_PRESETS.get(raw.get("viewer") or "", f"preset:{raw.get('viewer')}")}
    if env.get("task") is None and raw.get("task") is not None:
        env["task"] = raw["task"]
    if env.get("labels") is None:
        groups = _label_groups(string_labels, raw.get("task")) if string_labels is not None else labels
        if groups is not None:
            env["labels"] = groups
    return env


def _doc(row: WorkspaceEnvironment | None) -> dict:
    if row is None or row.revision == 0:
        return {"revision": 0, "environment": None}
    out: dict = {"revision": row.revision, "environment": row.environment}
    if row.saved_at is not None:
        out["savedAt"] = _iso(row.saved_at)
    if row.author is not None:
        out["author"] = row.author
    return out


def _iso(d: datetime) -> str:
    """Like JS `toISOString()`: UTC, milliseconds, `Z`."""
    d = d if d.tzinfo else d.replace(tzinfo=UTC)
    return d.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _project(project_id: str, ctx: RequestContext) -> RequestContext | JSONResponse:
    if not PROJECT_ID.fullmatch(project_id):
        return _json(400, {"error": "bad project id"})
    if ctx.scopes and ctx.workspace_id != project_id:
        return _json(403, {"error": "session token is bound to another workspace"})
    return RequestContext(project_id, ctx.principal, ctx.correlation_id, ctx.idempotency_key, ctx.scopes, ctx.profile)


@router.post("/api/environments/validate")
def validate_environment():
    return _json(501, {"error": f"POST /api/environments/validate {DEV_ONLY}"})


@router.api_route("/api/catalog", methods=["GET", "POST"], include_in_schema=False)
@router.api_route("/api/catalog/{rest:path}", methods=["GET", "POST"], include_in_schema=False)
def catalog(rest: str = ""):
    return _json(501, {"error": f"/api/catalog {DEV_ONLY}"})


@router.get("/api/environments/{project_id}")
def get_environment(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    c = _project(project_id, ctx)
    if isinstance(c, JSONResponse):
        return c
    cur = _doc(db.get(WorkspaceEnvironment, c.workspace_id))
    # `effective`: what the Studio boots with (saved edits, else the manifest's environment).
    return {**cur, "effective": cur["environment"] if cur["environment"] is not None else manifest_environment(project_id)}


@router.get("/api/environments/{project_id}/history")
def environment_history(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    c = _project(project_id, ctx)
    if isinstance(c, JSONResponse):
        return c
    rows = db.query(WorkspaceEnvironmentRevision).filter(WorkspaceEnvironmentRevision.workspace_id == c.workspace_id).order_by(WorkspaceEnvironmentRevision.revision).all()
    return [{"revision": r.revision, "environment": r.environment, "savedAt": _iso(r.saved_at), "author": r.author} for r in rows]


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
    c = _project(project_id, ctx)
    if isinstance(c, JSONResponse):
        return c
    try:
        body = await _body(request)
    except _BadBody as e:
        return _json(400, {"error": str(e)})
    if not body:
        return _json(400, {"error": "missing body"})
    ensure_workspace(db, c.workspace_id)
    row = db.get(WorkspaceEnvironment, c.workspace_id)
    cur = _doc(row)
    # Same optimistic-concurrency rule for both verbs: a stale revision is a conflict.
    if "revision" in body and body["revision"] is not None and body["revision"] != cur["revision"]:
        return _json(409, {"error": "revision conflict", "current": cur})
    author = body.get("author") or ctx.principal.removeprefix("user:")

    if request.method == "PUT":
        environment = body.get("environment")
        if not isinstance(environment, dict):
            return _json(422, {"ok": False, "errors": [{"path": "", "code": "schema", "message": "environment must be an object"}]})
    else:
        base = cur["environment"] if cur["environment"] is not None else manifest_environment(project_id)
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

    saved = _save(db, c, row, cur["revision"], environment, author)
    if saved is None:
        db.rollback()
        return _json(409, {"error": "revision conflict", "current": _doc(db.get(WorkspaceEnvironment, c.workspace_id))})
    return saved


def _save(db: Session, ctx: RequestContext, row: WorkspaceEnvironment | None, seen: int, environment, author: str) -> dict | None:
    """Store revision `seen + 1` only if nobody else saved since (conditional UPDATE / unique
    INSERT), and append it to the history. None on a lost race."""
    at = now()
    rev = seen + 1
    try:
        if row is None:
            db.add(WorkspaceEnvironment(workspace_id=ctx.workspace_id, revision=rev, environment=environment, author=author, saved_at=at))
        else:
            res = db.execute(
                update(WorkspaceEnvironment)
                .where(WorkspaceEnvironment.workspace_id == ctx.workspace_id, WorkspaceEnvironment.revision == seen)
                .values(revision=rev, environment=environment, author=author, saved_at=at)
                .execution_options(synchronize_session=False)
            )
            if res.rowcount != 1:  # type: ignore[attr-defined]
                return None
        db.add(WorkspaceEnvironmentRevision(workspace_id=ctx.workspace_id, revision=rev, environment=environment, author=author, saved_at=at))
        db.flush()
    except IntegrityError:
        return None
    return {"revision": rev, "environment": environment, "savedAt": _iso(at), "author": author}
