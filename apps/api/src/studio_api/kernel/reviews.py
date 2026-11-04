"""Artifact reviews (todo23 W9, D11): the builder never approves its own work.

A `review.v1` document (zod in `packages/contracts/src/review.ts`, `schemas/review.v1.json`) is
stored per artifact version in `artifact_reviews`. The pydantic models here mirror it. The
reviewer is the caller's principal (never taken from the body) and can't be the artifact's
author or builder (403). `has_passing_review` is what promotion (routes/plugins.py) and preview
Keep check: the latest review of that exact version must say `pass`.

Hidden tests (D4) are adversarial tests a reviewer writes; they live here, out of the builder's
reach: builder sessions (no `reviews.write` scope) can neither write nor read them.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..context import RequestContext
from ..models import ArtifactReview, HiddenTest, PluginArtifact
from ..naming import canonical_id

REVIEW_WRITE = "reviews.write"
REVIEW_READ = "reviews.read"
# Agent principals that may review: their sessions are minted for the reviewer and red-team profiles.
REVIEWER_AGENTS = ("agent:reviewer", "agent:red-team")


class _M(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ArtifactRef(_M):
    kind: str = Field(min_length=1, max_length=64)
    id: str = Field(min_length=1, max_length=256)
    version: str = Field(min_length=1, max_length=128)


class Finding(_M):
    severity: Literal["blocker", "major", "minor", "info"]
    class_: str = Field(alias="class", min_length=1, max_length=128)
    file: str | None = None
    line: int | None = Field(default=None, ge=1)
    claim: str = Field(min_length=1, max_length=4000)
    test: str | None = None
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class Review(_M):
    schema_: Literal["review.v1"] = Field(default="review.v1", alias="schema")
    artifact: ArtifactRef
    reviewer: str | None = None  # set from the caller
    model: str = Field(min_length=1, max_length=256)
    verdict: Literal["pass", "block", "needs-person"]
    findings: list[Finding] = Field(default_factory=list, max_length=500)
    createdAt: str | None = None  # set by the kernel
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


def _ref(artifact: ArtifactRef | dict[str, Any] | tuple[str, str, str]) -> tuple[str, str, str]:
    if isinstance(artifact, tuple):
        kind, aid, version = artifact
    elif isinstance(artifact, dict):
        kind, aid, version = str(artifact["kind"]), str(artifact["id"]), str(artifact["version"])
    else:
        kind, aid, version = artifact.kind, artifact.id, artifact.version
    if kind == "plugin":
        aid = canonical_id(aid)
    return kind, aid, version


# Who built an artifact version, per kind. Plugins answer from their stored artifact; other kinds
# (previews, recipes) register a resolver here. None: unknown (the body's `authors` are used).
AUTHOR_RESOLVERS: dict[str, Callable[[Session, str, str], list[str] | None]] = {}


def _plugin_authors(db: Session, plugin_id: str, version: str) -> list[str] | None:
    row = db.get(PluginArtifact, (plugin_id, version))
    return [row.created_by] if row is not None else None


AUTHOR_RESOLVERS["plugin"] = _plugin_authors


def authors(db: Session, artifact: tuple[str, str, str], claimed: list[str] | None = None) -> set[str]:
    kind, aid, version = artifact
    found = AUTHOR_RESOLVERS.get(kind, lambda *_: None)(db, aid, version)
    # The builder agent is an author of everything it builds, whatever the row says.
    return {*(found or []), *(claimed or []), "agent:builder"}


def _may_review(ctx: RequestContext) -> None:
    if ctx.principal.startswith("agent:"):
        if not ctx.scopes or REVIEW_WRITE not in ctx.scopes or ctx.principal not in REVIEWER_AGENTS:
            raise HTTPException(403, "only reviewer sessions write reviews; the builder never reviews its own work")
    elif not ctx.allows(REVIEW_WRITE) and ctx.scopes:
        raise HTTPException(403, "this token can't write reviews")


def submit(db: Session, ctx: RequestContext, body: dict[str, Any]) -> ArtifactReview:
    _may_review(ctx)
    claimed = body.pop("authors", None) if isinstance(body, dict) else None
    try:
        review = Review.model_validate(body)
    except ValidationError as e:
        raise HTTPException(422, {"message": "not a review.v1 document", "errors": e.errors(include_url=False, include_context=False)}) from None
    if review.verdict == "pass" and any(f.severity == "blocker" for f in review.findings):
        raise HTTPException(422, "a pass verdict can't carry a blocker finding")
    ref = _ref(review.artifact)
    by = authors(db, ref, [str(c) for c in claimed] if isinstance(claimed, list) else None)
    # The reviewer is who calls, and also whoever the agent session acts for.
    if ctx.principal in by or (ctx.on_behalf_of and ctx.on_behalf_of in by and not ctx.principal.startswith("agent:")):
        raise HTTPException(403, "the reviewer can't be the artifact's author or builder")
    created = datetime.now(UTC)
    doc = review.model_dump(by_alias=True)
    doc.update(reviewer=ctx.principal, createdAt=created.isoformat().replace("+00:00", "Z"), artifact={"kind": ref[0], "id": ref[1], "version": ref[2]})
    row = ArtifactReview(workspace_id=ctx.workspace_id, artifact_kind=ref[0], artifact_id=ref[1], artifact_version=ref[2], review=doc, verdict=review.verdict, reviewer=ctx.principal, created_at=created)
    db.add(row)
    db.flush()
    return row


def parse_artifact(s: str) -> tuple[str, str, str]:
    """`kind:id@version` (the `?artifact=` query form)."""
    kind, sep, rest = s.partition(":")
    aid, at, version = rest.rpartition("@")
    if not sep or not at or not kind or not aid or not version:
        raise HTTPException(422, "artifact must be kind:id@version")
    return _ref((kind, aid, version))


def list_reviews(db: Session, workspace_id: str | None, artifact: tuple[str, str, str] | None = None) -> list[ArtifactReview]:
    q = select(ArtifactReview)
    if workspace_id is not None:
        q = q.where(ArtifactReview.workspace_id == workspace_id)
    if artifact is not None:
        kind, aid, version = artifact
        q = q.where(ArtifactReview.artifact_kind == kind, ArtifactReview.artifact_id == aid, ArtifactReview.artifact_version == version)
    return list(db.scalars(q.order_by(ArtifactReview.created_at.desc(), ArtifactReview.id.desc())))


def has_passing_review(session: Session, artifact: ArtifactRef | dict[str, Any] | tuple[str, str, str], workspace_id: str | None = None) -> bool:
    """Whether the latest review of this exact artifact version passed. Pure read; promotion and
    preview Keep call it. A later `block` or `needs-person` supersedes an earlier pass."""
    rows = list_reviews(session, workspace_id, _ref(artifact))
    return bool(rows) and rows[0].verdict == "pass"


def review_dict(row: ArtifactReview) -> dict[str, Any]:
    return {"id": row.id, **row.review}


# ---- Hidden tests (D4) ------------------------------------------------------------------------


def add_hidden_test(db: Session, ctx: RequestContext, body: dict[str, Any]) -> HiddenTest:
    _may_review(ctx)
    try:
        ref = _ref(ArtifactRef.model_validate(body.get("artifact") or {}))
    except ValidationError:
        raise HTTPException(422, "artifact must be {kind, id, version}") from None
    path, content = str(body.get("path") or ""), body.get("content")
    if not path or ".." in path.split("/") or path.startswith("/") or len(path) > 512:
        raise HTTPException(422, "path must be a relative path inside the hidden-tests mount")
    if not isinstance(content, str) or not content or len(content) > 200_000:
        raise HTTPException(422, "content must be a non-empty string (≤200 kB)")
    row = HiddenTest(workspace_id=ctx.workspace_id, artifact_kind=ref[0], artifact_id=ref[1], artifact_version=ref[2], path=path, content=content, created_by=ctx.principal)
    db.add(row)
    db.flush()
    return row


def hidden_tests(db: Session, ctx: RequestContext, artifact: tuple[str, str, str]) -> list[dict[str, Any]]:
    """Reviewer sessions and people only; a builder session gets 403."""
    if ctx.principal.startswith("agent:") and (ctx.principal not in REVIEWER_AGENTS or REVIEW_WRITE not in (ctx.scopes or ())):
        raise HTTPException(403, "hidden tests are out of the builder's reach")
    kind, aid, version = artifact
    rows = db.scalars(select(HiddenTest).where(HiddenTest.workspace_id == ctx.workspace_id, HiddenTest.artifact_kind == kind, HiddenTest.artifact_id == aid, HiddenTest.artifact_version == version).order_by(HiddenTest.created_at))
    return [{"id": r.id, "path": f"hidden-tests/{kind}/{aid}/{version}/{r.path}", "content": r.content, "createdBy": r.created_by} for r in rows]
