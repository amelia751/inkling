"""FastAPI glue for the write pipeline: `dryRun` and `Idempotency-Key` as one dependency (D8, D13).

    @router.post("/things", openapi_extra={"x-operation": "things.create"})
    def create(body: dict, w: WriteParams = Depends(write_params)): ...
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from fastapi import Header, Query
from fastapi.responses import JSONResponse

from .idempotency import IdempotencyError

OPERATION_KEY = "x-operation"


@dataclass(frozen=True)
class WriteParams:
    dry_run: bool = False
    idempotency_key: str | None = None


def write_params(
    dry_run: bool = Query(False, alias="dryRun"),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key", max_length=255),
) -> WriteParams:
    return WriteParams(dry_run=dry_run, idempotency_key=(idempotency_key or "").strip() or None)


def idempotency_principal(ctx: Any) -> str:
    """Whose keys an `Idempotency-Key` lives among (todo17 D13): always the authenticated caller,
    never a body field. An API key is `apikey:<id>`; an outside agent's OAuth token is its
    connection (`conn:<id>`: the token subject's grant to that client, stable across refreshes,
    so two agents of one person never share keys); a session token its own hash; a person their
    principal."""
    from ...context import AUTH_OAUTH, AUTH_TOKEN

    if ctx.auth == AUTH_OAUTH and ctx.token_hash:
        return ctx.token_hash
    if ctx.auth == AUTH_TOKEN and ctx.token_hash:
        return f"token:{ctx.token_hash}"
    return ctx.principal


def admission_ctx(ctx: Any, project_id: str | None = None, **extra: Any) -> Any:
    """An `admit` context from the request's: actor, the person it acts for, and the D12 scopes
    of an API key or OAuth token (None for people and session tokens, which D12 doesn't govern)."""
    from ...auth import scopes
    from . import Ctx

    held = frozenset(scopes.tier_scopes(ctx.scopes) if "*" not in ctx.scopes else scopes.SCOPES) if scopes.governed(ctx) else None
    return Ctx(project_id=project_id, principal=ctx.principal, on_behalf_of=ctx.on_behalf_of, scopes=held, extra=dict(extra))


def declares(op_id: str) -> dict[str, Any]:
    """`openapi_extra` marking a route as going through `admit(op_id)` (checked by `check:writes`)."""
    return {OPERATION_KEY: op_id}


def install(app: Any) -> None:
    from . import problem

    problem.install(app)

    async def _idem(_req: Any, exc: IdempotencyError) -> JSONResponse:
        return JSONResponse(
            {"type": "/docs/lint-rules#" + exc.code, "title": exc.message, "status": exc.status, "code": exc.code, "violations": [], "retryable": exc.status == 409},
            status_code=exc.status,
            media_type=problem.MEDIA_TYPE,
        )

    app.add_exception_handler(IdempotencyError, _idem)
