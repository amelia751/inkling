"""todo9 Phase 13: the api's WorkOS sign-in against WorkOS Emulate (no fakes in the WorkOS path).

Skipped when no emulator answers (see conftest.py); CI starts one and requires it.
"""

from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

import httpx
from sqlalchemy import select

from studio_api import db
from studio_api.auth.cookie import session_cookie_name, state_cookie_name
from studio_api.models import AuditEvent, Organization, OrganizationMember, User

from .conftest import ACME, ADMIN_PERMS, COOKIE_DOMAIN, FETCH, GLOBEX, USERS, cleared, set_cookie_headers, unverified


def test_password_sign_in_gives_a_working_session(eclient, emulate):
    auth = emulate.sign_in(eclient, *USERS["member"])
    assert auth["organization_id"] == ACME
    s = eclient.get("/api/auth/session")
    assert s.status_code == 200, s.text
    body = s.json()
    assert body["mode"] == "workos" and body["user"]["email"] == "member@example.com" and body["user"]["id"] == f"user:{auth['user']['id']}"
    assert body["organization"]["workosOrgId"] == ACME and body["organization"]["name"] == "Acme Imaging" and body["role"] == "member" and body["permissions"] == ["project:create"]
    assert [o["workosOrgId"] for o in body["organizations"]] == [ACME]
    assert eclient.get("/api/v1/projects").status_code == 200
    # The emulator's real token verified against its JWKS, with the pinned issuer.
    assert unverified(auth["access_token"])["iss"] == emulate.issuer
    assert emulate.proxy.hits["refresh"] == 0


def test_wrong_password_is_refused_by_workos(emulate):
    r = emulate.authenticate(grant_type="password", email="member@example.com", password="nope")
    assert r.status_code >= 400 and r.json().get("code") == "invalid_credentials"


def test_callback_error_and_tampered_state(eclient, emulate):
    r = eclient.get("/api/auth/callback", params={"error": "access_denied", "error_description": "The user denied access"})
    assert r.status_code == 400 and "denied" in r.json()["detail"]
    # A real code from the emulator, but the URL's state isn't the one we signed.
    login = eclient.get("/api/auth/login", params={"login_hint": "member@example.com"}, follow_redirects=False)
    hop = httpx.get(login.headers["location"], follow_redirects=False)
    q = {k: v[0] for k, v in parse_qs(urlsplit(hop.headers["location"]).query).items()}
    assert eclient.get("/api/auth/callback", params={**q, "state": "not-the-state"}).status_code == 400
    # The state cookie was cleared by that failure: the same code and state are refused now too.
    assert eclient.get("/api/auth/callback", params=q).status_code == 400
    # A state cookie edited in the browser fails its signature, whatever state the URL carries.
    login = eclient.get("/api/auth/login", params={"login_hint": "member@example.com"}, follow_redirects=False)
    good = eclient.cookies.get(state_cookie_name())
    payload, mac = good.rsplit(".", 1)
    eclient.cookies.set(state_cookie_name(), payload[:-2] + "AA." + mac, domain=COOKIE_DOMAIN, path="/api/auth")
    hop = httpx.get(login.headers["location"], follow_redirects=False)
    q = {k: v[0] for k, v in parse_qs(urlsplit(hop.headers["location"]).query).items()}
    assert eclient.get("/api/auth/callback", params=q).status_code == 400
    assert emulate.proxy.hits["code"] == 0  # nothing was exchanged
    assert not eclient.cookies.get(session_cookie_name())


def test_callback_sign_in_mirrors_the_user_and_membership(eclient, emulate):
    r = emulate.callback_sign_in(eclient, "member@example.com", return_to="/projects")
    assert r.status_code == 302 and r.headers["location"] == "/projects", r.text
    assert eclient.get("/api/auth/session").json()["organization"]["workosOrgId"] == ACME
    with db.session_scope() as d:
        u = d.scalar(select(User).where(User.email == "member@example.com"))
        org = d.scalar(select(Organization).where(Organization.workos_org_id == ACME))
        assert u is not None and org is not None
        assert d.get(OrganizationMember, (org.id, u.id)).role == "member"
        assert "auth.signed_in" in [e.action for e in d.scalars(select(AuditEvent))]


