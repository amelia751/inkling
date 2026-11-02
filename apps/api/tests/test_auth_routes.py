"""todo9 Phase 3: sign-in, session, refresh, CSRF and the org boundary against a fake WorkOS."""

from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

import pytest
from sqlalchemy import select

from studio_api import db
from studio_api.auth.cookie import session_cookie_name, state_cookie_name
from studio_api.models import AuditEvent, Organization, OrganizationMember, ProjectMember, SessionDelegation, User

from .auth_fakes import ADMIN_PERMS, FETCH, MEMBER_PERMS, signed_in, workos_settings

pytestmark = pytest.mark.usefixtures("fake_workos")


@pytest.fixture
def wclient(make_client):
    return make_client(**workos_settings())


def _set_cookie_headers(r) -> list[str]:
    return [v for k, v in r.headers.multi_items() if k.lower() == "set-cookie"]


def _cleared(r, name: str) -> bool:
    return any(h.startswith(f"{name}=") and ("Max-Age=0" in h or 'expires=Thu, 01 Jan 1970' in h.lower() or "max-age=0" in h.lower()) for h in _set_cookie_headers(r))


def test_login_redirects_with_pkce_and_signed_state(wclient, fake_workos):
    r = wclient.get("/api/auth/login", params={"return_to": "//evil.example/x"}, follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"].startswith("https://auth.example.test/authorize?")
    q = parse_qs(urlsplit(r.headers["location"]).query)
    assert q["provider"] == ["authkit"] and q["code_challenge_method"] == ["S256"] and q["redirect_uri"] == ["http://localhost:5173/api/auth/callback"]
    assert wclient.cookies.get(state_cookie_name())


def test_full_sign_in_creates_an_empty_personal_org(wclient, fake_workos):
    r = wclient.get("/api/auth/login", params={"return_to": "/projects"}, follow_redirects=False)
    state = parse_qs(urlsplit(r.headers["location"]).query)["state"][0]
    r = wclient.get("/api/auth/callback", params={"code": "c1", "state": state}, follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/projects", r.text
    assert wclient.cookies.get(session_cookie_name())
    # No org in the first token: a personal WorkOS org with the person as admin, then a refresh into it.
    assert fake_workos.count("create_org") == 1 and fake_workos.count("create_membership") == 1 and fake_workos.count("refresh") == 1
    s = wclient.get("/api/auth/session").json()
    assert s["mode"] == "workos" and s["user"]["id"] == "user:user_A" and s["user"]["email"] == "user_A@example.com"
    assert s["organization"]["workosOrgId"] == "org_P1" and s["organization"]["name"] == "Personal"
    assert set(s["permissions"]) == set(ADMIN_PERMS) and s["expiresAt"]
    # Empty: no Samples membership in workos mode (todo14 D2).
    assert wclient.get("/api/v1/projects").json()["projects"] == []
    with db.session_scope() as d:
        assert d.get(User, "user:user_A").email == "user_a@example.com"
        org = d.scalar(select(Organization).where(Organization.workos_org_id == "org_P1"))
        assert org.kind == "personal"
        assert [m.principal for m in d.scalars(select(OrganizationMember).where(OrganizationMember.org_id == org.id))] == ["user:user_A"]
        assert d.scalar(select(OrganizationMember).where(OrganizationMember.org_id == "org-samples")) is None
        assert [e.action for e in d.scalars(select(AuditEvent))] == ["auth.signed_in"]


def test_callback_error_and_tampered_state(wclient, fake_workos):
    r = wclient.get("/api/auth/callback", params={"error": "access_denied", "error_description": "The user denied access"})
    assert r.status_code == 400 and "denied" in r.json()["detail"]
    wclient.get("/api/auth/login", follow_redirects=False)
    good = wclient.cookies.get(state_cookie_name())
    assert wclient.get("/api/auth/callback", params={"code": "c1", "state": "not-the-state"}).status_code == 400
    # A state cookie that was edited fails its signature, whatever state the URL carries.
    payload, mac = good.rsplit(".", 1)
    wclient.cookies.set(state_cookie_name(), payload[:-2] + "AA." + mac, domain="testserver.local", path="/api/auth")
    assert wclient.get("/api/auth/callback", params={"code": "c1", "state": "x"}).status_code == 400
    assert fake_workos.count("code") == 0


def test_expired_access_token_refreshes_and_rewrites_the_cookie(wclient, fake_workos):
    signed_in(wclient, "user_A", "org_W1", ADMIN_PERMS, ttl=-60)
    before = wclient.cookies.get(session_cookie_name())
    r = wclient.get("/api/v1/projects")
    assert r.status_code == 200, r.text
    assert fake_workos.count("refresh") == 1
    assert any(h.startswith(f"{session_cookie_name()}=") for h in _set_cookie_headers(r))
    assert wclient.cookies.get(session_cookie_name()) != before
    # The rotated cookie works without another refresh.
    assert wclient.get("/api/v1/projects").status_code == 200 and fake_workos.count("refresh") == 1


def test_invalid_grant_signs_out(wclient, fake_workos):
    from workos._errors import BadRequestError

    fake_workos.refresh_error = BadRequestError("invalid grant", error="invalid_grant")
    signed_in(wclient, "user_A", "org_W1", ADMIN_PERMS, ttl=-60)
    r = wclient.get("/api/v1/projects")
    assert r.status_code == 401 and _cleared(r, session_cookie_name())


@pytest.mark.parametrize("error", ["server", "rate", "network"])
def test_transient_refresh_errors_keep_the_session(wclient, fake_workos, error):
    from workos._errors import RateLimitExceededError, ServerError, WorkOSConnectionError

    fake_workos.refresh_error = {"server": ServerError("boom"), "rate": RateLimitExceededError("slow down"), "network": WorkOSConnectionError()}[error]
    signed_in(wclient, "user_A", "org_W1", ADMIN_PERMS, ttl=-60)
    r = wclient.get("/api/v1/projects")
    assert r.status_code == 503 and not _set_cookie_headers(r)


def test_garbage_cookie_and_no_cookie_are_401(wclient):
    assert wclient.get("/api/v1/projects").status_code == 401
    assert wclient.get("/api/auth/session").status_code == 401
    wclient.cookies.set(session_cookie_name(), "not-a-sealed-session")
    r = wclient.get("/api/v1/projects")
    assert r.status_code == 401 and _cleared(r, session_cookie_name())


def test_trusted_dev_headers_are_ignored_in_workos_mode(wclient):
    assert wclient.get("/api/v1/projects", headers={"X-Dev-Principal": "user:local-expert"}).status_code == 401


def test_csrf_header_required_for_cookie_writes(wclient):
    signed_in(wclient, "user_A", "org_W1", ADMIN_PERMS)
    assert wclient.post("/api/v1/projects", json={"title": "P"}).status_code == 403
    assert wclient.post("/api/v1/projects", json={"title": "P"}, headers=FETCH).status_code == 201


def test_org_boundary_and_project_members(wclient):
    signed_in(wclient, "user_A", "org_W1", ADMIN_PERMS)
    pid = wclient.post("/api/v1/projects", json={"title": "Org one"}, headers=FETCH).json()["id"]
    assert wclient.get(f"/api/v1/projects/{pid}").json()["role"] == "owner"
    with db.session_scope() as d:
        assert d.get(ProjectMember, (pid, "user:user_A")).role == "owner"
    # The same person, signed into another organization: the project doesn't exist there.
    signed_in(wclient, "user_A", "org_W2", ADMIN_PERMS)
    assert wclient.get(f"/api/v1/projects/{pid}").status_code == 404
    assert wclient.get(f"/api/v1/projects/{pid}/datasets").status_code == 404
    assert pid not in [p["id"] for p in wclient.get("/api/v1/projects").json()["projects"]]
    # A plain member of org one sees only the projects they're a member of.
    signed_in(wclient, "user_B", "org_W1", MEMBER_PERMS)
    assert wclient.get(f"/api/v1/projects/{pid}").status_code == 404
    assert wclient.get("/api/v1/projects").json()["projects"] == []
    with db.session_scope() as d:
        d.add(ProjectMember(project_id=pid, principal="user:user_B", role="viewer"))
    assert wclient.get(f"/api/v1/projects/{pid}").json()["role"] == "viewer"
    assert wclient.patch(f"/api/v1/projects/{pid}", json={"title": "x"}, headers=FETCH).status_code == 403
    # Members without project:create can't make projects.
    signed_in(wclient, "user_C", "org_W1", [])
    assert wclient.post("/api/v1/projects", json={"title": "P"}, headers=FETCH).status_code == 403


def test_agent_token_minted_with_the_cookie_acts_for_the_user(wclient):
    signed_in(wclient, "user_A", "org_W1", ADMIN_PERMS)
    pid = wclient.post("/api/v1/projects", json={"title": "P"}, headers=FETCH).json()["id"]
    r = wclient.post("/api/v1/sessions", json={"agent": "builder", "scopes": ["*"]}, headers={**FETCH, "X-Workspace-Id": pid})
    assert r.status_code == 200, r.text
    tok = r.json()["token"]
    with db.session_scope() as d:
        dlg = d.scalar(select(SessionDelegation))
        assert dlg.on_behalf_of == "user:user_A" and dlg.permissions == ADMIN_PERMS and dlg.org_id
    wclient.cookies.clear()
    agent = {"Authorization": f"Bearer {tok}"}
    assert wclient.get(f"/api/v1/projects/{pid}", headers=agent).status_code == 200
    # The agent can't reach a project of another organization, even one its user owns.
    signed_in(wclient, "user_A", "org_W2", ADMIN_PERMS)
    other = wclient.post("/api/v1/projects", json={"title": "Q"}, headers=FETCH).json()["id"]
    wclient.cookies.clear()
    assert wclient.get(f"/api/v1/projects/{other}", headers=agent).status_code == 404


def test_logout_needs_the_csrf_header_and_clears_the_cookie(wclient, fake_workos):
    signed_in(wclient, "user_A", "org_W1", ADMIN_PERMS)
    assert wclient.post("/api/auth/logout").status_code == 403
    r = wclient.post("/api/auth/logout", headers=FETCH)
    assert r.status_code == 200 and r.json()["url"].startswith("https://auth.example.test/logout?session_id=session_1")
    assert _cleared(r, session_cookie_name())
    with db.session_scope() as d:
        assert [e.action for e in d.scalars(select(AuditEvent))] == ["auth.signed_out"]


def test_switch_org_refreshes_into_the_org_or_asks_to_sign_in(wclient, fake_workos):
    from workos._errors import SsoRequiredError

    signed_in(wclient, "user_A", "org_W1", ADMIN_PERMS)
    with db.session_scope() as d:
        d.add(Organization(id="org-two", name="Two", kind="team", workos_org_id="org_W2"))
    r = wclient.post("/api/auth/switch-org", json={"organizationId": "org-two"}, headers=FETCH)
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert fake_workos.calls[-1][1]["organization_id"] == "org_W2"
    assert wclient.get("/api/auth/session").json()["organization"]["id"] == "org-two"
    fake_workos.refresh_error = SsoRequiredError("sso required")
    r = wclient.post("/api/auth/switch-org", json={"organizationId": "org-two"}, headers=FETCH)
    assert r.status_code == 200 and r.json()["redirect"].startswith("/api/auth/login?organization_id=org-two")
    assert wclient.post("/api/auth/switch-org", json={"organizationId": "nope"}, headers=FETCH).status_code == 404
    with db.session_scope() as d:
        assert "auth.org_switched" in [e.action for e in d.scalars(select(AuditEvent))]


def test_verify_hands_nginx_the_access_token(wclient):
    assert wclient.get("/api/auth/verify").status_code == 401
    signed_in(wclient, "user_A", "org_W1", ADMIN_PERMS)
    r = wclient.get("/api/auth/verify")
    assert r.status_code == 200 and r.headers["X-Access-Token"].count(".") == 2


def test_readyz_checks_the_jwks_in_workos_mode(wclient, monkeypatch):
    from studio_api.auth import client as wc

    monkeypatch.setattr(wc, "jwks_ready", lambda: None)
    assert wclient.get("/readyz").json()["checks"]["workos_jwks"] == "ok"

    def down():
        raise RuntimeError("unreachable")

    monkeypatch.setattr(wc, "jwks_ready", down)
    r = wclient.get("/readyz")
    assert r.status_code == 503 and r.json()["checks"]["workos_jwks"].startswith("error")
