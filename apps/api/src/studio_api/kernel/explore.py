"""Explore (todo6 Phase 5): proposals built from inspected facts, and what confirming one does."""

from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..context import RequestContext
from ..models import ProjectRow, Proposal


def recompute_relationship(db: Session, ctx: RequestContext, p: ProjectRow, pr: Proposal, body: dict) -> Proposal:
    raise HTTPException(501, "relationship matching arrives with inspection (todo6 Phase 5)")