def test_refresh_rotates_the_refresh_token_and_rewrites_the_cookie(eclient, emulate, expire):
    emulate.sign_in(eclient, *USERS["member"])
    before = emulate.session_data(eclient)
    expire(eclient)
    r = eclient.get("/api/v1/projects")
    assert r.status_code == 200, r.text
    assert emulate.proxy.hits["refresh"] == 1
    assert any(h.startswith(f"{session_cookie_name()}=") for h in set_cookie_headers(r))
    after = emulate.session_data(eclient)
    assert after["refresh_token"] != before["refresh_token"] and after["access_token"] != before["access_token"]
    assert unverified(after["access_token"])["sub"] == unverified(before["access_token"])["sub"]
    # The rewritten cookie works without another refresh.
    assert eclient.get("/api/auth/session").status_code == 200 and emulate.proxy.hits["refresh"] == 1


def test_logout_revokes_the_session(eclient, emulate, expire):
    r = emulate.callback_sign_in(eclient, "member@example.com")
    assert r.status_code == 302, r.text
    sealed = eclient.cookies.get(session_cookie_name())
    sid = unverified(emulate.session_data(eclient)["access_token"])["sid"]
    assert eclient.post("/api/auth/logout").status_code == 403  # CSRF header
    r = eclient.post("/api/auth/logout", headers=FETCH)
    assert r.status_code == 200 and cleared(r)
    url = r.json()["url"]
    assert url.startswith(emulate.proxy.url) and f"session_id={sid}" in url
    # The browser goes to the logout URL; WorkOS ends the session there.
    assert httpx.get(url, follow_redirects=False).status_code in (302, 303)
    with db.session_scope() as d:
        assert "auth.signed_out" in [e.action for e in d.scalars(select(AuditEvent))]
    # A copy of the old cookie can't come back: its refresh token is dead (invalid_grant → 401, cleared).
    eclient.cookies.set(session_cookie_name(), sealed, domain=COOKIE_DOMAIN)
    expire(eclient)
    r = eclient.get("/api/v1/projects")
    assert r.status_code == 401 and cleared(r)


def test_5xx_during_refresh_keeps_the_session(eclient, emulate, expire):
    emulate.sign_in(eclient, *USERS["member"])
    sealed = eclient.cookies.get(session_cookie_name())
    expire(eclient)
    emulate.proxy.fail_refresh = 503
    r = eclient.get("/api/v1/projects")
    assert r.status_code == 503 and r.headers.get("Retry-After") and not set_cookie_headers(r)
    # A request waiting on WorkOS mustn't hang in the SDK's retries: one attempt, then 503.
    assert emulate.proxy.hits["refresh"] == 1
    assert eclient.cookies.get(session_cookie_name()) == sealed
    emulate.proxy.fail_refresh = 502
    assert eclient.get("/api/auth/session").status_code == 503 and eclient.cookies.get(session_cookie_name()) == sealed
    # WorkOS is back: the same cookie refreshes and the person never signed in again.
    emulate.proxy.fail_refresh = None
    r = eclient.get("/api/v1/projects")
    assert r.status_code == 200, r.text
    assert eclient.cookies.get(session_cookie_name()) != sealed


def test_multi_org_selection_then_switch_org(eclient, emulate):
    email, pw = USERS["admin"]
    # In two organizations: WorkOS asks which one before it issues tokens.
    r = emulate.authenticate(grant_type="password", email=email, password=pw)
    assert r.status_code >= 400 and r.json()["code"] == "organization_selection_required"
    assert {o["id"] for o in r.json()["organizations"]} == {ACME, GLOBEX}
    emulate.sign_in(eclient, email, pw, organization=ACME)
    s = eclient.get("/api/auth/session").json()
    assert s["organization"]["workosOrgId"] == ACME and s["role"] == "admin" and set(s["permissions"]) >= ADMIN_PERMS
    orgs = {o["workosOrgId"]: o for o in s["organizations"]}
    assert set(orgs) == {ACME, GLOBEX} and orgs[GLOBEX]["name"] == "Globex Radiology"
    # Switch into Globex (by our org id), where the same person is a plain member.
    r = eclient.post("/api/auth/switch-org", json={"organizationId": orgs[GLOBEX]["id"]}, headers=FETCH)
    assert r.status_code == 200 and r.json() == {"ok": True}, r.text
    s = eclient.get("/api/auth/session").json()
    assert s["organization"]["workosOrgId"] == GLOBEX and s["role"] == "member" and s["permissions"] == ["project:create"]
    # And back, by WorkOS id.
    assert eclient.post("/api/auth/switch-org", json={"organizationId": ACME}, headers=FETCH).json() == {"ok": True}
    assert eclient.get("/api/auth/session").json()["organization"]["workosOrgId"] == ACME
    with db.session_scope() as d:
        assert [e.action for e in d.scalars(select(AuditEvent))].count("auth.org_switched") == 2


