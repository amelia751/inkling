"""Outside agents (todo17 D12): Settings › Connected agents, destroy approvals, dev tokens.

    GET    /api/v1/me/connected-agents          → {agents: [{id, clientName, clientId, scopes, createdAt, lastUsedAt}]}
    DELETE /api/v1/me/connected-agents/{id}     → 204; that agent's tokens answer 401 from now on
    GET    /api/v1/approvals/{id}               → Approval (the person, or the agent that asked)
    POST   /api/v1/approvals/{id}/approve       → Approval (the person only)
    POST   /api/v1/approvals/{id}/deny          → Approval (the person only)
    POST   /api/v1/dev/oauth/tokens {clientName, clientId?, scopes, orgId?} → {accessToken, tokenType, expiresIn}
                                                  dev mode (trusted headers) only: an AuthKit-shaped token for the caller

Connected agents are people's business: tokens (agents, keys) get 403 here.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from ..auth import oauth
from ..auth import scopes as sc
from ..auth.audit import audit
from ..config import settings
from ..context import AUTH_DEV, RequestContext, get_context
from ..db import get_session

router = APIRouter(prefix="/api/v1")


def _person(ctx: RequestContext) -> str:
    if ctx.scopes or not ctx.principal.startswith("user:"):
        raise HTTPException(403, "only people manage connected agents")
    return ctx.principal


@router.get("/me/connected-agents")
def list_connected(ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return {"agents": oauth.list_connections(db, _person(ctx))}


@router.delete("/me/connected-agents/{conn_id}", status_code=204)
def revoke_connected(conn_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    row = oauth.revoke(db, _person(ctx), conn_id)
    audit(db, ctx, "agent.revoked", target=row.id, detail={"clientName": row.client_name})
    return Response(status_code=204)


@router.get("/approvals/{approval_id}")
def get_approval(approval_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return oauth.get_approval(db, ctx, approval_id)


@router.post("/approvals/{approval_id}/approve")
def approve(approval_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return oauth.decide(db, ctx, approval_id, True)


@router.post("/approvals/{approval_id}/deny")
def deny(approval_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return oauth.decide(db, ctx, approval_id, False)


@router.post("/dev/oauth/tokens")
def mint_dev_token(body: dict[str, Any] = Body(...), ctx: RequestContext = Depends(get_context)):
    if settings().workos or not settings().dev_trust_headers or ctx.auth != AUTH_DEV:
        raise HTTPException(404, "not found")
    name = body.get("clientName")
    scopes = body.get("scopes")
    if not isinstance(name, str) or not name.strip():
        raise HTTPException(422, "clientName is required")
    if not isinstance(scopes, list) or not all(isinstance(s, str) and s in sc.SCOPES for s in scopes):
        raise HTTPException(422, f"scopes: any of {', '.join(sc.SCOPES)}")
    token = oauth.mint_dev(person=ctx.principal, client_id=str(body.get("clientId") or f"dev-{name.strip().lower().replace(' ', '-')}"), client_name=name.strip(), scopes=scopes, org_id=body.get("orgId") or None)
    return {"accessToken": token, "tokenType": "Bearer", "expiresIn": oauth.DEV_TTL_S, "audience": oauth.audience()}
