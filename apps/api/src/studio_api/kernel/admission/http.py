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
