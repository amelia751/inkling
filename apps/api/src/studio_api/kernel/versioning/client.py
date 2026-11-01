"""The kernel's view of apps/versioning: plain dicts in and out, problems as exceptions.

`HttpVersioningClient` builds every request with the generated client
(`studio_api.clients.versioning`, from schemas/versioning/openapi.yaml): its request models
validate bodies (`from_dict`) and its `_get_kwargs` builds method, path, headers and body.
Responses are read as raw JSON so a field the generated models don't know never gets lost.
Tests swap in a fake with the same methods (`set_client`).
"""

from __future__ import annotations

import json
from io import BytesIO
from typing import Any, Protocol
from uuid import UUID

import httpx

from ...clients.versioning import Client
from ...clients.versioning.api.artifacts import put_annotation_revision, put_artifact
from ...clients.versioning.api.branches import create_branch, list_branches
from ...clients.versioning.api.checkouts import create_checkout
from ...clients.versioning.api.commits import create_commit, get_commit, get_studio, list_commits, put_manifest, revert
from ...clients.versioning.api.diff import get_diff
from ...clients.versioning.api.ops import readyz
from ...clients.versioning.api.releases import create_release, list_releases
from ...clients.versioning.api.repos import create_repo, get_repo
from ...clients.versioning.api.reviews import approve_review, create_review, get_review, list_reviews, merge_review, report_check, resolve_conflicts
from ...clients.versioning.models import (
    AnnotationRevision,
    ApproveRequest,
    CheckoutRequest,
    CheckReport,
    CommitRequest,
    CreateBranchRequest,
    CreateReleaseRequest,
    CreateRepoRequest,
    CreateReviewRequest,
    Manifest,
    MergeRequest,
    ResolutionsRequest,
    RevertRequest,
    ReviewStatus,
)
from ...clients.versioning.types import UNSET, File
from ...config import settings


class VersioningProblem(Exception):
    """An application/problem+json error from the service (or a transport failure), passed
    through to callers with the same status and stable `code` (stale_head, self_approval…)."""

    def __init__(self, status: int, body: dict):
        super().__init__(body.get("detail") or body.get("title") or body.get("code"))
        self.status = status
        self.body = {"type": body.get("type", "about:blank"), "title": body.get("title", "Versioning error"), "status": status, "code": body.get("code", "internal"), **{k: v for k, v in body.items() if k not in ("status",)}}

    @property
    def code(self) -> str:
        return str(self.body.get("code"))


def problem(status: int, code: str, detail: str, **extra: Any) -> VersioningProblem:
    return VersioningProblem(status, {"title": code.replace("_", " "), "code": code, "detail": detail, **extra})


class VersioningClient(Protocol):
    """Every method takes the minted JWT first and returns the service's JSON."""

    def ready(self) -> bool: ...
    def create_repo(self, token: str, body: dict, idempotency_key: str) -> dict: ...
    def get_repo(self, token: str, repo_id: str) -> dict: ...
    def create_branch(self, token: str, repo_id: str, body: dict, idempotency_key: str) -> dict: ...
    def list_branches(self, token: str, repo_id: str, cursor: str | None = None, limit: int = 100) -> dict: ...
    def put_artifact(self, token: str, sha256: str, data: bytes, media_type: str) -> dict: ...
    def put_annotation_revision(self, token: str, body: dict) -> dict: ...
    def put_manifest(self, token: str, repo_id: str, manifest: dict) -> dict: ...
    def create_commit(self, token: str, repo_id: str, body: dict) -> dict: ...
    def list_commits(self, token: str, repo_id: str, ref: str, cursor: str | None = None, limit: int = 100) -> dict: ...
    def get_commit(self, token: str, repo_id: str, oid: str) -> dict: ...
    def revert(self, token: str, repo_id: str, body: dict) -> dict: ...
    def get_diff(self, token: str, repo_id: str, base: str, head: str, cursor: str | None = None, limit: int = 100) -> dict: ...
    def create_review(self, token: str, repo_id: str, body: dict, idempotency_key: str) -> dict: ...
    def list_reviews(self, token: str, repo_id: str, status: str | None = None, cursor: str | None = None, limit: int = 100) -> dict: ...
    def get_review(self, token: str, repo_id: str, review_id: str) -> dict: ...
    def approve_review(self, token: str, repo_id: str, review_id: str, body: dict) -> dict: ...
    def resolve_conflicts(self, token: str, repo_id: str, review_id: str, body: dict) -> dict: ...
    def report_check(self, token: str, repo_id: str, review_id: str, name: str, body: dict) -> dict: ...
    def merge_review(self, token: str, repo_id: str, review_id: str, body: dict) -> dict: ...
    def create_release(self, token: str, repo_id: str, body: dict, idempotency_key: str) -> dict: ...
    def list_releases(self, token: str, repo_id: str) -> list: ...
    def create_checkout(self, token: str, repo_id: str, body: dict) -> dict: ...
    def get_studio(self, token: str, repo_id: str, ref: str) -> dict: ...
    def fetch(self, url: str) -> bytes: ...


