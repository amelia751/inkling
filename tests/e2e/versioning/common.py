"""Helpers shared by the versioning e2e flows: an HTTP caller per actor, polling, assertions."""

from __future__ import annotations

import hashlib
import json
import struct
import time
import uuid
import zlib
from pathlib import Path

import httpx

NAMING = json.loads((Path(__file__).resolve().parents[3] / "schemas" / "naming.json").read_text())


def ns(local: str) -> str:
    return f"{NAMING['namespace']}.{local}"


def png(w: int, h: int, seed: int = 0) -> bytes:
    raw = b"".join(b"\x00" + bytes([(x * 7 + y * 3 + seed) % 256 for x in range(w)]) for y in range(h))
    ch = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)  # noqa: E731
    return b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)) + ch(b"IDAT", zlib.compress(raw)) + ch(b"IEND", b"")


def box(id_: str, item: str, x: float, label: str = "lesion", author: str = "user:alice") -> dict:
    return {"id": id_, "itemId": item, "label": label, "geometry": {"type": "box", "x": x, "y": 4, "w": 10, "h": 8}, "provenance": "human-created", "author": author, "createdAt": "2026-10-30T00:00:00Z"}


class Actor:
    """Calls apps/api as one principal in one workspace: a dev user (X-Dev-Principal) or a
    session token (an agent)."""

    def __init__(self, api: str, workspace: str, principal: str | None = None, token: str | None = None):
        self.api, self.workspace, self.principal = api.rstrip("/"), workspace, principal
        h = {"X-Workspace-Id": workspace}
        if token:
            h["Authorization"] = f"Bearer {token}"
        elif principal:
            h["X-Dev-Principal"] = principal
        self.http = httpx.Client(base_url=self.api, headers=h, timeout=60)

    def req(self, method: str, path: str, *, expect: int | tuple[int, ...] | None = None, **kw) -> httpx.Response:
        r = self.http.request(method, path, **kw)
        if expect is not None:
            want = (expect,) if isinstance(expect, int) else expect
            assert r.status_code in want, f"{method} {path} → {r.status_code} (wanted {want}): {r.text[:800]}"
        return r

    def get(self, path: str, **kw):
        return self.req("GET", path, **kw)

    def post(self, path: str, **kw):
        return self.req("POST", path, **kw)

    def command(self, local: str, expect=None, **input_) -> httpx.Response:
        return self.post("/api/v1/commands", json={"tool": ns(local), "input": input_}, headers={"Idempotency-Key": uuid.uuid4().hex}, expect=expect)

    def agent(self, name: str, scopes: list[str]) -> "Actor":
        tok = self.post("/api/v1/sessions", json={"agent": name, "scopes": scopes}, expect=200).json()["token"]
        return Actor(self.api, self.workspace, token=tok)

    def upload(self, ds: str, data: bytes, media_type: str) -> dict:
        art = self.post(f"/api/v1/datasets/{ds}/artifacts", content=data, headers={"Content-Type": media_type}, expect=201).json()
        assert art["sha256"] == hashlib.sha256(data).hexdigest()
        return art

    def wait_review(self, ds: str, rid: str, statuses: set[str], timeout: float = 60) -> dict:
        """Poll until the review reaches one of `statuses` (the worker's de-identification
        check and the service's own checks run asynchronously)."""
        deadline = time.monotonic() + timeout
        rv: dict = {}
        while time.monotonic() < deadline:
            rv = self.get(f"/api/v1/datasets/{ds}/reviews/{rid}", expect=200).json()
            if rv["status"] in statuses:
                return rv
            time.sleep(0.3)
        raise AssertionError(f"review {rid} stuck in {rv.get('status')}; checks: {[(c['name'], c['outcome']) for c in rv.get('checks') or []]}")


def run_id() -> str:
    return time.strftime("%H%M%S") + uuid.uuid4().hex[:4]
