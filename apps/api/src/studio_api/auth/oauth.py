"""Outside agents over MCP OAuth (todo17 D12): verify an access token, keep its connection, and
the approvals a person gives for an agent's destroy operations.

A token is a JWT issued by WorkOS AuthKit for the MCP audience (`API_OAUTH_AUDIENCE`, the MCP
server's public URL). It becomes a context with

    principal    `agent:<client name>`         (the actor on every write and audit row)
    on_behalf_of `user:<sub>`                  (the person who signed the agent in)
    scopes       the D12 scopes it was granted + their kernel scopes (`auth/scopes.py`)
    auth         `oauth`; `token_hash` is `conn:<connection id>` (stable across token refreshes)

Each use upserts the person's `agent_connections` row for that client (last use at most once a
minute); a connection revoked in Settings › Connected agents makes every token issued before the
revocation answer 401 with `WWW-Authenticate`.

dev mode (no WorkOS): tokens are HS256, signed with `API_SECRET_KEY`, issuer `dev`, minted by
`POST /api/v1/dev/oauth/tokens` (trusted dev headers only) so tests and the local MCP server can
sign in without AuthKit. With `API_OAUTH_ISSUER` set, RS256 tokens from that issuer's JWKS are
accepted too (WorkOS Emulate).
"""

from __future__ import annotations

import hashlib
import re
import time
import uuid
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Any

import jwt
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from jwt import PyJWKClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import AgentApproval, AgentConnection, ApprovalUsed, now
from . import scopes as sc

DEV_ISSUER = "dev"
DEV_AUDIENCE = "mcp-dev"
DEV_TTL_S = 3600
MARKER_SCOPE = "oauth"
LAST_USED_EVERY_S = 60.0
APPROVAL_PENDING_TTL = timedelta(hours=1)
APPROVAL_USE_TTL = timedelta(minutes=10)


def looks_like_jwt(token: str) -> bool:
    return token.count(".") == 2 and token.startswith("ey")


def audience() -> str | None:
    s = settings()
    return s.oauth_audience or (None if s.workos else DEV_AUDIENCE)


def _unauthorized(description: str) -> HTTPException:
    return HTTPException(401, f"OAuth token {description}", headers={"WWW-Authenticate": sc.www_authenticate("invalid_token", description=description)})


@lru_cache(maxsize=4)
def _jwks(url: str) -> PyJWKClient:
    return PyJWKClient(url, lifespan=300, timeout=5)


def jwks_url() -> str | None:
    s = settings()
    if s.oauth_jwks_url:
        return s.oauth_jwks_url
    return f"{s.oauth_issuer.rstrip('/')}/oauth2/jwks" if s.oauth_issuer and s.oauth_issuer != DEV_ISSUER else None


def signing_key(token: str) -> Any:
    """The RS256 key for a token (tests replace this)."""
    url = jwks_url()
    if url is None:
        raise jwt.InvalidTokenError("no JWKS configured")
    return _jwks(url).get_signing_key_from_jwt(token).key


def decode(token: str) -> dict[str, Any]:
    """Verified claims. Raises `HTTPException` 401 (with `WWW-Authenticate`) or 503."""
    s = settings()
    aud = audience()
    if aud is None:
        raise _unauthorized("not accepted here (no OAuth audience configured)")
    try:
        alg = jwt.get_unverified_header(token).get("alg")
    except jwt.InvalidTokenError:
        raise _unauthorized("is malformed") from None
    try:
        if alg == "HS256" and not s.workos:
            return jwt.decode(token, s.secret_key, algorithms=["HS256"], audience=aud, issuer=DEV_ISSUER, leeway=5, options={"require": ["exp", "sub", "aud"]})
        if alg != "RS256" or not s.oauth_issuer:
            raise _unauthorized("is not from a trusted issuer")
        return jwt.decode(token, signing_key(token), algorithms=["RS256"], audience=aud, issuer=s.oauth_issuer, leeway=5, options={"require": ["exp", "sub", "aud"]})
    except jwt.ExpiredSignatureError:
        raise _unauthorized("has expired") from None
    except jwt.PyJWKClientError:
        raise HTTPException(503, "can't check the OAuth token right now; try again", headers={"Retry-After": "2"}) from None
    except jwt.InvalidTokenError as e:
        raise _unauthorized(f"is invalid ({type(e).__name__})") from None


