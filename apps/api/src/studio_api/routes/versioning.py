"""Public dataset-versioning routes (todo4 Phase 6), mirroring versioning.md §10 under
`/api/v1/datasets/{id}/…`. Browsers, the agent and MCP never talk to apps/versioning: each
handler authenticates (`get_context`), checks the workspace's dataset and the session's
scopes, mints a 60 s service JWT, calls the generated client and writes an audit entry
(`kernel/versioning/service.py`). Service problems keep their status and stable `code`
(`stale_head`, `self_approval`, `protected_branch`…) and come back as
application/problem+json.

The same operations are kernel commands (`<ns>.versioning.*` through `POST /api/v1/commands`).
"""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from ..context import RequestContext, get_context
from ..db import get_session
from ..kernel.versioning import client as vclient
from ..kernel.versioning import service

router = APIRouter(prefix="/api/v1")


def _reply(status: int, body: dict) -> JSONResponse:
    return JSONResponse(body, status_code=status, media_type="application/problem+json" if status >= 400 else None)


def _run(db: Session, ctx: RequestContext, op: str, dataset_id: str, body: dict | None = None) -> JSONResponse:
    return _reply(*service.run(db, ctx, op, dataset_id, body))


@router.get("/versioning/status")
def status(ctx: RequestContext = Depends(get_context)):
    """Whether the Studio should use versioned saves: the service is configured (and, best
    effort, reachable). The web reads this to switch its save path on."""
    if not vclient.configured():
        return {"configured": False, "ready": False}
    try:
        ready = vclient.client().ready()
    except vclient.VersioningProblem:
        ready = False
    return {"configured": True, "ready": ready, "workBranchPrefix": "work/", "principal": ctx.principal}


@router.post("/datasets")
def create_dataset(body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return _run(db, ctx, "dataset.create", str(body.get("id") or ""), body)


@router.get("/datasets/{dataset_id}")
def get_dataset(dataset_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return _run(db, ctx, "dataset.get", dataset_id)


@router.post("/datasets/{dataset_id}/branches")
def create_branch(dataset_id: str, body: dict = Body(default={}), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return _run(db, ctx, "branch", dataset_id, body)


@router.get("/datasets/{dataset_id}/branches")
def list_branches(dataset_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return _run(db, ctx, "branches", dataset_id)


@router.post("/datasets/{dataset_id}/artifacts")
async def put_artifact(dataset_id: str, request: Request, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    data = await request.body()
    media = request.headers.get("X-Media-Type") or request.headers.get("Content-Type") or "application/octet-stream"
    return _run(db, ctx, "artifact", dataset_id, {"data": data, "media_type": media.split(";")[0].strip()})


@router.post("/datasets/{dataset_id}/commits")
def create_commit(dataset_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return _run(db, ctx, "commit", dataset_id, body)


@router.get("/datasets/{dataset_id}/commits")
def list_commits(dataset_id: str, ref: str = "main", cursor: str | None = None, limit: int = 50, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return _run(db, ctx, "commits", dataset_id, {"ref": ref, "cursor": cursor, "limit": limit})


@router.get("/datasets/{dataset_id}/commits/{oid}")
def get_commit(dataset_id: str, oid: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return _run(db, ctx, "commit.get", dataset_id, {"oid": oid})


@router.post("/datasets/{dataset_id}/reverts")
def revert(dataset_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return _run(db, ctx, "revert", dataset_id, body)


@router.get("/datasets/{dataset_id}/diff")
def diff(dataset_id: str, base: str = "main", head: str | None = None, cursor: str | None = None, limit: int = 200, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return _run(db, ctx, "diff", dataset_id, {"base": base, "head": head, "cursor": cursor, "limit": limit})


@router.get("/datasets/{dataset_id}/document")
def document(dataset_id: str, ref: str | None = None, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return _run(db, ctx, "document", dataset_id, {"ref": ref})


@router.post("/datasets/{dataset_id}/reviews")
def open_review(dataset_id: str, body: dict = Body(default={}), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return _run(db, ctx, "review.open", dataset_id, body)


@router.get("/datasets/{dataset_id}/reviews")
def list_reviews(dataset_id: str, status: str | None = None, cursor: str | None = None, limit: int = 50, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return _run(db, ctx, "reviews", dataset_id, {"status": status, "cursor": cursor, "limit": limit})


@router.get("/datasets/{dataset_id}/reviews/{review_id}")
def get_review(dataset_id: str, review_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return _run(db, ctx, "review.get", dataset_id, {"review_id": review_id})


@router.post("/datasets/{dataset_id}/reviews/{review_id}/approve")
def approve(dataset_id: str, review_id: str, body: dict = Body(default={}), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return _run(db, ctx, "review.approve", dataset_id, {**body, "review_id": review_id})


@router.post("/datasets/{dataset_id}/reviews/{review_id}/resolutions")
def resolve(dataset_id: str, review_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return _run(db, ctx, "review.resolve", dataset_id, {**body, "review_id": review_id})


@router.post("/datasets/{dataset_id}/reviews/{review_id}/checks/{name}")
def report_check(dataset_id: str, review_id: str, name: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """Worker-computed checks (de-identification). Sessions need `versioning.checks`; the
    worker itself posts through /api/v1/worker/versioning/checks with its worker token."""
    return _run(db, ctx, "review.check", dataset_id, {**body, "review_id": review_id, "name": name})


@router.post("/datasets/{dataset_id}/reviews/{review_id}/merge")
def merge(dataset_id: str, review_id: str, body: dict = Body(default={}), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return _run(db, ctx, "merge", dataset_id, {**body, "review_id": review_id})


@router.post("/datasets/{dataset_id}/releases")
def create_release(dataset_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return _run(db, ctx, "release", dataset_id, body)


@router.get("/datasets/{dataset_id}/releases")
def list_releases(dataset_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return _run(db, ctx, "releases", dataset_id)


@router.post("/datasets/{dataset_id}/checkouts")
def checkout(dataset_id: str, body: dict = Body(default={}), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return _run(db, ctx, "checkout", dataset_id, body)


# ---- Studio definitions (todo10 §3.2, Phase 2) -----------------------------------------------


@router.get("/datasets/{dataset_id}/studio")
def studio_setup(dataset_id: str, ref: str | None = None, current: bool = False, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """The Studio setup (`.studio/`: lockfile, environments, READMEs) at a branch, oid or `tag:<release>`."""
    return _run(db, ctx, "studio", dataset_id, {"ref": ref, "current": current})


@router.post("/datasets/{dataset_id}/studio/commits")
def commit_studio_setup(dataset_id: str, body: dict = Body(default={}), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """Commit the live Studio setup onto the caller's work branch (Task setup saved, an agent change approved)."""
    return _run(db, ctx, "studio.commit", dataset_id, body)
