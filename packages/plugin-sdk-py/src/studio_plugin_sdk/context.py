"""The scoped clients a tool call gets. Everything goes through the kernel with the job's
session token (scoped to what the workspace granted this plugin version)."""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from typing import Any

import httpx


class AssetsClient:
    def __init__(self, http: httpx.Client):
        self._http = http

    def read(self, asset_id: str) -> bytes:
        r = self._http.get(f"/api/v1/assets/{asset_id}/content")
        if r.status_code == 404:
            # Dev: assets may be addressed by seed path.
            listed = self._http.get("/api/v1/assets").json().get("assets", [])
            hit = next((a for a in listed if a["path"] == asset_id), None)
            if hit is None:
                raise PermissionError(f"asset {asset_id!r} isn't readable in this workspace")
            r = self._http.get(f"/api/v1/assets/{hit['id']}/content")
        if r.status_code == 403:
            raise PermissionError("this plugin wasn't granted assets.read")
        r.raise_for_status()
        return r.content

    def list(self) -> list[dict]:
        r = self._http.get("/api/v1/assets")
        r.raise_for_status()
        return r.json()["assets"]


class JobsClient:
    """Progress lines go to the worker over stdout (the protocol in runner.py)."""

    def __init__(self, emit=None):
        self._emit = emit or (lambda msg: print(json.dumps(msg), file=sys.stdout, flush=True))

    def progress(self, fraction: float, message: str | None = None) -> None:
        self._emit({"type": "progress", "progress": max(0.0, min(1.0, float(fraction))), "message": message})


class BrokeredClient:
    """Outbound HTTP through the kernel's secrets broker: the broker adds the credential."""

    def __init__(self, http: httpx.Client, use_token: str):
        self._http = http
        self._token = use_token

    def request(self, method: str, url: str, *, json_body: Any = None, headers: dict[str, str] | None = None, inject: str = "Authorization", scheme: str = "Bearer") -> httpx.Response:
        body = json.dumps(json_body) if json_body is not None else None
        return self._http.post(
            "/api/v1/secrets/proxy",
            headers={"X-Secret-Use-Token": self._token},
            json={"method": method, "url": url, "headers": {**({"Content-Type": "application/json"} if body else {}), **(headers or {})}, "body": body, "inject": inject, "scheme": scheme},
        )

    def post(self, url: str, **kw) -> httpx.Response:
        return self.request("POST", url, **kw)


class SecretsClient:
    def __init__(self, http: httpx.Client, use_tokens: dict[str, str]):
        self._http = http
        self._tokens = use_tokens

    def use(self, name: str) -> BrokeredClient:
        if name not in self._tokens:
            raise PermissionError(f"secret {name} isn't granted to this plugin in this workspace")
        return BrokeredClient(self._http, self._tokens[name])


@dataclass
class ToolContext:
    workspace_id: str
    job_id: str
    assets: AssetsClient
    jobs: JobsClient
    secrets: SecretsClient
    provider: dict | None = None
    config: dict = field(default_factory=dict)
    http: httpx.Client | None = None  # kernel client (for the SDK's own clients); not for egress
