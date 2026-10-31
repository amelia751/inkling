"""Request context (docs/plugins.md §6): workspace, principal, correlation id and idempotency key.

Derived from the session token (or, in dev, from trusted headers), never from a request
body, so a plugin or agent can't claim another tenant by putting an id in its input.
"""

from __future__ import annotations

import hashlib
import secrets as pysecrets
import uuid
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session
from studio_observability import request_id as obs_request_id

from .config import settings
from .db import get_session
from .models import SessionDelegation, SessionToken, Workspace

WORKSPACE_HEADER = "X-Workspace-Id"
# Dev only (dev_trust_headers): act as another human user, e.g. two reviewers in one browser
# session or e2e test. Only `user:` principals; agents always come with a session token.
PRINCIPAL_HEADER = "X-Dev-Principal"


@dataclass(frozen=True)
class RequestContext:
    workspace_id: str
    principal: str
    correlation_id: str
    idempotency_key: str | None = None
    scopes: tuple[str, ...] = field(default_factory=tuple)
    profile: str | None = None
    # Who an agent session acts for: the user who minted its token (POST /v1/sessions).
    on_behalf_of: str | None = None
    # The task whose environment and annotation document a request reads (todo6 D3). Seeds and
    # older workspaces have one task with the workspace's id, hence the default.
    task_id: str | None = None

    @property
    def task(self) -> str:
        return self.task_id or self.workspace_id

    def for_scope(self, workspace_id: str, task_id: str | None) -> RequestContext:
        return replace(self, workspace_id=workspace_id, task_id=task_id)

    def allows(self, scope: str) -> bool:
        """Session tokens carry scopes; dev header identities are full users."""
        return not self.scopes or scope in self.scopes or "*" in self.scopes


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def ensure_workspace(db: Session, workspace_id: str, name: str | None = None) -> Workspace:
    """Get or create, safe against concurrent first requests (insert … on conflict do nothing,
    then select), so two replicas never race into a UNIQUE error."""
    ws = db.get(Workspace, workspace_id)
    if ws is None:
        from .dbutil import insert_ignore

        insert_ignore(db, Workspace, [{"id": workspace_id, "name": name or workspace_id, "created_at": datetime.now(UTC)}])
        ws = db.get(Workspace, workspace_id)
        assert ws is not None
    return ws


def scope_of(db: Session, id_: str) -> tuple[str, str]:
    """(workspace, task) for an id the Studio uses: a task id resolves to its project's
    workspace; anything else (a seed, a legacy workspace) is its own workspace and task."""
    from .models import TaskRow

    task = db.get(TaskRow, id_)
    return (task.project_id, task.id) if task is not None else (id_, id_)


def issue_session(db: Session, principal: str, workspace_id: str, scopes: list[str], ttl_s: int = 3600, profile: str | None = None, on_behalf_of: str | None = None) -> str:
    """A session-scoped token (agent run, worker). Returned once; only its hash is stored."""
    ensure_workspace(db, workspace_id)
    token = pysecrets.token_urlsafe(32)
    db.add(SessionToken(token_hash=hash_token(token), principal=principal, workspace_id=workspace_id, scopes=scopes, profile=profile, expires_at=datetime.now(UTC) + timedelta(seconds=ttl_s)))
    if on_behalf_of:
        db.add(SessionDelegation(token_hash=hash_token(token), on_behalf_of=on_behalf_of))
    db.flush()
    return token


def resolve_context(request: Request, db: Session) -> RequestContext:
    # One id per request: the middleware's (X-Request-Id, else X-Correlation-Id, else new).
    correlation = obs_request_id() or request.headers.get("X-Correlation-Id") or uuid.uuid4().hex
    idem = request.headers.get("Idempotency-Key")
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        row = db.get(SessionToken, hash_token(auth[7:].strip()))
        if row is None or row.expires_at.replace(tzinfo=row.expires_at.tzinfo or UTC) < datetime.now(UTC):
            raise HTTPException(401, "invalid or expired session token")
        # A token is bound to one workspace; a header can't move it elsewhere (a task of that
        # workspace's project is fine: it only picks the document).
        asked = request.headers.get(WORKSPACE_HEADER)
        task = None
        if asked:
            ws, task = scope_of(db, asked)
            if ws != row.workspace_id:
                raise HTTPException(403, "session token is bound to another workspace")
        from .kernel import agent_scope

        agent_scope.check(request, row.principal)
        delegation = db.get(SessionDelegation, row.token_hash)
        return RequestContext(row.workspace_id, row.principal, correlation, idem, tuple(row.scopes or ()), row.profile, delegation.on_behalf_of if delegation else None, task)
    if not settings().dev_trust_headers:
        raise HTTPException(401, "session token required")
    workspace, task = scope_of(db, request.headers.get(WORKSPACE_HEADER) or "default")
    ensure_workspace(db, workspace)
    principal = request.headers.get(PRINCIPAL_HEADER) or settings().dev_principal
    if not principal.startswith("user:") or len(principal) > 128:
        raise HTTPException(400, f"{PRINCIPAL_HEADER} must name a user: principal")
    return RequestContext(workspace, principal, correlation, idem, task_id=task)


def get_context(request: Request, db: Session = Depends(get_session)) -> RequestContext:
    ctx = resolve_context(request, db)
    request.state.ctx = ctx
    return ctx
