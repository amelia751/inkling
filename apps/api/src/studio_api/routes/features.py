"""Feature flags and the browser's drop timeline (todo13 §7.1, §7.3, Milestone 4 item 1).

    GET  /api/v1/features            → {chatDrops, autoApply, fastPath, datasetsTab} (no auth: flags aren't secret)
    POST /api/v1/telemetry/timeline  {dropId?, origin, steps: {step: ms}, outcome?} → 204
                                     (404 while every todo13 flag is off, §6 J12)

The timeline carries durations only: step names from a fixed shape and milliseconds since the
first gesture. No file names, no paths, no counts of anything content-derived. The api logs one
JSON line per post (`msg: "drop.timeline"`), which the log-based metrics read (§7.3).
"""

from __future__ import annotations

import logging
import re

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import Response

from ..context import RequestContext, get_context
from ..kernel import features

router = APIRouter(prefix="/api/v1")
log = logging.getLogger("studio_api.telemetry")

STEP = re.compile(r"^[a-z][a-z0-9:-]{0,47}$")
DROP_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
ORIGINS = frozenset({"home", "projects", "chat", "files", "studio", "canvas", "overview", "datasets", "send"})
OUTCOMES = frozenset({"interactive", "configured", "abandoned", "failed"})
MAX_STEPS = 40
MAX_MS = 60 * 60 * 1000


@router.get("/features")
def get_features():
    return features.snapshot()


def _validate(body: dict) -> dict:
    if not isinstance(body, dict):
        raise HTTPException(422, "timeline must be an object")
    steps = body.get("steps")
    if not isinstance(steps, dict) or not steps or len(steps) > MAX_STEPS:
        raise HTTPException(422, f"steps must be an object with 1–{MAX_STEPS} entries")
    clean: dict[str, int] = {}
    for k, v in steps.items():
        if not isinstance(k, str) or not STEP.match(k):
            raise HTTPException(422, "step names are lowercase words (a-z, 0-9, ':', '-')")
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0 <= v <= MAX_MS:
            raise HTTPException(422, f"step {k} must be a duration in ms (0–{MAX_MS})")
        clean[k] = round(v)
    origin = body.get("origin")
    if origin not in ORIGINS:
        raise HTTPException(422, f"origin must be one of {', '.join(sorted(ORIGINS))}")
    drop_id = body.get("dropId")
    if drop_id is not None and (not isinstance(drop_id, str) or not DROP_ID.match(drop_id)):
        raise HTTPException(422, "dropId must be an id")
    outcome = body.get("outcome", "interactive")
    if outcome not in OUTCOMES:
        raise HTTPException(422, f"outcome must be one of {', '.join(sorted(OUTCOMES))}")
    return {"dropId": drop_id, "origin": origin, "outcome": outcome, "steps": clean}


@router.post("/telemetry/timeline", status_code=204, dependencies=[Depends(features.require_any())])
def post_timeline(body: dict = Body(...), ctx: RequestContext = Depends(get_context)):
    t = _validate(body)
    steps = t["steps"]
    log.info(
        "drop.timeline",
        extra={
            "event": "drop.timeline",
            "dropId": t["dropId"],
            "origin": t["origin"],
            "outcome": t["outcome"],
            "steps_ms": steps,
            # The headline number the log-based metric reads (§6 J1 budget): first interactive item.
            "elapsed_ms": steps.get("first-interactive", max(steps.values())),
            "workspace": ctx.workspace_id,
        },
    )
    return Response(status_code=204)