def granted(claims: dict[str, Any]) -> tuple[str, ...]:
    raw = claims.get("scope") or claims.get("scp") or claims.get("permissions") or ()
    names = raw.split() if isinstance(raw, str) else [str(x) for x in raw]
    return tuple(s for s in sc.SCOPES if s in names)  # only D12 scopes; never an org permission


def _clean_name(name: str) -> str:
    return re.sub(r"[\x00-\x1f\x7f]", "", name).strip()[:64] or "agent"


def _conn_id(person: str, client_id: str, generation: int) -> str:
    return "agc_" + hashlib.sha256(f"{person}\0{client_id}\0{generation}".encode()).hexdigest()[:24]


def _aware(d: datetime | None) -> datetime | None:
    return None if d is None else (d if d.tzinfo else d.replace(tzinfo=UTC))


def connection_for(db: Session, *, person: str, client_id: str, client_name: str, scopes: tuple[str, ...], org_id: str | None, issued_at: datetime) -> AgentConnection:
    """The live connection for (person, client), created on first use. 401 when the token was
    issued before the client was revoked."""
    rows = list(db.scalars(select(AgentConnection).where(AgentConnection.person_id == person, AgentConnection.client_id == client_id)))
    live = next((r for r in rows if r.revoked_at is None), None)
    if live is None:
        last_revoked = max((_aware(r.revoked_at) for r in rows if r.revoked_at is not None), default=None)
        if last_revoked is not None and issued_at <= last_revoked:
            raise _unauthorized("was revoked")
        from ..dbutil import insert_ignore

        cid = _conn_id(person, client_id, len(rows))
        insert_ignore(db, AgentConnection, [{"id": cid, "org_id": org_id, "person_id": person, "client_name": client_name, "client_id": client_id, "scopes": list(scopes), "created_at": now(), "last_used_at": None, "revoked_at": None}])
        live = db.get(AgentConnection, cid)
        assert live is not None
        if live.revoked_at is not None:
            raise _unauthorized("was revoked")
    t = datetime.now(UTC)
    last = _aware(live.last_used_at)
    if last is None or (t - last).total_seconds() >= LAST_USED_EVERY_S or set(live.scopes or ()) != set(scopes) or live.client_name != client_name:
        live.last_used_at = t
        live.scopes = list(scopes)
        live.client_name = client_name
        db.flush()
    return live


def resolve(request: Request, db: Session, token: str, correlation: str, idem: str | None) -> Any:
    """The context for an outside agent's OAuth access token."""
    from ..context import AUTH_OAUTH, RequestContext, client_ip, ensure_workspace, scope_of

    claims = decode(token)
    sub = str(claims["sub"])
    person = sub if sub.startswith("user:") else f"user:{sub}"
    client_id = str(claims.get("client_id") or claims.get("azp") or "unknown")
    client_name = _clean_name(str(claims.get("client_name") or client_id))
    org_id = None
    if claims.get("org_id"):
        if settings().workos:
            from .bootstrap import org_for_workos_id

            org_id = org_for_workos_id(db, str(claims["org_id"]))
        else:
            org_id = str(claims["org_id"])
    granted_scopes = granted(claims)
    iat = claims.get("iat")
    issued = datetime.fromtimestamp(iat, UTC) if isinstance(iat, int | float) else datetime.now(UTC)
    conn = connection_for(db, person=person, client_id=client_id, client_name=client_name, scopes=granted_scopes, org_id=org_id, issued_at=issued)
    workspace, task = scope_of(db, request.headers.get("X-Workspace-Id") or "default")
    ensure_workspace(db, workspace)
    from ..kernel import agent_scope

    principal = f"agent:{client_name}"
    agent_scope.check(request, principal)
    return RequestContext(
        workspace, principal, correlation, idem, scopes=(MARKER_SCOPE, *granted_scopes, *sc.kernel_for(granted_scopes)), task_id=task,
        on_behalf_of=person, org_id=org_id, permissions=(), auth=AUTH_OAUTH,
        client_ip=client_ip(request), user_agent=request.headers.get("User-Agent"),
        approval_id=request.headers.get("X-Approval-Id") or None, token_hash=f"conn:{conn.id}",
        turn_id=(request.headers.get("X-Turn-Id") or "")[:64] or None,
    )


