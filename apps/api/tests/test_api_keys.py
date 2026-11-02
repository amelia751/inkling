"""todo9 Phase 8: organization API keys in dev mode (local table) and workos mode (a fake WorkOS)."""

from __future__ import annotations

import logging
import time
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any
from urllib.parse import parse_qs, urlsplit

import jwt
import pytest
from sqlalchemy import select

from studio_api import db
from studio_api.auth import api_keys, bootstrap
from studio_api.auth.cookie import session_cookie_name
from studio_api.models import AuditEvent, OrgApiKey

from .auth_fakes import ADMIN_PERMS, COOKIE_PASSWORD, FETCH, KEY, MEMBER_PERMS, user, workos_settings


@pytest.fixture(autouse=True)
def _fresh_cache():
    api_keys.forget()
    yield
    api_keys.forget()


def bearer(secret: str, **extra) -> dict:
    return {"Authorization": f"Bearer {secret}", **extra}


# ---- dev mode ----------------------------------------------------------------------------------


def test_dev_create_list_use_and_revoke(client, caplog):
    caplog.set_level(logging.DEBUG)
    pid = client.post("/api/v1/projects", json={"title": "Mine"}).json()["id"]
    r = client.post("/api/v1/org/api-keys", json={"name": "PACS bridge", "expiresInDays": 30, "scopes": ["datasets:read", "studio:tools"]})
    assert r.status_code == 200, r.text
    key, secret = r.json()["key"], r.json()["secret"]
    assert secret.startswith(api_keys.dev_prefix()) and secret not in key["prefix"] and key["prefix"].startswith(api_keys.dev_prefix())
    assert key["name"] == "PACS bridge" and key["scopes"] == ["datasets:read", "studio:tools"] and key["expiresAt"] and key["lastUsedAt"] is None
    assert key["createdBy"] == "user:local-expert"
    assert secret not in caplog.text
    with db.session_scope() as d:
        row = d.get(OrgApiKey, key["id"])
        assert row.secret_hash != secret and secret not in str(row.__dict__)

    listed = client.get("/api/v1/org/api-keys").json()["keys"]
    assert [k["id"] for k in listed] == [key["id"]] and "secret" not in listed[0]

    # An MCP-style call: the key reaches its organization's project through a kernel route.
    r = client.get(f"/api/v1/workspaces/{pid}/state", headers=bearer(secret))
    assert r.status_code == 200, r.text
    assert client.get(f"/api/v1/projects/{pid}", headers=bearer(secret)).status_code == 200
    assert client.get("/api/v1/org/api-keys").json()["keys"][0]["lastUsedAt"]
    # A key is not a person: it can't create datasets, mint tokens or manage keys.
    assert client.post(f"/api/v1/projects/{pid}/datasets", json={"title": "x"}, headers=bearer(secret)).status_code == 403
    assert client.post("/api/v1/sessions", json={"scopes": ["*"]}, headers=bearer(secret, **{"X-Workspace-Id": pid})).status_code == 403
    assert client.get("/api/v1/org/api-keys", headers=bearer(secret)).status_code == 403

    # Another organization's project doesn't exist for the key.
    other = client.post("/api/v1/projects", json={"title": "Bob's"}, headers={"X-Dev-Principal": "user:bob"}).json()["id"]
    assert client.get(f"/api/v1/projects/{other}", headers=bearer(secret)).status_code == 404
    assert client.get(f"/api/v1/workspaces/{other}/state", headers=bearer(secret)).status_code == 404

    assert client.delete(f"/api/v1/org/api-keys/{key['id']}").status_code == 204
    assert client.get(f"/api/v1/projects/{pid}", headers=bearer(secret)).status_code == 401
    assert client.get("/api/v1/org/api-keys").json()["keys"] == []
    assert client.delete(f"/api/v1/org/api-keys/{key['id']}").status_code == 404
    with db.session_scope() as d:
        rows = [(e.action, e.target, e.actor) for e in d.scalars(select(AuditEvent).where(AuditEvent.action.like("api_key.%")).order_by(AuditEvent.at))]
    assert rows == [("api_key.created", key["id"], "user:local-expert"), ("api_key.revoked", key["id"], "user:local-expert")]


