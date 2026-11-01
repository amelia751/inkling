"""The pipeline service's private API, called only by the api (todo12 §5 contracts):

    POST /v1/runs                       start a run
    GET  /v1/runs/{id}                  one run
    GET  /v1/runs?workspace_id=&project_id=&state=&cursor=   a project's runs (see below)
    POST /v1/runs/{id}/cancel
    POST /v1/approvals                  {run_id, approval_id, candidate_digest}
    POST /v1/definitions/{id}/validate

Every call carries a 60 s Ed25519 JWT signed with the api's versioning signing key (the same
private key, so no new Secret), header `kid` = `<envPrefix>API_PIPELINE_JWT_KID` (`api`),
audience `pipeline`. The pipeline verifies it against the public key in its JWKS file
(`PIPELINE_API_JWKS_FILE`); in dev `jwks_path()` writes that file next to the key. Claims:
issuer, audience, subject and actor (user, agent or service), `workspace_id`, `scopes`
(`pipeline:read|run|approve`) and `request_id`.

`GET /v1/runs` (the list) is not in the todo12 §5 private API list; the web's run list needs
it, so the gateway calls it and the hand-back reports the addition.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import httpx
from cryptography.hazmat.primitives import serialization

from ..config import settings
from ..context import RequestContext
from .versioning import auth

AUDIENCE = "pipeline"
LIFETIME_S = 60
READ, RUN, APPROVE = "pipeline:read", "pipeline:run", "pipeline:approve"


class PipelineError(Exception):
    def __init__(self, status: int, body: Any):
        super().__init__(f"pipeline answered {status}")
        self.status, self.body = status, body


def configured() -> bool:
    return bool(settings().pipeline_url)


def mint(ctx: RequestContext, scopes: list[str]) -> str:
    now = int(time.time())
    actor = auth.actor_of(ctx)
    claims = {
        "iss": settings().versioning_issuer,
        "aud": [AUDIENCE],
        "sub": actor["id"],
        "iat": now,
        "exp": now + LIFETIME_S,
        "workspace_id": ctx.workspace_id,
        "actor": actor,
        "scopes": sorted(set(scopes)),
        "request_id": ctx.correlation_id,
    }
    header = {"alg": "EdDSA", "typ": "JWT", "kid": settings().pipeline_jwt_kid}
    signing_input = f"{auth._b64(json.dumps(header, separators=(',', ':')).encode())}.{auth._b64(json.dumps(claims, separators=(',', ':')).encode())}"
    return f"{signing_input}.{auth._b64(auth.signing_key().sign(signing_input.encode()))}"


def jwks() -> dict:
    raw = auth.signing_key().public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return {"keys": [{"kty": "OKP", "crv": "Ed25519", "kid": settings().pipeline_jwt_kid, "x": auth._b64(raw), "use": "sig", "alg": "EdDSA"}]}


def jwks_path() -> Path:
    """Dev: the pipeline's `PIPELINE_API_JWKS_FILE`, written beside the api's key."""
    path = settings().data_dir / "pipeline-api-jwks.json"
    doc = json.dumps(jwks())
    if not path.is_file() or path.read_text() != doc:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(doc)
    return path


class PipelineClient:
    def __init__(self, base_url: str, timeout_s: float = 15.0, transport: httpx.BaseTransport | None = None):
        self.http = httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout_s, transport=transport)

    def _call(self, ctx: RequestContext, scopes: list[str], method: str, path: str, *, json_body: dict | None = None, params: dict | None = None, idempotency_key: str | None = None) -> Any:
        headers = {"Authorization": f"Bearer {mint(ctx, scopes)}", "X-Request-Id": ctx.correlation_id}
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        try:
            r = self.http.request(method, path, json=json_body, params={k: v for k, v in (params or {}).items() if v is not None}, headers=headers)
        except httpx.HTTPError as e:
            raise PipelineError(503, {"detail": f"pipeline unreachable ({type(e).__name__})"}) from e
        try:
            body = r.json() if r.content else {}
        except ValueError:
            body = {"detail": r.text[:300]}
        if r.status_code >= 500:
            raise PipelineError(502, {"detail": "pipeline error", "status": r.status_code})
        if r.status_code >= 400:
            raise PipelineError(r.status_code, body)
        return body

    def create_run(self, ctx: RequestContext, body: dict, idempotency_key: str | None) -> dict:
        return self._call(ctx, [RUN], "POST", "/v1/runs", json_body=body, idempotency_key=idempotency_key)

    def get_run(self, ctx: RequestContext, run_id: str) -> dict:
        return self._call(ctx, [READ], "GET", f"/v1/runs/{run_id}")

    def list_runs(self, ctx: RequestContext, project_id: str, state: str | None, cursor: str | None) -> dict:
        return self._call(ctx, [READ], "GET", "/v1/runs", params={"workspace_id": ctx.workspace_id, "project_id": project_id, "state": state, "cursor": cursor})

    def cancel_run(self, ctx: RequestContext, run_id: str, idempotency_key: str | None) -> dict:
        return self._call(ctx, [RUN], "POST", f"/v1/runs/{run_id}/cancel", json_body={}, idempotency_key=idempotency_key)

    def approve(self, ctx: RequestContext, body: dict) -> dict:
        return self._call(ctx, [APPROVE], "POST", "/v1/approvals", json_body=body, idempotency_key=body.get("approval_id"))

    def validate_definition(self, ctx: RequestContext, definition_id: str, body: dict) -> dict:
        return self._call(ctx, [READ], "POST", f"/v1/definitions/{definition_id}/validate", json_body=body)


_client: PipelineClient | None = None
_client_url: str | None = None


def client() -> PipelineClient:
    global _client, _client_url
    url = settings().pipeline_url or ""
    if _client is None or _client_url != url:
        _client, _client_url = PipelineClient(url), url
    return _client


def set_client(c: PipelineClient | None) -> None:
    """Tests: point the gateway at a stub."""
    global _client, _client_url
    _client, _client_url = c, settings().pipeline_url if c else None
