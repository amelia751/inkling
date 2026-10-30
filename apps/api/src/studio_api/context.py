"""Request context (docs/plugins.md §6): workspace, principal, correlation id and idempotency key.

Derived from the session token (or, in dev, from trusted headers), never from a request
body, so a plugin or agent can't claim another tenant by putting an id in its input.
"""

from __future__ import annotations

import hashlib
import secrets as pysecrets
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from .config import settings
from .db import get_session
from .models import SessionToken, Workspace

WORKSPACE_HEADER = "X-Workspace-Id"


@dataclass(frozen=True)
class RequestContext:
    workspace_id: str
    principal: str
    correlation_id: str
    idempotency_key: str | None = None
    scopes: tuple[str, ...] = field(default_factory=tuple)
    profile: str | None = None

    def allows(self, scope: str) -> bool:
        """Session tokens carry scopes; dev header identities are full users."""
        return not self.scopes or scope in self.scopes or "*" in self.scopes


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def ensure_workspace(db: Session, workspace_id: str) -> Workspace:
    ws = db.get(Workspace, workspace_id)
    if ws is None:
        ws = Workspace(id=workspace_id, name=workspace_id)
        db.add(ws)
        db.flush()
    return ws


def issue_session(db: Session, principal: str, workspace_id: str, scopes: list[str], ttl_s: int = 3600, profile: str | None = None) -> str:
    """A session-scoped token (agent run, worker). Returned once; only its hash is stored."""
    ensure_workspace(db, workspace_id)
    token = pysecrets.token_urlsafe(32)
    db.add(SessionToken(token_hash=hash_token(token), principal=principal, workspace_id=workspace_id, scopes=scopes, profile=profile, expires_at=datetime.now(UTC) + timedelta(seconds=ttl_s)))
    db.flush()
    return token


def resolve_context(request: Request, db: Session) -> RequestContext:
    correlation = request.headers.get("X-Correlation-Id") or uuid.uuid4().hex
    idem = request.headers.get("Idempotency-Key")
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        row = db.get(SessionToken, hash_token(auth[7:].strip()))
        if row is None or row.expires_at.replace(tzinfo=row.expires_at.tzinfo or UTC) < datetime.now(UTC):
            raise HTTPException(401, "invalid or expired session token")
        # A token is bound to one workspace; a header can't move it elsewhere.
        asked = request.headers.get(WORKSPACE_HEADER)
        if asked and asked != row.workspace_id:
            raise HTTPException(403, "session token is bound to another workspace")
        return RequestContext(row.workspace_id, row.principal, correlation, idem, tuple(row.scopes or ()), row.profile)
    if not settings().dev_trust_headers:
        raise HTTPException(401, "session token required")
    workspace = request.headers.get(WORKSPACE_HEADER) or "default"
    ensure_workspace(db, workspace)
    return RequestContext(workspace, settings().dev_principal, correlation, idem)


def get_context(request: Request, db: Session = Depends(get_session)) -> RequestContext:
    ctx = resolve_context(request, db)
    request.state.ctx = ctx
    return ctx