def connection_id(ctx: Any) -> str | None:
    th = getattr(ctx, "token_hash", None) or ""
    return th[5:] if th.startswith("conn:") else None


def mint_dev(*, person: str, client_id: str, client_name: str, scopes: list[str], org_id: str | None = None, ttl_s: int = DEV_TTL_S) -> str:
    """dev mode: an HS256 access token shaped like AuthKit's (tests, the local MCP server)."""
    t = int(time.time())
    claims = {"iss": DEV_ISSUER, "aud": audience() or DEV_AUDIENCE, "sub": person.removeprefix("user:"), "client_id": client_id, "client_name": client_name, "scope": " ".join(scopes), "iat": t, "exp": t + ttl_s, "jti": uuid.uuid4().hex}
    if org_id:
        claims["org_id"] = org_id
    return jwt.encode(claims, settings().secret_key, algorithm="HS256")


# ---- Connected agents (Settings › Connected agents) ----------------------------------------------


def _iso(d: datetime | None) -> str | None:
    d = _aware(d)
    return None if d is None else d.astimezone(UTC).isoformat().replace("+00:00", "Z")


def list_connections(db: Session, person: str) -> list[dict[str, Any]]:
    rows = db.scalars(select(AgentConnection).where(AgentConnection.person_id == person, AgentConnection.revoked_at.is_(None)).order_by(AgentConnection.created_at.desc()))
    return [{"id": r.id, "clientName": r.client_name, "clientId": r.client_id, "scopes": list(r.scopes or []), "createdAt": _iso(r.created_at), "lastUsedAt": _iso(r.last_used_at)} for r in rows]


def revoke(db: Session, person: str, conn_id: str) -> AgentConnection:
    row = db.get(AgentConnection, conn_id)
    if row is None or row.person_id != person or row.revoked_at is not None:
        raise HTTPException(404, "no such connected agent")
    row.revoked_at = datetime.now(UTC)
    db.flush()
    return row


# ---- Destroy approvals (202 + a link for the person) --------------------------------------------


class ApprovalRequired(Exception):
    """Raised by `approvals.verify` for an outside agent's destroy without an approval: the app
    answers 202 and records a pending approval (outside the failed request's transaction)."""

    def __init__(self, *, connection_id: str, person: str, project_id: str, operation: str, targets: list[str]):
        super().__init__("a person must approve this")
        self.connection_id, self.person, self.project_id, self.operation, self.targets = connection_id, person, project_id, operation, targets


def approval_url(approval_id: str) -> str:
    base = (settings().public_url or "").rstrip("/")
    return f"{base}/approvals/{approval_id}"


def approval_dict(r: AgentApproval) -> dict[str, Any]:
    return {"id": r.id, "state": r.state, "operation": r.operation, "projectId": r.project_id, "targets": list(r.targets or []), "connectionId": r.connection_id, "url": approval_url(r.id), "createdAt": _iso(r.created_at), "expiresAt": _iso(r.expires_at), "decidedAt": _iso(r.decided_at)}