def test_dev_validation_errors_and_other_orgs_keys(client):
    assert client.post("/api/v1/org/api-keys", json={"name": "", "expiresInDays": None, "scopes": ["admin"]}).status_code == 422
    assert client.post("/api/v1/org/api-keys", json={"name": "k", "expiresInDays": None, "scopes": []}).status_code == 422
    assert client.post("/api/v1/org/api-keys", json={"name": "k", "expiresInDays": None, "scopes": ["root"]}).status_code == 422
    assert client.post("/api/v1/org/api-keys", json={"name": "k", "expiresInDays": 0, "scopes": ["admin"]}).status_code == 422
    kid = client.post("/api/v1/org/api-keys", json={"name": "k", "expiresInDays": None, "scopes": ["admin"]}).json()["key"]["id"]
    bob = {"X-Dev-Principal": "user:bob"}
    assert client.get("/api/v1/org/api-keys", headers=bob).json()["keys"] == []
    assert client.delete(f"/api/v1/org/api-keys/{kid}", headers=bob).status_code == 404


def test_expired_and_unknown_keys_are_401(client):
    secret = client.post("/api/v1/org/api-keys", json={"name": "k", "expiresInDays": 1, "scopes": ["datasets:read"]}).json()["secret"]
    with db.session_scope() as d:
        d.scalar(select(OrgApiKey)).expires_at = datetime(2020, 1, 1, tzinfo=UTC)
    assert client.get("/api/v1/projects", headers=bearer(secret)).status_code == 401
    assert client.get("/api/v1/projects", headers=bearer(api_keys.dev_prefix() + "nope")).status_code == 401
    assert client.get("/api/v1/projects", headers=bearer("random")).status_code == 401


def test_kernel_session_tokens_still_win(client):
    pid = client.post("/api/v1/projects", json={"title": "P"}).json()["id"]
    tok = client.post("/api/v1/sessions", json={"agent": "builder", "scopes": ["*"]}, headers={"X-Workspace-Id": pid}).json()["token"]
    r = client.get(f"/api/v1/projects/{pid}", headers=bearer(tok))
    assert r.status_code == 200, r.text


def test_scope_mapping():
    assert api_keys.kernel_scopes(["datasets:read"])[0] == "apikey"
    assert "annotations.read" in api_keys.kernel_scopes(["datasets:read"]) and "annotations.write" not in api_keys.kernel_scopes(["datasets:read"])
    assert "annotations.write" in api_keys.kernel_scopes(["annotations:write"])
    assert "commands.invoke" in api_keys.kernel_scopes(["studio:tools"])
    assert "*" in api_keys.kernel_scopes(["admin"]) and api_keys.key_permissions(["admin"]) and not api_keys.key_permissions(["studio:tools"])


# ---- workos mode -------------------------------------------------------------------------------


