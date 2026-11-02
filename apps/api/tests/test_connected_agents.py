"""todo17 D12: token scopes, outside agents' OAuth tokens, Settings › Connected agents, destroy approvals."""

from __future__ import annotations

import time
import uuid

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy import select

from studio_api import db
from studio_api.auth import api_keys, oauth
from studio_api.auth import scopes as sc
from studio_api.context import AUTH_API_KEY, AUTH_COOKIE, AUTH_OAUTH, AUTH_TOKEN, RequestContext
from studio_api.kernel import tree
from studio_api.kernel.admission import Operation, PermissionDenied, admit
from studio_api.kernel.admission.http import admission_ctx, idempotency_principal
from studio_api.models import AgentConnection, AuditEvent, FsBatch, PluginAudit


@pytest.fixture(autouse=True)
def _fresh_cache():
    api_keys.forget()
    yield
    api_keys.forget()


def token(c, scopes, name="Claude Code", who="user:local-expert", **extra):
    r = c.post("/api/v1/dev/oauth/tokens", json={"clientName": name, "scopes": scopes, **extra}, headers={"X-Dev-Principal": who})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['accessToken']}"}


def project(c) -> str:
    return c.post("/api/v1/projects", json={"title": "P"}).json()["id"]


def mkdir(c, pid, name, headers):
    return c.post(f"/api/v1/projects/{pid}/fs/ops", json={"ops": [{"kind": "mkdir", "parentId": tree.drive_root_id(pid), "name": name}]}, headers=headers)


# ---- Scope mapping ------------------------------------------------------------------------------


def test_old_key_scopes_map_to_tiers_and_keep_their_kernel_scopes():
    assert sc.tier_scopes(["datasets:read"]) == ("project:read",)
    assert sc.tier_scopes(["annotations:write"]) == ("project:read", "project:write")
    assert sc.tier_scopes(["studio:tools"]) == ("project:read", "project:write")
    assert sc.tier_scopes(["admin"]) == sc.SCOPES
    assert sc.tier_scopes(["project:destroy"]) == ("project:read", "project:destroy")  # any project:* reads
    legacy = api_keys.kernel_scopes(["annotations:write"])
    assert "project:write" in legacy and "annotations.write" in legacy and "environments.write" not in legacy  # unchanged kernel access
    new = api_keys.kernel_scopes(["project:write"])
    assert {"project:read", "project:write", "environments.write", "annotations.write", "project.write"} <= set(new)
    assert "project:read" in api_keys.kernel_scopes(["datasets:read"]) and "annotations.write" not in api_keys.kernel_scopes(["datasets:read"])


def test_route_tiers_come_from_the_catalogue():
    assert sc.route_tier("DELETE", "/api/v1/projects/{project_id}/trash/{batch_id}", default_by_method=False) == "destroy"
    assert sc.route_tier("POST", "/api/v1/projects/{project_id}/trash/empty", default_by_method=False) == "destroy"
    assert sc.route_tier("DELETE", "/api/v1/projects/{project_id}/datasets/{item_id}", default_by_method=False) == "trash"
    assert sc.route_tier("POST", "/api/v1/projects/{project_id}/fs/ops", default_by_method=False) == "write"
    assert sc.route_tier("GET", "/api/v1/projects/{project_id}/overview", default_by_method=False) == "read"
    assert sc.route_tier("PUT", "/api/v1/projects/{project_id}/rules", default_by_method=False) == "rules"
    assert sc.route_tier("GET", "/api/v1/nowhere", default_by_method=False) is None
    assert sc.route_tier("POST", "/api/v1/nowhere", default_by_method=True) == "write"


def test_new_keys_use_tier_scopes_and_get_insufficient_scope(client):
    pid = project(client)
    r = client.post("/api/v1/org/api-keys", json={"name": "reader", "expiresInDays": 30, "scopes": ["project:read"]})
    assert r.status_code == 200, r.text
    key = {"Authorization": f"Bearer {r.json()['secret']}"}
    assert client.get(f"/api/v1/projects/{pid}/overview", headers=key).status_code == 200
    r = client.post(f"/api/v1/projects/{pid}/trash/empty", headers=key)
    assert r.status_code == 403 and r.json()["error"] == "insufficient_scope" and r.json()["scope"] == "project:destroy"
    assert 'error="insufficient_scope"' in r.headers["WWW-Authenticate"] and 'scope="project:destroy"' in r.headers["WWW-Authenticate"]
    old = client.post("/api/v1/org/api-keys", json={"name": "old", "expiresInDays": 30, "scopes": ["datasets:read"]}).json()["secret"]
    r = mkdir(client, pid, "x", {"Authorization": f"Bearer {old}"})
    assert r.status_code == 403 and r.json()["scope"] == "project:write"


# ---- OAuth tokens -------------------------------------------------------------------------------


