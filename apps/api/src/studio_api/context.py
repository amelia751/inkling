"""Request context (docs/plugins.md §6): workspace, principal, organization, permissions,
correlation id and idempotency key.

Derived from credentials, never from a request body, so a plugin or agent can't claim another
tenant by putting an id in its input. Resolution order (todo9 Phase 3):

1. `Authorization: Bearer <kernel session token>` (agent runs, workers, plugins);
2. `Authorization: Bearer <organization API key>` (`_resolve_api_key`, todo9 Phase 8);
3. the WorkOS session cookie (`auth_mode=workos`; unsealed and refreshed by
   `auth.session.session_middleware`, which leaves the result on `request.state`);
4. trusted dev headers (`auth_mode=dev` with `dev_trust_headers`): `X-Dev-Principal`.
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
# How a context was authenticated (`RequestContext.auth`).
AUTH_DEV, AUTH_COOKIE, AUTH_TOKEN, AUTH_API_KEY = "dev", "cookie", "token", "apikey"
# A delegation minted by a dev identity holds every permission.
ALL = "*"


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
    # todo11 D2.1: for an agent token, the task the person had open when minting it.
    opened_task: str | None = None
    # todo9: the organization the request acts in (our id; None for a dev identity, which sees
    # every organization it belongs to), the person's organization permissions, and how the
    # request authenticated (AUTH_*). `session_id` is the WorkOS session (`sid`), if any.
    org_id: str | None = None
    permissions: tuple[str, ...] = field(default_factory=tuple)
    auth: str = AUTH_DEV
    session_id: str | None = None
    client_ip: str | None = None
    user_agent: str | None = None
    # todo16 D8: the approval the person gave in chat for a *destroy* operation (X-Approval-Id).
    approval_id: str | None = None

    @property
    def task(self) -> str:
        return self.task_id or self.workspace_id

    def for_scope(self, workspace_id: str, task_id: str | None) -> RequestContext:
        return replace(self, workspace_id=workspace_id, task_id=task_id)

    @property
    def workspace_bound(self) -> bool:
        """A session token is bound to the one workspace it was minted for; an organization API
        key (also scoped) reaches any project of its organization (`projects.require_project`)."""
        return bool(self.scopes) and self.auth != AUTH_API_KEY

    def allows(self, scope: str) -> bool:
        """Session tokens carry scopes; dev header identities are full users."""
        return not self.scopes or scope in self.scopes or "*" in self.scopes

    def can(self, permission: str) -> bool:
        """An organization permission (`members:manage`, …; auth/permissions.py). A dev identity
        may do anything; a signed-in person what their access token grants; an agent token what
        the person who minted it may do AND what its own scopes allow."""
        if self.auth == AUTH_DEV:
            return True
        if ALL not in self.permissions and permission not in self.permissions:
            return False
        return self.allows(permission) if self.scopes else True


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


def issue_session(db: Session, principal: str, workspace_id: str, scopes: list[str], ttl_s: int = 3600, profile: str | None = None, on_behalf_of: str | None = None, task_id: str | None = None, minter: RequestContext | None = None) -> str:
    """A session-scoped token (agent run, worker). Returned once; only its hash is stored.
    `minter` (the person's context) records their organization and permissions on the
    delegation, so the agent can never do more than they could (`RequestContext.can`)."""
    ensure_workspace(db, workspace_id)
    token = pysecrets.token_urlsafe(32)
    db.add(SessionToken(token_hash=hash_token(token), principal=principal, workspace_id=workspace_id, scopes=scopes, profile=profile, expires_at=datetime.now(UTC) + timedelta(seconds=ttl_s)))
    if on_behalf_of:
        perms = None if minter is None else ([ALL] if minter.auth == AUTH_DEV else list(minter.permissions))
        db.add(SessionDelegation(token_hash=hash_token(token), on_behalf_of=on_behalf_of, task_id=task_id, org_id=minter.org_id if minter else None, permissions=perms))
    db.flush()
    return token


def client_ip(request: Request) -> str | None:
    """The browser's address: the first `X-Forwarded-For` hop (nginx and the ingress set it),
    else the socket peer."""
    first = request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
    ip = first or (request.client.host if request.client else "")
    return ip[:64] or None


def _resolve_api_key(request: Request, db: Session, token: str, correlation: str, idem: str | None) -> RequestContext | None:
    """todo9 Phase 8: a Bearer that isn't a kernel session token may be an organization API key
    (principal `apikey:<id>`, org and permissions from the key; `auth/api_keys.py`). None means
    "not an API key", and the request gets the usual 401."""
    from .auth import api_keys

    return api_keys.resolve(request, db, token, correlation, idem)


def _session_token_context(request: Request, db: Session, row: SessionToken, correlation: str, idem: str | None) -> RequestContext:
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
    perms: tuple[str, ...] = ()
    if delegation is not None:
        # Delegations minted before todo9 carry no permissions: full in dev mode, none in workos mode.
        perms = tuple(delegation.permissions) if delegation.permissions is not None else ((ALL,) if not settings().workos else ())
    return RequestContext(
        row.workspace_id, row.principal, correlation, idem, tuple(row.scopes or ()), row.profile,
        delegation.on_behalf_of if delegation else None, task, delegation.task_id if delegation else None,
        org_id=delegation.org_id if delegation else None, permissions=perms, auth=AUTH_TOKEN,
        client_ip=client_ip(request), user_agent=request.headers.get("User-Agent"),
        approval_id=request.headers.get("X-Approval-Id") or None,
    )


def resolve_context(request: Request, db: Session) -> RequestContext:
    # One id per request: the middleware's (X-Request-Id, else X-Correlation-Id, else new).
    correlation = obs_request_id() or request.headers.get("X-Correlation-Id") or uuid.uuid4().hex
    idem = request.headers.get("Idempotency-Key")
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        token = auth[7:].strip()
        row = db.get(SessionToken, hash_token(token))
        if row is not None and row.expires_at.replace(tzinfo=row.expires_at.tzinfo or UTC) >= datetime.now(UTC):
            return _session_token_context(request, db, row, correlation, idem)
        if row is None and (key_ctx := _resolve_api_key(request, db, token, correlation, idem)) is not None:
            return key_ctx
        raise HTTPException(401, "invalid or expired session token or API key")
    workspace_header = request.headers.get(WORKSPACE_HEADER) or "default"
    signed_in = getattr(request.state, "auth_session", None)
    if signed_in is not None:
        from .auth import bootstrap

        workspace, task = scope_of(db, workspace_header)
        ensure_workspace(db, workspace)
        org_id = bootstrap.org_for_workos_id(db, signed_in.org_id) if signed_in.org_id else None
        return RequestContext(
            workspace, signed_in.principal, correlation, idem, task_id=task, org_id=org_id,
            permissions=tuple(signed_in.permissions), auth=AUTH_COOKIE, session_id=signed_in.session_id,
            client_ip=client_ip(request), user_agent=request.headers.get("User-Agent"),
        )
    if settings().workos or not settings().dev_trust_headers:
        raise HTTPException(401, "sign in required" if settings().workos else "session token required")
    workspace, task = scope_of(db, workspace_header)
    ensure_workspace(db, workspace)
    principal = request.headers.get(PRINCIPAL_HEADER) or settings().dev_principal
    if not principal.startswith("user:") or len(principal) > 128:
        raise HTTPException(400, f"{PRINCIPAL_HEADER} must name a user: principal")
    return RequestContext(workspace, principal, correlation, idem, task_id=task, auth=AUTH_DEV, client_ip=client_ip(request), user_agent=request.headers.get("User-Agent"))


def get_context(request: Request, db: Session = Depends(get_session)) -> RequestContext:
    ctx = resolve_context(request, db)
    request.state.ctx = ctx
    return ctx
