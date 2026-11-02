"""RFC 9457 problem JSON for rejected writes (todo17 D6), and the FastAPI handler."""

from __future__ import annotations

from typing import Any

from . import WriteRejected

PROBLEM_TYPE = "/docs/lint-rules#write_rejected"
MEDIA_TYPE = "application/problem+json"


def problem(exc: WriteRejected, *, status: int = 422, code: str = "write_rejected") -> dict[str, Any]:
    return {
        "type": PROBLEM_TYPE,
        "title": exc.title,
        "status": status,
        "code": code,
        "violations": [v.to_json() for v in exc.violations],
        "retryable": exc.retryable,
        **(getattr(exc, "body_extra", None) or {}),
    }


def install(app: Any) -> None:
    """Register the WriteRejected handler on a FastAPI app."""
    from fastapi.responses import JSONResponse

    from . import PermissionDenied

    async def _handler(_req: Any, exc: WriteRejected) -> JSONResponse:
        status = 403 if isinstance(exc, PermissionDenied) else 422
        code = "forbidden" if status == 403 else "write_rejected"
        return JSONResponse(problem(exc, status=status, code=code), status_code=status, media_type=MEDIA_TYPE)

    app.add_exception_handler(WriteRejected, _handler)


def with_findings(body: dict[str, Any], admitted: Any) -> dict[str, Any]:
    """Success bodies carry the warnings and infos as `findings` (D6)."""
    return {**body, "findings": admitted.findings_json(), **({"dryRun": True} if admitted.dry_run else {})}
