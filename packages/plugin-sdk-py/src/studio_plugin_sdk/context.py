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


class AnnotationsClient:
    """Canonical annotations through the kernel's Annotation API (docs/plugins.md §6).

    `write` posts to `POST /api/v1/annotations`, which applies the same checks as the
    gateway's commit path: the session must hold `annotations.write`, the write is bound to
    this running job (`X-Job-Id`), every annotation is shape-checked, its item must be an
    asset of this workspace, and the kernel, not the plugin, sets `author`, `provenance`
    (`ai-suggested`), `job_id` and the stored id (derived from the job, so a plugin can't
    overwrite annotations it didn't write). Writes are idempotent per `key` within the job.

    A capability's *result* (e.g. `image.segment` masks) still goes back through the
    gateway, which validates it against the capability schema; use `write` for extra
    annotations a tool produces that no capability result describes.
    """

    def __init__(self, http: httpx.Client, job_id: str):
        self._http = http
        self._job_id = job_id

    def write(self, annotations: list[dict], *, key: str | None = None) -> list[str]:
        """Commit annotations as one revision; returns their stored ids. `key` makes a retry a no-op."""
        headers = {"X-Job-Id": self._job_id, **({"Idempotency-Key": key} if key else {})}
        r = self._http.post("/api/v1/annotations", headers=headers, json={"annotations": annotations})
        if r.status_code == 403:
            raise PermissionError(_detail(r) or "this plugin wasn't granted annotations.write")
        if r.status_code in (400, 404, 409, 422):
            raise ValueError(f"annotations rejected: {_detail(r)}")
        r.raise_for_status()
        return list(r.json()["annotationIds"])

    def list(self, *, item_id: str | None = None, label: str | None = None) -> list[dict]:
        """Annotations of this workspace (needs `annotations.read`)."""
        params = {k: v for k, v in (("item_id", item_id), ("label", label)) if v}
        r = self._http.get("/api/v1/annotations", params=params)
        if r.status_code == 403:
            raise PermissionError("this plugin wasn't granted annotations.read")
        r.raise_for_status()
        return r.json()["annotations"]


def _detail(r: httpx.Response) -> str:
    try:
        d = r.json().get("detail")
    except ValueError:
        return r.text[:300]
    return d if isinstance(d, str) else json.dumps(d)[:500]


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
    annotations: AnnotationsClient | None = None
    provider: dict | None = None
    config: dict = field(default_factory=dict)
    http: httpx.Client | None = None  # kernel client (for the SDK's own clients); not for egress