def test_oauth_token_reads_and_writes_as_the_agent_on_behalf_of_the_person(client):
    pid = project(client)
    reader = token(client, ["project:read"])
    assert client.get(f"/api/v1/projects/{pid}/overview", headers=reader).status_code == 200
    r = mkdir(client, pid, "scans", reader)
    assert r.status_code == 403, r.text
    assert r.json() == {"error": "insufficient_scope", "scope": "project:write", "detail": r.json()["detail"], "status": 403}

    writer = token(client, ["project:read", "project:write"])
    r = mkdir(client, pid, "scans", writer)
    assert r.status_code == 200, r.text
    with db.session_scope() as d:
        # The audit trail names the agent and the person; the undo journal stays the person's (todo16 D9).
        row = d.scalars(select(PluginAudit).where(PluginAudit.workspace_id == pid, PluginAudit.action == "files.created")).all()[-1]
        assert (row.actor_id, row.on_behalf_of) == ("agent:Claude Code", "user:local-expert")
        assert d.scalars(select(FsBatch).where(FsBatch.project_id == pid)).all()[-1].on_behalf_of == "user:local-expert"

    # Trash needs project:trash, on the fs route too (the body's op kind).
    r = client.post(f"/api/v1/projects/{pid}/fs/ops", json={"ops": [{"kind": "trash", "nodeIds": ["x"]}]}, headers=writer)
    assert r.status_code == 403 and r.json()["scope"] == "project:trash"


def test_a_stranger_project_is_404_and_org_admin_is_refused(client):
    other = client.post("/api/v1/projects", json={"title": "Bob's"}, headers={"X-Dev-Principal": "user:bob"}).json()["id"]
    t = token(client, ["project:read", "project:write"])
    assert client.get(f"/api/v1/projects/{other}/overview", headers=t).status_code == 404
    assert client.get("/api/v1/org/api-keys", headers=t).status_code == 403  # people only (agent route allowlist)
    assert client.get("/api/v1/me/connected-agents", headers=t).status_code == 403


def test_bad_tokens_are_401_with_www_authenticate(client):
    pid = project(client)
    t = int(time.time())
    base = {"iss": "dev", "aud": "mcp-dev", "sub": "local-expert", "client_id": "c", "scope": "project:read", "iat": t, "exp": t + 60}
    for claims, key in [({**base, "aud": "elsewhere"}, "test-secret-key"), ({**base, "exp": t - 60}, "test-secret-key"), (base, "wrong-key")]:
        r = client.get(f"/api/v1/projects/{pid}/overview", headers={"Authorization": f"Bearer {jwt.encode(claims, key, algorithm='HS256')}"})
        assert r.status_code == 401, (claims, r.text)
        assert r.headers["WWW-Authenticate"].startswith('Bearer error="invalid_token"')


def test_connected_agent_listed_and_revoked(client):
    pid = project(client)
    t = token(client, ["project:read", "project:write"], name="Cursor")
    assert client.get(f"/api/v1/projects/{pid}/overview", headers=t).status_code == 200
    agents = client.get("/api/v1/me/connected-agents").json()["agents"]
    assert [(a["clientName"], a["scopes"]) for a in agents] == [("Cursor", ["project:read", "project:write"])]
    assert agents[0]["lastUsedAt"] and agents[0]["createdAt"]
    assert client.get("/api/v1/me/connected-agents", headers={"X-Dev-Principal": "user:bob"}).json()["agents"] == []
    assert client.delete(f"/api/v1/me/connected-agents/{agents[0]['id']}", headers={"X-Dev-Principal": "user:bob"}).status_code == 404

    assert client.delete(f"/api/v1/me/connected-agents/{agents[0]['id']}").status_code == 204
    r = client.get(f"/api/v1/projects/{pid}/overview", headers=t)
    assert r.status_code == 401 and 'error="invalid_token"' in r.headers["WWW-Authenticate"] and "revoked" in r.headers["WWW-Authenticate"]
    assert client.get("/api/v1/me/connected-agents").json()["agents"] == []
    with db.session_scope() as d:
        assert d.scalar(select(AuditEvent).where(AuditEvent.action == "agent.revoked")).target == agents[0]["id"]

    # Signing the agent in again later makes a new connection.
    with db.session_scope() as d:
        row = d.get(AgentConnection, agents[0]["id"])
        row.revoked_at = row.revoked_at.replace(year=2020)
    assert client.get(f"/api/v1/projects/{pid}/overview", headers=token(client, ["project:read"], name="Cursor")).status_code == 200
    assert len(client.get("/api/v1/me/connected-agents").json()["agents"]) == 1


