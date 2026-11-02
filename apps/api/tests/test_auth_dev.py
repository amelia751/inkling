"""todo9: dev mode keeps today's identity; workos-mode settings fail fast; permissions and revocation."""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import select

from studio_api import config, db
from studio_api.auth.permissions import PERMISSIONS
from studio_api.auth.session import revoke_sessions_for
from studio_api.context import AUTH_COOKIE, AUTH_TOKEN, RequestContext
from studio_api.models import SessionDelegation, SessionToken

from .auth_fakes import REDIRECT

FETCH = {"X-Requested-With": "fetch"}


def test_dev_session_is_the_dev_identity_with_every_permission(client):
    s = client.get("/api/auth/session").json()
    assert s["mode"] == "dev" and s["user"]["id"] == "user:local-expert" and s["user"]["name"] == "Local Expert"
    assert set(s["permissions"]) == set(PERMISSIONS) and s["role"] == "admin"
    assert s["organization"]["name"] == "Personal" and {o["name"] for o in s["organizations"]} == {"Personal", "Samples"}
    other = client.get("/api/auth/session", headers={"X-Dev-Principal": "user:bob"}).json()
    assert other["user"]["id"] == "user:bob"
    # The routes all answer in dev mode, so the web can always call them.
    assert client.post("/api/auth/switch-org", json={"organizationId": s["organization"]["id"]}, headers=FETCH).json() == {"ok": True}
    assert client.post("/api/auth/switch-org", json={"organizationId": "org-nope"}, headers=FETCH).status_code == 404
    assert client.post("/api/auth/logout", headers=FETCH).json() == {"url": "/"}
    assert client.get("/api/auth/login", params={"return_to": "/p"}, follow_redirects=False).headers["location"] == "/p"
    assert client.get("/api/auth/verify").status_code == 200


def test_dev_mode_keeps_samples_and_personal_projects(client):
    projects = client.get("/api/v1/projects").json()["projects"]
    assert {p["id"] for p in projects} >= {"ws-a", "ws-b"}  # the seeds, via the shared Samples org
    assert {p["role"] for p in projects} == {"annotator"}
    pid = client.post("/api/v1/projects", json={"title": "Mine"}).json()["id"]
    assert client.get(f"/api/v1/projects/{pid}").json()["role"] == "owner"
    assert client.get(f"/api/v1/projects/{pid}", headers={"X-Dev-Principal": "user:bob"}).status_code == 404


def _settings(tmp_path, **kw):
    return config.load_settings(database_url="sqlite:///:memory:", data_dir=tmp_path, secret_key="k", **kw)


def test_workos_mode_requires_its_keys_and_a_fernet_cookie_password(tmp_path):
    with pytest.raises(config.SettingsError) as e:
        # Explicit Nones: a developer's secrets/workos.env overlay must not fill them in.
        _settings(tmp_path, auth_mode="workos", workos_api_key=None, workos_client_id=None, workos_cookie_password=None, workos_redirect_uri=None)
    assert {"STUDIO_API_WORKOS_API_KEY", "STUDIO_API_WORKOS_CLIENT_ID", "STUDIO_API_WORKOS_COOKIE_PASSWORD", "STUDIO_API_WORKOS_REDIRECT_URI"} <= set(e.value.missing)
    keys = {"workos_api_key": "sk_test_secret_value", "workos_client_id": "client_x", "workos_redirect_uri": REDIRECT}
    with pytest.raises(config.SettingsError) as e:
        _settings(tmp_path, auth_mode="workos", workos_cookie_password="a-plain-password-of-32-characters", **keys)
    assert e.value.invalid == ["STUDIO_API_WORKOS_COOKIE_PASSWORD"] and "Fernet" in str(e.value)
    assert "a-plain-password" not in str(e.value) and "sk_test_secret_value" not in str(e.value)
    good = Fernet.generate_key().decode()
    with pytest.raises(config.SettingsError) as e:
        _settings(tmp_path, auth_mode="workos", workos_cookie_password=good, dev_trust_headers="1", **keys)
    assert "STUDIO_API_DEV_TRUST_HEADERS" in e.value.invalid
    s = _settings(tmp_path, auth_mode="workos", workos_cookie_password=good, **keys)
    assert s.workos and not s.dev_trust_headers
    assert _settings(tmp_path).auth_mode == "dev"