def test_multi_org_callback_lands_in_an_organization(eclient, emulate):
    # No organization asked for: the first one WorkOS offers; the switcher does the rest.
    r = emulate.callback_sign_in(eclient, "admin@example.com")
    assert r.status_code == 302, r.text
    assert eclient.get("/api/auth/session").json()["organization"]["workosOrgId"] in (ACME, GLOBEX)
    # Asked for one (the switcher's sign-in redirect, an invitation): that one.
    eclient.cookies.clear()
    r = emulate.callback_sign_in(eclient, "admin@example.com", organization_id=GLOBEX)
    assert r.status_code == 302, r.text
    assert eclient.get("/api/auth/session").json()["organization"]["workosOrgId"] == GLOBEX


def test_org_boundary(eclient, emulate):
    emulate.sign_in(eclient, *USERS["member"])
    pid = eclient.post("/api/v1/projects", json={"title": "Acme study"}, headers=FETCH)
    assert pid.status_code == 201, pid.text
    pid = pid.json()["id"]
    assert eclient.get(f"/api/v1/projects/{pid}").json()["role"] == "owner"
    # The admin, signed into Globex: the Acme project doesn't exist there.
    eclient.cookies.clear()
    emulate.sign_in(eclient, *USERS["admin"], organization=GLOBEX)
    assert eclient.get(f"/api/v1/projects/{pid}").status_code == 404
    assert pid not in [p["id"] for p in eclient.get("/api/v1/projects").json()["projects"]]
    # Billing, in Acme but not in the project and without project:create.
    eclient.cookies.clear()
    emulate.sign_in(eclient, *USERS["billing"])
    assert eclient.get(f"/api/v1/projects/{pid}").status_code == 404
    assert eclient.post("/api/v1/projects", json={"title": "P"}, headers=FETCH).status_code == 403


def test_personal_org_bootstrap_for_a_person_without_one(eclient, emulate):
    email, _pw, user = emulate.create_user()
    r = emulate.callback_sign_in(eclient, email, return_to="/")
    assert r.status_code == 302, r.text
    s = eclient.get("/api/auth/session").json()
    assert s["user"]["email"] == email and s["organization"]["name"] == "Personal"
    assert s["role"] == "admin" and set(s["permissions"]) >= ADMIN_PERMS
    workos_org = s["organization"]["workosOrgId"]
    assert workos_org and s["organization"]["id"]
    # WorkOS knows the org by our id (D4), and the person is its admin there.
    org = emulate.http.get(f"/organizations/{workos_org}").json()
    assert org["external_id"] == s["organization"]["id"]
    ms = emulate.http.get("/user_management/organization_memberships", params={"user_id": user["id"]}).json()["data"]
    assert [(m["organization_id"], m["role"]["slug"]) for m in ms] == [(workos_org, "admin")]
    assert eclient.get("/api/v1/projects").json()["projects"] == []
    # Signing in again finds the same personal org instead of making another.
    eclient.cookies.clear()
    r = emulate.callback_sign_in(eclient, email)
    assert r.status_code == 302, r.text
    assert eclient.get("/api/auth/session").json()["organization"]["workosOrgId"] == workos_org
    with db.session_scope() as d:
        row = d.scalar(select(Organization).where(Organization.workos_org_id == workos_org))
        assert row.kind == "personal"