def record_pending(e: ApprovalRequired) -> dict[str, Any]:
    from ..db import session_scope

    t = datetime.now(UTC)
    with session_scope() as db:
        row = AgentApproval(id="apr_" + uuid.uuid4().hex[:24], connection_id=e.connection_id, person_id=e.person, project_id=e.project_id, operation=e.operation, targets=e.targets, state="pending", created_at=t, expires_at=t + APPROVAL_PENDING_TTL)
        db.add(row)
        db.flush()
        return approval_dict(row)


def approval_required_response(e: ApprovalRequired) -> JSONResponse:
    a = record_pending(e)
    return JSONResponse(
        {"status": "pending", "detail": "Deleting forever needs a person's approval. Ask them to open the link, then retry with X-Approval-Id.", "approval": a},
        status_code=202,
        headers={"Location": f"/api/v1/approvals/{a['id']}"},
    )


def verify_destroy(db: Session, ctx: Any, *, operation: str, project_id: str, targets: list[str]) -> None:
    """An outside agent's destroy: the `project:destroy` scope, then an approved, unused, unexpired
    approval for exactly this (operation, project, targets) given to this connection; without
    `X-Approval-Id`, `ApprovalRequired` (202)."""
    sc.require(ctx, sc.DESTROY, "Deleting forever")
    conn = connection_id(ctx)
    if not ctx.approval_id:
        raise ApprovalRequired(connection_id=conn or "", person=ctx.on_behalf_of or "", project_id=project_id, operation=operation, targets=sorted(set(targets)))

    def deny(why: str) -> HTTPException:
        return HTTPException(403, f"Deleting forever needs a person's approval: {why}")

    row = db.get(AgentApproval, ctx.approval_id)
    if row is None or row.connection_id != conn:
        raise deny("no such approval for this agent")
    if row.state != "approved":
        raise deny(f"the approval is {row.state}")
    if row.operation != operation or row.project_id != project_id or not set(targets) <= set(row.targets or []):
        raise deny("it was given for something else")
    decided = _aware(row.decided_at) or datetime.now(UTC)
    if datetime.now(UTC) > decided + APPROVAL_USE_TTL:
        raise deny("it has expired; ask again")
    if db.get(ApprovalUsed, row.id) is not None:
        raise deny("it was already used; ask again")
    db.add(ApprovalUsed(approval_id=row.id, person=row.person_id, operation=operation, project_id=project_id, expires_at=decided + APPROVAL_USE_TTL))
    db.flush()


def decide(db: Session, ctx: Any, approval_id: str, approve: bool) -> dict[str, Any]:
    """A person (never a token) approves or denies their own agent's request."""
    if ctx.scopes or not ctx.principal.startswith("user:"):
        raise HTTPException(403, "only the person can approve this")
    row = db.get(AgentApproval, approval_id)
    if row is None or row.person_id != ctx.principal:
        raise HTTPException(404, "no such approval")
    if row.state != "pending":
        raise HTTPException(409, f"this approval is already {row.state}")
    if datetime.now(UTC) > (_aware(row.expires_at) or datetime.now(UTC)):
        raise HTTPException(410, "this request has expired; ask the agent to try again")
    row.state = "approved" if approve else "denied"
    row.decided_at = datetime.now(UTC)
    db.flush()
    from .audit import audit

    audit(db, ctx, "agent.destroy_approved" if approve else "agent.destroy_denied", target=row.id, detail={"operation": row.operation, "projectId": row.project_id, "connectionId": row.connection_id})
    return approval_dict(row)


def get_approval(db: Session, ctx: Any, approval_id: str) -> dict[str, Any]:
    """The person it was asked of, or the agent connection that asked."""
    row = db.get(AgentApproval, approval_id)
    mine = row is not None and ((not ctx.scopes and ctx.principal == row.person_id) or connection_id(ctx) == row.connection_id)
    if row is None or not mine:
        raise HTTPException(404, "no such approval")
    return approval_dict(row)


def install(app: Any) -> None:
    async def _h(_req: Any, exc: ApprovalRequired) -> JSONResponse:
        return approval_required_response(exc)

    app.add_exception_handler(ApprovalRequired, _h)