def test_can_combines_the_users_permissions_and_the_tokens_scopes():
    dev = RequestContext("w", "user:a", "c")
    assert dev.can("org:manage")
    person = RequestContext("w", "user:a", "c", permissions=("project:create",), auth=AUTH_COOKIE)
    assert person.can("project:create") and not person.can("members:manage")
    agent = RequestContext("w", "agent:b", "c", scopes=("annotations.write",), on_behalf_of="user:a", permissions=("members:manage",), auth=AUTH_TOKEN)
    assert not agent.can("members:manage")  # the user may, the token isn't scoped for it
    broad = RequestContext("w", "agent:b", "c", scopes=("*",), on_behalf_of="user:a", permissions=("members:manage",), auth=AUTH_TOKEN)
    assert broad.can("members:manage") and not broad.can("org:manage")


def test_revoke_sessions_for_deletes_the_users_agent_tokens(client):
    pid = client.post("/api/v1/projects", json={"title": "P"}).json()["id"]
    tok = client.post("/api/v1/sessions", json={"scopes": ["*"]}, headers={"X-Workspace-Id": pid}).json()["token"]
    client.post("/api/v1/sessions", json={"scopes": ["*"]}, headers={"X-Workspace-Id": pid, "X-Dev-Principal": "user:bob"})
    assert client.get(f"/api/v1/projects/{pid}", headers={"Authorization": f"Bearer {tok}"}).status_code == 200
    with db.session_scope() as d:
        dlg = d.scalar(select(SessionDelegation).where(SessionDelegation.on_behalf_of == "user:local-expert"))
        assert dlg.permissions == ["*"] and dlg.org_id is None
        assert revoke_sessions_for(d, "user:local-expert", "org-x") == 1
    assert client.get(f"/api/v1/projects/{pid}", headers={"Authorization": f"Bearer {tok}"}).status_code == 401
    with db.session_scope() as d:
        assert [r.on_behalf_of for r in d.scalars(select(SessionDelegation))] == ["user:bob"]
        assert d.scalar(select(SessionToken).where(SessionToken.principal == "agent:builder")) is not None


def test_versioning_jwt_names_the_signed_in_user_and_their_org(client):
    from studio_api.kernel.versioning import auth as vauth

    person = RequestContext("ws-a", "user:user_01ABC", "cid", org_id="org-1", auth=AUTH_COOKIE)
    claims = vauth.decode_unverified(vauth.mint(person, [vauth.READ]))
    assert claims["actor"] == {"id": "user:user_01ABC", "kind": "user"} and claims["org"] == "org-1"
    agent = RequestContext("ws-a", "agent:builder", "cid", scopes=("*",), on_behalf_of="user:user_01ABC", org_id="org-1", auth=AUTH_TOKEN)
    assert vauth.decode_unverified(vauth.mint(agent, [vauth.READ]))["actor"]["on_behalf_of"] == "user:user_01ABC"
    assert "org" not in vauth.decode_unverified(vauth.mint(RequestContext("ws-a", "user:local-expert", "cid"), [vauth.READ]))


def test_current_org_is_the_signed_in_org_or_the_dev_personal_org(client):
    from studio_api.auth import current_org
    from studio_api.kernel.projects import personal_org_id

    with db.session_scope() as d:
        assert current_org(d, RequestContext("w", "user:local-expert", "c")) == personal_org_id("user:local-expert")
        assert current_org(d, RequestContext("w", "user:x", "c", org_id="org-1", auth=AUTH_COOKIE)) == "org-1"