class FakeApiKeys:
    def __init__(self):
        self.keys: dict[str, dict[str, Any]] = {}  # id → {value, org, name, permissions, ...}
        self.validations = 0
        self.calls: list[str] = []

    def _obj(self, k: dict[str, Any], with_value: bool = False) -> Any:
        o = SimpleNamespace(id=k["id"], name=k["name"], obfuscated_value=k["value"][:7] + "…" + k["value"][-4:], last_used_at=None, expires_at=k["expires_at"], permissions=k["permissions"], created_at=datetime(2026, 11, 1, tzinfo=UTC), owner=SimpleNamespace(type="organization", id=k["org"]))
        if with_value:
            o.value = k["value"]
        return o

    async def create_organization_api_key(self, organization_id, *, name, permissions=None, expires_at=None):
        self.calls.append("create")
        kid = f"api_key_{len(self.keys) + 1}"
        k = {"id": kid, "value": f"sk_live_{kid}_secretvalue", "org": organization_id, "name": name, "permissions": permissions or [], "expires_at": expires_at and datetime.fromisoformat(expires_at.replace("Z", "+00:00"))}
        self.keys[kid] = k
        return self._obj(k, with_value=True)

    async def list_organization_api_keys(self, organization_id, **_):
        from .auth_fakes import _Page

        return _Page([self._obj(k) for k in self.keys.values() if k["org"] == organization_id])

    async def create_validation(self, *, value):
        self.validations += 1
        for k in self.keys.values():
            if k["value"] == value:
                return SimpleNamespace(api_key=self._obj(k))
        return SimpleNamespace(api_key=None)

    async def delete_api_key(self, id):
        self.calls.append("delete")
        self.keys.pop(id, None)


@pytest.fixture
def wc(make_client, fake_workos):
    fake_workos.api_keys = FakeApiKeys()
    return make_client(**workos_settings())


def sign_in(client, sub: str, org: str, perms: list[str], *, auth_age: float | None = 30) -> None:
    from workos.session import seal_session_from_auth_response

    t = int(time.time())
    claims: dict[str, Any] = {"sub": sub, "sid": "session_1", "iat": t, "exp": t + 300, "permissions": perms, "org_id": org, "role": "admin"}
    if auth_age is not None:
        claims["auth_time"] = int(t - auth_age)
    tok = jwt.encode(claims, KEY, algorithm="RS256", headers={"kid": "test"})
    sealed = seal_session_from_auth_response(access_token=tok, refresh_token="rt_1", user=user(sub), impersonator=None, cookie_password=COOKIE_PASSWORD)
    client.cookies.set(session_cookie_name(), sealed, domain="testserver.local")


def _create(wc, scopes=("datasets:read",)) -> tuple[dict, str]:
    r = wc.post("/api/v1/org/api-keys", json={"name": "MCP", "expiresInDays": None, "scopes": list(scopes)}, headers=FETCH)
    assert r.status_code == 200, r.text
    return r.json()["key"], r.json()["secret"]


def test_workos_create_list_and_use_a_key(wc, fake_workos):
    sign_in(wc, "user_A", "org_W1", ADMIN_PERMS)
    with db.session_scope() as d:
        bootstrap.upsert_user(d, user("user_A"))
    pid = wc.post("/api/v1/projects", json={"title": "P"}, headers=FETCH).json()["id"]
    key, secret = _create(wc, ("datasets:read", "studio:tools"))
    k = fake_workos.api_keys.keys[key["id"]]
    assert k["org"] == "org_W1" and k["permissions"] == ["datasets:read", "studio:tools"] and secret == k["value"]
    assert key["createdBy"] == "Ada Lovelace" and secret not in key["prefix"]
    listed = wc.get("/api/v1/org/api-keys").json()["keys"]
    assert [x["id"] for x in listed] == [key["id"]] and listed[0]["createdBy"] == "Ada Lovelace" and listed[0]["lastUsedAt"] is None

    wc.cookies.clear()
    assert wc.get(f"/api/v1/workspaces/{pid}/state", headers=bearer(secret)).status_code == 200
    assert wc.get(f"/api/v1/projects/{pid}", headers=bearer(secret)).status_code == 200
    assert fake_workos.api_keys.validations == 1  # the second call came from the cache
    # A JWT or a dev key never goes to WorkOS.
    assert wc.get("/api/v1/projects", headers=bearer("a.b.c")).status_code == 401
    assert wc.get("/api/v1/projects", headers=bearer(api_keys.dev_prefix() + "x")).status_code == 401
    assert fake_workos.api_keys.validations == 1
    sign_in(wc, "user_A", "org_W1", ADMIN_PERMS)
    assert wc.get("/api/v1/org/api-keys").json()["keys"][0]["lastUsedAt"]
    with db.session_scope() as d:
        assert [e.action for e in d.scalars(select(AuditEvent).where(AuditEvent.action.like("api_key.%")))] == ["api_key.created"]