def _model(cls, body: dict):
    """Validate a request body with the generated model (missing required keys → 400)."""
    try:
        return cls.from_dict(body)
    except (KeyError, TypeError, ValueError) as e:
        raise problem(400, "bad_request", f"invalid {cls.__name__}: {e}") from e


def _opt(v):
    return UNSET if v is None else v


class HttpVersioningClient:
    def __init__(self, base_url: str, timeout_s: float = 30.0):
        self.base_url = base_url.rstrip("/")
        # The generated client's transport; per-call auth goes in each request's headers.
        self._client = Client(base_url=self.base_url, timeout=httpx.Timeout(timeout_s))
        self._http = httpx.Client(timeout=httpx.Timeout(timeout_s))

    def _send(self, token: str | None, kwargs: dict) -> Any:
        headers = {**(kwargs.pop("headers", None) or {}), **({"Authorization": f"Bearer {token}"} if token else {})}
        try:
            r = self._client.get_httpx_client().request(**kwargs, headers=headers)
        except httpx.HTTPError as e:
            raise problem(502, "unavailable", f"versioning service unreachable: {type(e).__name__}") from e
        data: Any = None
        if r.content:
            try:
                data = json.loads(r.content)
            except ValueError:
                data = {"detail": r.text[:500]}
        if r.status_code >= 400:
            raise VersioningProblem(r.status_code, data if isinstance(data, dict) else {"detail": str(data)})
        return data

    def ready(self) -> bool:
        try:
            return self._send(None, readyz._get_kwargs()).get("status") == "ok"
        except VersioningProblem:
            return False

    def create_repo(self, token, body, idempotency_key):
        return self._send(token, create_repo._get_kwargs(body=_model(CreateRepoRequest, body), idempotency_key=idempotency_key))

    def get_repo(self, token, repo_id):
        return self._send(token, get_repo._get_kwargs(UUID(repo_id)))

    def create_branch(self, token, repo_id, body, idempotency_key):
        return self._send(token, create_branch._get_kwargs(UUID(repo_id), body=_model(CreateBranchRequest, body), idempotency_key=idempotency_key))

    def list_branches(self, token, repo_id, cursor=None, limit=100):
        return self._send(token, list_branches._get_kwargs(UUID(repo_id), cursor=_opt(cursor), limit=limit))

    def put_artifact(self, token, sha256, data, media_type):
        return self._send(token, put_artifact._get_kwargs(sha256, body=File(payload=BytesIO(data)), x_media_type=media_type))

    def put_annotation_revision(self, token, body):
        return self._send(token, put_annotation_revision._get_kwargs(body=_model(AnnotationRevision, body)))

    def put_manifest(self, token, repo_id, manifest):
        return self._send(token, put_manifest._get_kwargs(UUID(repo_id), body=_model(Manifest, manifest)))

    def create_commit(self, token, repo_id, body):
        return self._send(token, create_commit._get_kwargs(UUID(repo_id), body=_model(CommitRequest, body)))

    def list_commits(self, token, repo_id, ref, cursor=None, limit=100):
        return self._send(token, list_commits._get_kwargs(UUID(repo_id), ref=ref, cursor=_opt(cursor), limit=limit))

    def get_commit(self, token, repo_id, oid):
        return self._send(token, get_commit._get_kwargs(UUID(repo_id), oid))

    def revert(self, token, repo_id, body):
        return self._send(token, revert._get_kwargs(UUID(repo_id), body=_model(RevertRequest, body)))

    def get_diff(self, token, repo_id, base, head, cursor=None, limit=100):
        return self._send(token, get_diff._get_kwargs(UUID(repo_id), base=base, head=head, cursor=_opt(cursor), limit=limit))

    def create_review(self, token, repo_id, body, idempotency_key):
        return self._send(token, create_review._get_kwargs(UUID(repo_id), body=_model(CreateReviewRequest, body), idempotency_key=idempotency_key))

    def list_reviews(self, token, repo_id, status=None, cursor=None, limit=100):
        return self._send(token, list_reviews._get_kwargs(UUID(repo_id), status=ReviewStatus(status) if status else UNSET, cursor=_opt(cursor), limit=limit))

    def get_review(self, token, repo_id, review_id):
        return self._send(token, get_review._get_kwargs(UUID(repo_id), UUID(review_id)))

    def approve_review(self, token, repo_id, review_id, body):
        return self._send(token, approve_review._get_kwargs(UUID(repo_id), UUID(review_id), body=_model(ApproveRequest, body)))

    def resolve_conflicts(self, token, repo_id, review_id, body):
        return self._send(token, resolve_conflicts._get_kwargs(UUID(repo_id), UUID(review_id), body=_model(ResolutionsRequest, body)))

    def report_check(self, token, repo_id, review_id, name, body):
        return self._send(token, report_check._get_kwargs(UUID(repo_id), UUID(review_id), name, body=_model(CheckReport, body)))

    def merge_review(self, token, repo_id, review_id, body):
        return self._send(token, merge_review._get_kwargs(UUID(repo_id), UUID(review_id), body=_model(MergeRequest, body)))

    def create_release(self, token, repo_id, body, idempotency_key):
        return self._send(token, create_release._get_kwargs(UUID(repo_id), body=_model(CreateReleaseRequest, body), idempotency_key=idempotency_key))

    def list_releases(self, token, repo_id):
        return self._send(token, list_releases._get_kwargs(UUID(repo_id)))

    def create_checkout(self, token, repo_id, body):
        return self._send(token, create_checkout._get_kwargs(UUID(repo_id), body=_model(CheckoutRequest, body)))

    def get_studio(self, token, repo_id, ref):
        return self._send(token, get_studio._get_kwargs(UUID(repo_id), ref=ref))

    def fetch(self, url: str) -> bytes:
        """GET a short-lived signed object URL from a checkout."""
        try:
            r = self._http.get(url)
        except httpx.HTTPError as e:
            raise problem(502, "unavailable", f"object fetch failed: {type(e).__name__}") from e
        if r.status_code >= 400:
            raise problem(502, "unavailable", f"object fetch returned {r.status_code}")
        return r.content


_client: VersioningClient | None = None


def set_client(c: VersioningClient | None) -> None:
    """Tests (and alternative transports) install a client; None restores the default."""
    global _client
    _client = c


def configured() -> bool:
    return _client is not None or bool(settings().versioning_url)


def client() -> VersioningClient:
    global _client
    if _client is not None:
        return _client
    url = settings().versioning_url
    if not url:
        raise problem(503, "disabled", "dataset versioning isn't configured (set <envPrefix>API_VERSIONING_URL)")
    if url == "memory:":  # in-process stand-in (no Go, Postgres or object storage); dev only
        from .fake import FakeVersioning

        _client = FakeVersioning()
        return _client
    _client = HttpVersioningClient(url)
    return _client
