"""The signed-in person's own settings (todo14 D8).

    GET /api/v1/me/prefs          → {prefs: {key: value}}
    PUT /api/v1/me/prefs/{key}    {value: any JSON} → {key, value}

People only: an agent, plugin or service token gets 403. Keys are `[a-zA-Z0-9._-]{1,64}`;
a value is at most 16 KiB of JSON, and a person keeps at most 100 keys. The web stores
`firstRunHintsDismissed` here, so a second browser doesn't show the first-run hints again.
"""

from __future__ import annotations

import json
import re

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..context import RequestContext, get_context
from ..db import get_session
from ..models import UserPref, now

router = APIRouter(prefix="/api/v1")

KEY = re.compile(r"[a-zA-Z0-9._-]{1,64}")
MAX_VALUE_BYTES = 16 * 1024
MAX_KEYS = 100


def _person(ctx: RequestContext) -> str:
    if ctx.scopes or ctx.on_behalf_of or not ctx.principal.startswith("user:"):
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
        raise HTTPException(422, "a preference key is 1–64 letters, digits, '.', '_' or '-'")
    if "value" not in body:
        raise HTTPException(422, "send {value}")
    value = body["value"]
    if len(json.dumps(value, separators=(",", ":"))) > MAX_VALUE_BYTES:
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
