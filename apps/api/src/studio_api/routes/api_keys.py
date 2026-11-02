"""Organization API keys (todo9 Phase 8; contract in packages/contracts/src/accounts.ts).

    GET    /api/v1/org/api-keys        → {keys: ApiKey[]}                         (apikeys:manage)
    POST   /api/v1/org/api-keys {name, expiresInDays, scopes} → {key, secret}     (apikeys:manage)
    DELETE /api/v1/org/api-keys/{id}   → 204                                      (apikeys:manage)

Only people manage keys (an agent token or a key can't mint keys). In workos mode creating a key
needs a recent sign-in (`auth_time` within `STEP_UP_S`), else 403
`{detail: "step_up_required", loginUrl}` and the web sends the person through that URL.
The secret is in the POST response only: never logged, never stored (dev mode keeps its hash).
"""

from __future__ import annotations

import time
from typing import Any
from urllib.parse import urlencode

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from ..auth import api_keys, audit, current_org, require_permission
from ..auth.permissions import APIKEYS_MANAGE
from ..config import settings
from ..context import AUTH_COOKIE, RequestContext
from ..db import get_session

router = APIRouter(prefix="/api/v1/org/api-keys", tags=["org"])

STEP_UP_S = 600
STEP_UP_RETURN_TO = "/organization/api-keys"


def step_up_login_url() -> str:
    return "/api/auth/login?" + urlencode({"max_age": STEP_UP_S, "return_to": STEP_UP_RETURN_TO})


def _needs_step_up(request: Request, ctx: RequestContext) -> bool:
    if not settings().workos or ctx.auth != AUTH_COOKIE:
        return False
    s = getattr(request.state, "auth_session", None)
    auth_time = (s.claims if s is not None else {}).get("auth_time")
    if not isinstance(auth_time, (int, float)):
        return True
    return time.time() - auth_time > STEP_UP_S


def _org(db: Session, ctx: RequestContext) -> str:
    org = current_org(db, ctx)
    if org is None:
        raise HTTPException(404, "no organization")
    return org


def _people_only(ctx: RequestContext) -> None:
    if ctx.scopes:
        raise HTTPException(403, "only people manage API keys")


@router.get("")
def list_keys(ctx: RequestContext = Depends(require_permission(APIKEYS_MANAGE)), db: Session = Depends(get_session)):
    return {"keys": api_keys.list_keys(db, _org(db, ctx))}


@router.post("")
def create_key(request: Request, body: dict = Body(...), ctx: RequestContext = Depends(require_permission(APIKEYS_MANAGE)), db: Session = Depends(get_session)) -> Any:
    _people_only(ctx)
    name = str(body.get("name") or "").strip()
    if not name or len(name) > 256:
        raise HTTPException(422, "name: 1 to 256 characters")
    scopes = api_keys.check_scopes(body.get("scopes"))
    expires_at = api_keys.check_expiry(body.get("expiresInDays"))
    if _needs_step_up(request, ctx):
        return JSONResponse({"detail": "step_up_required", "loginUrl": step_up_login_url()}, status_code=403)
    org = _org(db, ctx)
    key, secret = api_keys.create_key(db, ctx, org, name, scopes, expires_at)
    audit(db, ctx, api_keys.CREATED, target=key["id"], org_id=org, detail={"name": name, "scopes": scopes})
    return {"key": key, "secret": secret}


@router.delete("/{key_id}", status_code=204)
def revoke_key(key_id: str, ctx: RequestContext = Depends(require_permission(APIKEYS_MANAGE)), db: Session = Depends(get_session)) -> Response:
    _people_only(ctx)
    org = _org(db, ctx)
    api_keys.revoke_key(db, org, key_id)
    audit(db, ctx, api_keys.REVOKED, target=key_id, org_id=org)
    return Response(status_code=204)