def test_destroy_is_202_with_an_approval_link_then_needs_the_person(client):
    pid = project(client)
    assert client.post(f"/api/v1/projects/{pid}/trash/empty", headers=token(client, ["project:write", "project:trash"])).json()["scope"] == "project:destroy"
    agent = token(client, ["project:read", "project:write", "project:trash", "project:destroy"])
    r = client.post(f"/api/v1/projects/{pid}/trash/empty", headers=agent)
    assert r.status_code == 202, r.text
    a = r.json()["approval"]
    assert a["state"] == "pending" and a["operation"] == "trash.empty" and a["projectId"] == pid and a["url"].endswith(f"/approvals/{a['id']}")
    assert r.headers["Location"] == f"/api/v1/approvals/{a['id']}"
    assert client.get(f"/api/v1/approvals/{a['id']}", headers=agent).json()["state"] == "pending"

    # Not approved yet; the agent can't approve it; another person can't see it.
    assert client.post(f"/api/v1/projects/{pid}/trash/empty", headers={**agent, "X-Approval-Id": a["id"]}).status_code == 403
    assert client.post(f"/api/v1/approvals/{a['id']}/approve", headers=agent).status_code == 403
    assert client.post(f"/api/v1/approvals/{a['id']}/approve", headers={"X-Dev-Principal": "user:bob"}).status_code == 404

    assert client.post(f"/api/v1/approvals/{a['id']}/approve").json()["state"] == "approved"
    r = client.post(f"/api/v1/projects/{pid}/trash/empty", headers={**agent, "X-Approval-Id": a["id"]})
    assert r.status_code == 200, r.text
    assert client.post(f"/api/v1/projects/{pid}/trash/empty", headers={**agent, "X-Approval-Id": a["id"]}).status_code == 403  # single use
    # Another agent of the same person can't use it.
    other = token(client, ["project:destroy"], name="Other")
    assert client.post(f"/api/v1/projects/{pid}/trash/empty", headers={**other, "X-Approval-Id": a["id"]}).status_code == 403


def test_rs256_tokens_from_the_configured_issuer(make_client, monkeypatch):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    monkeypatch.setattr(oauth, "signing_key", lambda _t: key.public_key())
    c = make_client(oauth_issuer="https://auth.example.test", oauth_audience="https://mcp.example.test")
    pid = project(c)
    t = int(time.time())
    claims = {"iss": "https://auth.example.test", "aud": "https://mcp.example.test", "sub": "local-expert", "client_id": "client_01", "client_name": "Claude Code", "scope": "openid project:read", "iat": t, "exp": t + 300, "jti": uuid.uuid4().hex}
    good = jwt.encode(claims, key, algorithm="RS256")
    assert c.get(f"/api/v1/projects/{pid}/overview", headers={"Authorization": f"Bearer {good}"}).status_code == 200
    bad_iss = jwt.encode({**claims, "iss": "https://evil.test"}, key, algorithm="RS256")
    r = c.get(f"/api/v1/projects/{pid}/overview", headers={"Authorization": f"Bearer {bad_iss}"})
    assert r.status_code == 401 and 'resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource"' in r.headers["WWW-Authenticate"]
    # The dev minter's audience follows the config; HS256 tokens still work in dev mode.
    assert c.get(f"/api/v1/projects/{pid}/overview", headers=token(c, ["project:read"])).status_code == 200


# ---- Idempotency principal and admission scopes -----------------------------------------------


def _ctx(**kw) -> RequestContext:
    return RequestContext("w", kw.pop("principal", "user:a"), "corr", **kw)


def test_idempotency_principal_is_the_authenticated_caller():
    assert idempotency_principal(_ctx(auth=AUTH_COOKIE)) == "user:a"
    assert idempotency_principal(_ctx(principal="apikey:key_1", scopes=("apikey",), auth=AUTH_API_KEY)) == "apikey:key_1"
    oa = _ctx(principal="agent:Claude Code", scopes=("oauth", "project:write"), on_behalf_of="user:a", auth=AUTH_OAUTH, token_hash="conn:agc_1")
    assert idempotency_principal(oa) == "conn:agc_1"
    assert idempotency_principal(_ctx(principal="agent:run", scopes=("*",), auth=AUTH_TOKEN, token_hash="abc")) == "token:abc"


def test_admission_permit_uses_the_tokens_tier_scopes():
    op = Operation(id="test.write", scope="project:write")
    reader = _ctx(principal="agent:x", scopes=("oauth", "project:read"), on_behalf_of="user:a", auth=AUTH_OAUTH, token_hash="conn:1")
    with pytest.raises(PermissionDenied):
        admit(op, {}, admission_ctx(reader))
    writer = _ctx(principal="apikey:k", scopes=api_keys.kernel_scopes(["annotations:write"]), auth=AUTH_API_KEY)
    assert admit(op, {}, admission_ctx(writer)).value == {}
    assert admission_ctx(_ctx(auth=AUTH_COOKIE)).scopes is None
