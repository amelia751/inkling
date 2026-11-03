"""The signed-in person's own settings (todo14 D8).

    GET /api/v1/me/prefs          → {prefs: {key: value}}
    PUT /api/v1/me/prefs/{key}    {value: any JSON} → {key, value}

People only, in the browser (session cookie or dev identity): an agent, plugin or service
token, or an API key, gets 403. todo22 D8: a key matches `^[a-z][a-z0-9:._-]{0,127}$` (422
otherwise), a value is at most 64 KiB of compact UTF-8 JSON (413 otherwise), and a person keeps
at most 1000 keys (409). The web keeps the person's Studio layouts (`layout:<project>:<task>:<viewport>`),
shell, items view, tool and sources preferences, tree footer and theme here (todo22 D3), plus
`first-run-hints-dismissed` and `ai-notice-seen` (todo14 D8, todo15 D2). Rows written under the
older camelCase keys are still returned by GET.
"""

from __future__ import annotations

import json
import re

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..context import AUTH_COOKIE, AUTH_DEV, RequestContext, get_context
from ..db import get_session
from ..models import UserPref, now

router = APIRouter(prefix="/api/v1")

KEY = re.compile(r"[a-z][a-z0-9:._-]{0,127}")
MAX_VALUE_BYTES = 64 * 1024
MAX_KEYS = 1000


def _person(ctx: RequestContext) -> str:
    if ctx.auth not in (AUTH_COOKIE, AUTH_DEV) or ctx.scopes or not ctx.principal.startswith("user:"):
        raise HTTPException(403, "only a person has preferences")
    return ctx.principal


@router.get("/me/prefs")
def get_prefs(ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    who = _person(ctx)
    return {"prefs": {p.key: p.value for p in db.scalars(select(UserPref).where(UserPref.principal == who).order_by(UserPref.key))}}


@router.put("/me/prefs/{key}")
def put_pref(key: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    who = _person(ctx)
    if not KEY.fullmatch(key):
        raise HTTPException(422, "a preference key matches ^[a-z][a-z0-9:._-]{0,127}$")
    if "value" not in body:
        raise HTTPException(422, "send {value}")
    value = body["value"]
    if len(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()) > MAX_VALUE_BYTES:
        raise HTTPException(413, f"a preference value is at most {MAX_VALUE_BYTES} bytes of JSON")
    row = db.get(UserPref, (who, key))
    if row is None:
        if db.scalar(select(func.count()).select_from(UserPref).where(UserPref.principal == who)) >= MAX_KEYS:
            raise HTTPException(409, f"at most {MAX_KEYS} preferences per person")
        row = UserPref(principal=who, key=key)
        db.add(row)
    row.value, row.updated_at = value, now()
    db.flush()
    return {"key": key, "value": value}
