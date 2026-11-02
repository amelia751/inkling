"""Signed destroy approvals (todo16 D8).

An assistant (delegated session token) may delete forever only with the person's approval from
chat. The agent's ApprovalBroker records the click; the agent then signs a short-lived token

    v1.<base64url(json claims)>.<base64url(HMAC-SHA256(secret, "v1." + claims part))>

with claims `{aid, dlg, sub?, op, pid, tgt, exp}`: the approval id, the sha256 of the delegated
kernel token it was given in (so the person it was issued for is the delegation's
`on_behalf_of`), optionally that person's id, the operation id from the catalogue, the project,
the target ids and the expiry (unix seconds, at most ten minutes ahead). It arrives as
`X-Approval-Id`. `verify` checks all of it and records the id in `approvals_used`: each
approval is good once. People (no scopes) need none.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from collections.abc import Iterable
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..config import settings
from ..context import RequestContext
from ..models import ApprovalUsed

VERSION = "v1"
MAX_TTL_S = 600
SKEW_S = 30


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sign(claims: dict, secret: str | None = None) -> str:
    """The agent's encoding (tests and tools use it; the agent has its own in TypeScript)."""
    body = _b64(json.dumps(claims, separators=(",", ":"), sort_keys=True).encode())
    mac = hmac.new((secret or settings().approval_secret).encode(), f"{VERSION}.{body}".encode(), hashlib.sha256).digest()
    return f"{VERSION}.{body}.{_b64(mac)}"


def _deny(why: str) -> HTTPException:
    return HTTPException(403, f"Deleting forever needs the person's approval in chat: {why}")


def claims_of(token: str | None) -> dict:
    if not token:
        raise _deny("no approval (X-Approval-Id)")
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != VERSION:
        raise _deny("the approval isn't a signed approval token")
    secret = settings().approval_secret
    if not secret:
        raise _deny("approvals aren't configured")
    want = hmac.new(secret.encode(), f"{VERSION}.{parts[1]}".encode(), hashlib.sha256).digest()
    try:
        ok = hmac.compare_digest(want, _unb64(parts[2]))
        claims = json.loads(_unb64(parts[1])) if ok else None
    except (ValueError, json.JSONDecodeError):
        ok, claims = False, None
    if not ok or not isinstance(claims, dict):
        raise _deny("the approval's signature doesn't match")
    return claims


def verify(db: Session, ctx: RequestContext, *, operation: str, project_id: str, targets: Iterable[str] = ()) -> None:
    """Refuse (403) unless the request carries a valid, unused approval for exactly this."""
    if not ctx.scopes:
        return
    c = claims_of(ctx.approval_id)
    aid = c.get("aid")
    if not isinstance(aid, str) or not aid:
        raise _deny("the approval has no id")
    if not ctx.token_hash or c.get("dlg") != ctx.token_hash or ("sub" in c and c["sub"] != ctx.on_behalf_of):
        raise _deny("it was given to someone else")
    if c.get("op") != operation:
        raise _deny("it was given for another operation")
    if c.get("pid") != project_id:
        raise _deny("it was given for another project")
    approved = {str(t) for t in c.get("tgt") or []}
    if not set(targets) <= approved:
        raise _deny("it was given for other items")
    exp = c.get("exp")
    t = time.time()
    if not isinstance(exp, int | float) or exp < t or exp > t + MAX_TTL_S + SKEW_S:
        raise _deny("it has expired; ask again")
    if db.get(ApprovalUsed, aid) is not None:
        raise _deny("it was already used; ask again")
    db.add(ApprovalUsed(approval_id=aid, person=ctx.on_behalf_of, operation=operation, project_id=project_id, expires_at=datetime.fromtimestamp(exp, UTC)))
    db.flush()