def test_workos_key_revoked_elsewhere_stops_after_the_cache_expires(wc, fake_workos, monkeypatch):
    sign_in(wc, "user_A", "org_W1", ADMIN_PERMS)
    pid = wc.post("/api/v1/projects", json={"title": "P"}, headers=FETCH).json()["id"]
    key, secret = _create(wc)
    wc.cookies.clear()
    assert wc.get(f"/api/v1/projects/{pid}", headers=bearer(secret)).status_code == 200
    fake_workos.api_keys.keys.pop(key["id"])  # revoked in the WorkOS dashboard
    assert wc.get(f"/api/v1/projects/{pid}", headers=bearer(secret)).status_code == 200  # cached
    later = time.time() + api_keys.CACHE_TTL_S + 1
    monkeypatch.setattr(api_keys, "_clock", lambda: later)
    assert wc.get(f"/api/v1/projects/{pid}", headers=bearer(secret)).status_code == 401
    assert fake_workos.api_keys.validations == 2


def test_workos_revoke_through_the_api_is_immediate_here(wc, fake_workos):
    sign_in(wc, "user_A", "org_W1", ADMIN_PERMS)
    key, secret = _create(wc)
    assert wc.get("/api/v1/projects", headers=bearer(secret)).status_code == 200
    assert wc.delete(f"/api/v1/org/api-keys/{key['id']}", headers=FETCH).status_code == 204
    assert fake_workos.api_keys.calls == ["create", "delete"]
    assert wc.get("/api/v1/projects", headers=bearer(secret)).status_code == 401
    assert wc.delete("/api/v1/org/api-keys/api_key_404", headers=FETCH).status_code == 404
    with db.session_scope() as d:
        assert [e.action for e in d.scalars(select(AuditEvent).where(AuditEvent.action.like("api_key.%")).order_by(AuditEvent.at))] == ["api_key.created", "api_key.revoked"]


def test_workos_step_up_and_permission_gate(wc, fake_workos):
    sign_in(wc, "user_A", "org_W1", ADMIN_PERMS, auth_age=3600)
    r = wc.post("/api/v1/org/api-keys", json={"name": "k", "expiresInDays": 7, "scopes": ["admin"]}, headers=FETCH)
    assert r.status_code == 403 and r.json()["detail"] == "step_up_required"
    url = urlsplit(r.json()["loginUrl"])
    assert url.path == "/api/auth/login" and parse_qs(url.query) == {"max_age": ["600"], "return_to": ["/organization/api-keys"]}
    sign_in(wc, "user_A", "org_W1", ADMIN_PERMS, auth_age=None)
    assert wc.post("/api/v1/org/api-keys", json={"name": "k", "expiresInDays": 7, "scopes": ["admin"]}, headers=FETCH).json()["detail"] == "step_up_required"
    assert fake_workos.api_keys.calls == []
    # The login URL carries max_age through to AuthKit.
    wc.get(r.json()["loginUrl"], follow_redirects=False)
    assert [kw for n, kw in fake_workos.calls if n == "authorize"][-1]["max_age"] == 600
    # Members without apikeys:manage get 403 on every route.
    sign_in(wc, "user_B", "org_W1", MEMBER_PERMS)
    assert wc.get("/api/v1/org/api-keys").status_code == 403
    assert wc.post("/api/v1/org/api-keys", json={"name": "k", "expiresInDays": None, "scopes": ["admin"]}, headers=FETCH).status_code == 403
    assert wc.delete("/api/v1/org/api-keys/api_key_1", headers=FETCH).status_code == 403
