"""Agent-facing data-boundary routes (todo10 §6.3, docs/deployment-gcp.md "What the agent sees").

The only routes through which an agent learns anything about real data. Each starts a worker
job or returns a fixed-schema result; none returns sample bytes. Scope: `samples.inspect`
(fingerprints, fixtures), `samples.verify` (verify, probes), `plugins.author` (builds),
`annotations.read` (the filtered view). Dev header identities have every scope.
"""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from ..context import RequestContext, get_context
from ..db import get_session
from ..kernel import boundary

router = APIRouter(prefix="/api/v1/boundary")


def _need(ctx: RequestContext, scope: str) -> None:
    if not ctx.allows(scope):
        raise HTTPException(403, f"this session lacks the {scope} scope")


@router.post("/fingerprints")
def get_fingerprint(body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """The sample's fingerprint if we have one, else a `fingerprint` job to poll."""
    _need(ctx, "samples.inspect")
    return boundary.request_fingerprint(db, ctx, str(body.get("sample") or ""))


@router.post("/fixtures")
def get_fixtures(body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    _need(ctx, "samples.inspect")
    return boundary.request_fixtures(db, ctx, str(body.get("sample") or ""), int(body.get("count") or 3))


@router.get("/fixtures/{fixture_set_id}/{name}")
def fixture(fixture_set_id: str, name: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """A synthetic fixture's bytes (made from the fingerprint alone), for the build sandbox."""
    _need(ctx, "samples.inspect")
    return Response(boundary.fixture_bytes(db, ctx, fixture_set_id, name), media_type="application/octet-stream")


@router.post("/verify")
async def verify_on_sample(request: Request, sample: str, entrypoint: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """Body: the plugin source as a tarball. Starts `verify_plugin` on the real sample, in the worker."""
    _need(ctx, "samples.verify")
    return boundary.request_verify(db, ctx, sample, await request.body(), entrypoint)


@router.post("/probes")
def probe_sample(body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    _need(ctx, "samples.verify")
    return boundary.request_probe(db, ctx, str(body.get("sample") or ""), body.get("probes") or [])


@router.post("/builds")
async def build_plugin(request: Request, sandboxDigest: str | None = None, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """Body: the plugin source as a tarball. Our worker rebuilds, hashes and signs it; that
    bundle (not the sandbox's) is what gets registered."""
    _need(ctx, "plugins.author")
    return boundary.request_build(db, ctx, await request.body(), sandboxDigest)


@router.get("/jobs/{job_id}")
def job(job_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """Job summary (counts, state, error classes) and, for boundary jobs, the typed result."""
    return boundary.job_view(db, ctx, job_id)


@router.get("/annotations")
def filtered_annotations(item_id: str | None = None, label: str | None = None, limit: int = 200, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """Geometries and vocabulary labels; free text comes back as placeholders."""
    _need(ctx, "annotations.read")
    return boundary.filtered_annotations(db, ctx, item_id, label, limit)


@router.post("/annotations/export")
def export_annotations(ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    _need(ctx, "assets.write")
    return boundary.export_annotations(db, ctx)
