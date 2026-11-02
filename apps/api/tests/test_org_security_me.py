"""todo9 Phases 9–11: Organization › Security, the audit log and Your profile, in dev mode and
against a fake WorkOS (no network)."""

from __future__ import annotations

import csv
import io
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import pytest
from sqlalchemy import select

from studio_api import db
from studio_api.auth.audit import record_event
from studio_api.auth.cookie import session_cookie_name
from studio_api.models import AuditEvent, Organization, User
from studio_api.routes import me as me_routes
from studio_api.routes import org_security

from .auth_fakes import ADMIN_PERMS, FETCH, MEMBER_PERMS, _Page, signed_in, user, workos_settings


@pytest.fixture(autouse=True)
def _fresh_caches():
    org_security.forget_status()
    me_routes.forget_auth_methods()
    yield
    org_security.forget_status()
    me_routes.forget_auth_methods()


def _session(sid: str, *, method: str = "password", status: str = "active", minutes_ago: int = 0):
    at = datetime(2026, 11, 1, 12, 0, tzinfo=UTC) - timedelta(minutes=minutes_ago)
    return SimpleNamespace(id=sid, ip_address="10.0.0.1", user_agent="Mozilla/5.0 (Macintosh)", created_at=at, expires_at=at + timedelta(hours=12), status=status, auth_method=method)


@pytest.fixture
def wos(fake_workos):
    """The shared fake plus the Phase 9–11 surface: SSO, directories, the Admin Portal, sessions,
    profile updates and email changes."""
    fake = fake_workos
    fake.connections, fake.directories, fake.domains = [], [], []
    fake.sessions = [_session("session_1"), _session("session_2", minutes_ago=30), _session("session_3", minutes_ago=60), _session("session_old", status="revoked")]
    fake.revoked = []

    class SSO:
        async def list_connections(self, **kw):
            fake.calls.append(("list_connections", kw))
            return _Page(fake.connections)

    class Dsync:
        async def list_directories(self, **kw):
            fake.calls.append(("list_directories", kw))
            return _Page(fake.directories)

    class Portal:
        async def generate_link(self, **kw):
            fake.calls.append(("generate_link", kw))
            return SimpleNamespace(link=f"https://setup.workos.test/portal/launch?intent={kw['intent']}")

    async def get_organization(oid):
        fake.calls.append(("get_organization", {"id": oid}))
        return SimpleNamespace(id=oid, domains=fake.domains)

    async def list_sessions(uid, **kw):
        fake.calls.append(("list_sessions", {"id": uid}))
        return _Page(list(fake.sessions))

    async def revoke_session(*, session_id):
        fake.calls.append(("revoke_session", {"session_id": session_id}))
        fake.revoked.append(session_id)

    async def update_user(uid, **kw):
        fake.calls.append(("update_user", {"id": uid, **kw}))
        u = {**user(uid), **kw, "updated_at": "2026-11-02T00:00:00Z"}
        return SimpleNamespace(to_dict=lambda: dict(u))

    async def send_email_change(uid, *, new_email):
        fake.calls.append(("send_email_change", {"id": uid, "new_email": new_email}))
        return SimpleNamespace(new_email=new_email, expires_at=datetime(2026, 11, 1, 13, 0, tzinfo=UTC))

    async def confirm_email_change(uid, *, code):
        fake.calls.append(("confirm_email_change", {"id": uid, "code": code}))

    async def get_user(uid):
        u = {**user(uid, "new@example.com"), "updated_at": "2026-11-03T00:00:00Z"}
        return SimpleNamespace(to_dict=lambda: dict(u))

    fake.sso, fake.directory_sync, fake.admin_portal = SSO(), Dsync(), Portal()
    fake.organizations.get_organization = get_organization
    um = fake.user_management
    um.list_sessions, um.revoke_session, um.update_user = list_sessions, revoke_session, update_user
    um.send_email_change, um.confirm_email_change, um.get_user = send_email_change, confirm_email_change, get_user
    return fake


@pytest.fixture
def wclient(make_client, wos):
    return make_client(**workos_settings(public_url="http://localhost:5173"))


def _actions() -> list[str]:
    with db.session_scope() as d:
        return [e.action for e in d.scalars(select(AuditEvent).order_by(AuditEvent.at))]


# ---- Phase 9: security ---------------------------------------------------------------------------


def test_dev_security_is_offline_and_mfa_is_not_editable(client):
    s = client.get("/api/v1/org/security").json()
    assert s["mfaRequired"] is False and s["mfaEditable"] is False and s["sessionHours"] == 12
    assert s["sso"] is None and s["directory"] is None and s["domains"] == []
    methods = {m["id"]: m["on"] for m in s["methods"]}
    assert methods["password"] and methods["google"] and not methods["passkey"] and not methods["sso"]
    r = client.patch("/api/v1/org/security", json={"mfaRequired": True})
    assert r.status_code == 409 and "dashboard" in r.json()["detail"]
    assert client.patch("/api/v1/org/security", json={"mfaRequired": "yes"}).status_code == 422


def test_dev_admin_portal_returns_a_fake_url_and_is_audited(client):
    r = client.post("/api/v1/org/admin-portal", json={"intent": "domain_verification"})
    assert r.status_code == 200
    url = urlsplit(r.json()["url"])
    assert url.netloc == "api.workos.com" and url.path == "/portal/dev" and parse_qs(url.query)["intent"] == ["domain_verification"]
    assert client.post("/api/v1/org/admin-portal", json={"intent": "certificate_renewal"}).status_code == 422
    events = client.get("/api/v1/org/audit").json()["events"]
    assert [e["action"] for e in events] == ["security.admin_portal_opened"] and events[0]["actorId"] == "user:local-expert"


def test_session_hours_and_methods_come_from_settings(make_client):
    c = make_client(session_max_hours=8, signin_methods="password,microsoft")
    s = c.get("/api/v1/org/security").json()
    assert s["sessionHours"] == 8
    assert [m["id"] for m in s["methods"] if m["on"]] == ["password", "microsoft"]


def test_workos_security_status_is_read_and_cached(wclient, wos):
    wos.connections = [SimpleNamespace(connection_type="OktaSAML", state="active")]
    wos.directories = [SimpleNamespace(type="okta scim v2.0", state="linked", metadata=SimpleNamespace(users=SimpleNamespace(active=12, inactive=1), groups=3))]
    wos.domains = [SimpleNamespace(domain="clinic.example", state="verified"), SimpleNamespace(domain="new.example", state="pending")]
    signed_in(wclient, "user_A", "org_W1", MEMBER_PERMS)
    s = wclient.get("/api/v1/org/security").json()
    assert s["sso"] == {"provider": "OktaSAML", "state": "active"}
    assert s["directory"] == {"provider": "okta scim v2.0", "users": 12, "groups": 3}
    assert s["domains"] == [{"domain": "clinic.example", "state": "verified"}, {"domain": "new.example", "state": "pending"}]
    assert next(m for m in s["methods"] if m["id"] == "sso")["on"] is True
    assert ("list_connections", {"organization_id": "org_W1", "limit": 100}) in wos.calls
    wclient.get("/api/v1/org/security")
    assert wos.count("list_connections") == 1  # cached 60 s


def test_workos_security_gates_and_admin_portal(wclient, wos):
    signed_in(wclient, "user_M", "org_W1", MEMBER_PERMS)
    assert wclient.patch("/api/v1/org/security", json={"mfaRequired": True}, headers=FETCH).status_code == 403
    assert wclient.post("/api/v1/org/admin-portal", json={"intent": "sso"}, headers=FETCH).status_code == 403
    assert wos.count("generate_link") == 0
    signed_in(wclient, "user_A", "org_W1", ADMIN_PERMS)
    assert wclient.patch("/api/v1/org/security", json={"mfaRequired": True}, headers=FETCH).status_code == 409
    r = wclient.post("/api/v1/org/admin-portal", json={"intent": "sso"}, headers=FETCH)
    assert r.status_code == 200 and r.json()["url"].startswith("https://setup.workos.test/portal/launch")
    kw = next(k for n, k in wos.calls if n == "generate_link")
    assert kw["organization"] == "org_W1" and kw["intent"] == "sso" and kw["external_user_id"] == "user:user_A"
    assert kw["return_url"] == "http://localhost:5173/organization/security"
    with db.session_scope() as d:
        row = d.scalar(select(AuditEvent).where(AuditEvent.action == "security.admin_portal_opened"))
        org = d.scalar(select(Organization).where(Organization.workos_org_id == "org_W1"))
        assert row.org_id == org.id and row.actor == "user:user_A" and row.detail == {"intent": "sso"}


# ---- Phase 10: audit log -------------------------------------------------------------------------


def _seed_events(org_id: str, n: int, *, actor: str = "user:user_A", action: str = "members.role_changed") -> None:
    base = datetime(2026, 10, 1, tzinfo=UTC)
    with db.session_scope() as d:
        for i in range(n):
            row = record_event(d, org_id=org_id, actor=actor, action=action, target=f"om_{i}", ip="10.0.0.9", detail={"role": "admin"})
            row.at = base + timedelta(minutes=i)


def _org_w1() -> str:
    with db.session_scope() as d:
        return d.scalar(select(Organization.id).where(Organization.workos_org_id == "org_W1"))


def test_audit_pages_filters_and_actor_names(wclient, wos):
    signed_in(wclient, "user_A", "org_W1", ADMIN_PERMS)
    assert wclient.get("/api/v1/org/security").status_code == 200  # creates the org stub
    org = _org_w1()
    with db.session_scope() as d:
        d.add(User(id="user:user_A", workos_user_id="user_A", email="ada@example.com", first_name="Ada", last_name="Lovelace"))
    _seed_events(org, 7)
    _seed_events(org, 2, actor="user:user_B", action="apikeys.created")
    _seed_events("org-other", 3)  # another organization: never visible
    first = wclient.get("/api/v1/org/audit", params={"limit": 4}).json()
    assert len(first["events"]) == 4 and first["next"]
    e = first["events"][0]
    assert set(e) == {"id", "at", "actor", "actorId", "action", "target", "ip"} and e["at"].endswith("Z")
    seen = [x["id"] for x in first["events"]]
    nxt = first["next"]
    while nxt:
        page = wclient.get("/api/v1/org/audit", params={"limit": 4, "before": nxt}).json()
        seen += [x["id"] for x in page["events"]]
        nxt = page["next"]
    assert len(seen) == len(set(seen)) == 9
    ada = wclient.get("/api/v1/org/audit", params={"actor": "lovelace"}).json()["events"]
    assert len(ada) == 7 and {x["actor"] for x in ada} == {"Ada Lovelace"} and {x["actorId"] for x in ada} == {"user:user_A"}
    assert len(wclient.get("/api/v1/org/audit", params={"actor": "user_B"}).json()["events"]) == 2
    assert len(wclient.get("/api/v1/org/audit", params={"action": "apikeys.created"}).json()["events"]) == 2
    assert len(wclient.get("/api/v1/org/audit", params={"action": "apikeys."}).json()["events"]) == 2
    assert wclient.get("/api/v1/org/audit", params={"before": "2026-10-01T00:03:30Z"}).json()["events"][0]["target"] == "om_3"
    assert wclient.get("/api/v1/org/audit", params={"before": "not a time"}).status_code == 422


def test_audit_includes_sign_in_events_and_needs_audit_read(wclient, wos):
    signed_in(wclient, "user_A", "org_W1", ADMIN_PERMS)
    wclient.get("/api/v1/org/security")
    with db.session_scope() as d:
        record_event(d, org_id=_org_w1(), actor="user:user_A", action="auth.signed_in", target="user:user_A", ip="10.1.1.1")
    events = wclient.get("/api/v1/org/audit").json()["events"]
    assert [e["action"] for e in events] == ["auth.signed_in"] and events[0]["ip"] == "10.1.1.1"
    signed_in(wclient, "user_M", "org_W1", MEMBER_PERMS)
    assert wclient.get("/api/v1/org/audit").status_code == 403
    assert wclient.get("/api/v1/org/audit.csv").status_code == 403


def test_audit_csv_has_ids_and_labels_only(wclient, wos):
    signed_in(wclient, "user_A", "org_W1", ADMIN_PERMS)
    wclient.get("/api/v1/org/security")
    _seed_events(_org_w1(), 3)
    with db.session_scope() as d:
        record_event(d, org_id=_org_w1(), actor="user:user_A", action="org.renamed", target="=HYPERLINK(1)", detail={"secret": "never exported"})
    r = wclient.get("/api/v1/org/audit.csv", params={"action": "org.renamed"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv") and "attachment" in r.headers["content-disposition"]
    rows = list(csv.reader(io.StringIO(r.text)))
    assert rows[0] == ["id", "at", "actorId", "actor", "action", "target", "ip"]
    assert len(rows) == 2 and rows[1][5] == "'=HYPERLINK(1)" and "never exported" not in r.text
    assert len(list(csv.reader(io.StringIO(wclient.get("/api/v1/org/audit.csv").text)))) == 5


# ---- Phase 11: profile ---------------------------------------------------------------------------


def test_dev_profile_round_trips_locally(client):
    me = client.get("/api/v1/me").json()
    assert me == {"id": "user:local-expert", "email": "local-expert@localhost", "firstName": "Local Expert", "lastName": None, "marketing": False, "ssoManaged": False}
    r = client.patch("/api/v1/me", json={"firstName": "Grace", "lastName": "Hopper", "marketing": True})
    assert r.status_code == 200 and r.json()["firstName"] == "Grace" and r.json()["lastName"] == "Hopper" and r.json()["marketing"] is True
    assert client.get("/api/v1/me").json()["marketing"] is True
    assert client.get("/api/auth/session").json()["user"]["name"] == "Grace Hopper"
    assert client.patch("/api/v1/me", json={"firstName": " "}).status_code == 422
    assert client.patch("/api/v1/me", json={"marketing": "yes"}).status_code == 422
    events = client.get("/api/v1/org/audit", params={"action": "profile.updated"}).json()["events"]
    assert len(events) == 1 and events[0]["target"] == "user:local-expert"


def test_dev_sessions_and_mfa_url(client):
    sessions = client.get("/api/v1/me/sessions", headers={"User-Agent": "pytest"}).json()["sessions"]
    assert len(sessions) == 1 and sessions[0]["current"] and sessions[0]["userAgent"] == "pytest"
    assert client.delete(f"/api/v1/me/sessions/{sessions[0]['id']}").status_code == 409
    assert client.delete("/api/v1/me/sessions/session_x").status_code == 404
    assert client.post("/api/v1/me/sessions/revoke-others").status_code == 204
    r = client.get("/api/v1/me/mfa-url").json()
    assert r["url"].startswith("/api/auth/login?") and parse_qs(urlsplit(r["url"]).query)["return_to"] == ["/settings/profile"] and r["hint"]
    assert client.post("/api/v1/me/email-change", json={"newEmail": "x@example.com"}).status_code == 409


def test_workos_profile_updates_names_in_workos_and_the_cookie(wclient, wos):
    signed_in(wclient, "user_A", "org_W1", MEMBER_PERMS)
    me = wclient.get("/api/v1/me").json()
    assert me["email"] == "user_A@example.com" and me["firstName"] == "Ada" and me["ssoManaged"] is False
    before = wclient.cookies.get(session_cookie_name())
    r = wclient.patch("/api/v1/me", json={"firstName": "Augusta", "lastName": "King", "marketing": True}, headers=FETCH)
    assert r.status_code == 200, r.text
    assert r.json()["firstName"] == "Augusta" and r.json()["lastName"] == "King" and r.json()["marketing"] is True
    assert ("update_user", {"id": "user_A", "first_name": "Augusta", "last_name": "King"}) in wos.calls
    # The resealed cookie carries the new name: the account menu shows it at once.
    assert wclient.cookies.get(session_cookie_name()) != before
    assert wclient.get("/api/auth/session").json()["user"]["name"] == "Augusta King"
    with db.session_scope() as d:
        u = d.get(User, "user:user_A")
        assert u.first_name == "Augusta" and u.marketing is True
    assert [a for a in _actions() if a.startswith("profile.")] == ["profile.updated"]
    # Marketing alone stays local.
    wclient.patch("/api/v1/me", json={"marketing": False}, headers=FETCH)
    assert wos.count("update_user") == 1


def test_workos_sso_users_cant_change_names(wclient, wos):
    wos.sessions = [_session("session_1", method="sso")]
    signed_in(wclient, "user_A", "org_W1", MEMBER_PERMS)
    assert wclient.get("/api/v1/me").json()["ssoManaged"] is True
    r = wclient.patch("/api/v1/me", json={"firstName": "X"}, headers=FETCH)
    assert r.status_code == 409 and "identity provider" in r.json()["detail"]
    assert wclient.patch("/api/v1/me", json={"marketing": True}, headers=FETCH).status_code == 200
    assert wclient.post("/api/v1/me/email-change", json={"newEmail": "x@example.com"}, headers=FETCH).status_code == 409
    assert wos.count("update_user") == 0


def test_workos_sessions_list_and_revoke(wclient, wos):
    signed_in(wclient, "user_A", "org_W1", MEMBER_PERMS)
    sessions = wclient.get("/api/v1/me/sessions").json()["sessions"]
    assert [s["id"] for s in sessions] == ["session_1", "session_2", "session_3"]  # active only, this one first
    assert [s["current"] for s in sessions] == [True, False, False] and sessions[0]["expiresAt"].endswith("Z")
    assert wclient.delete("/api/v1/me/sessions/session_1", headers=FETCH).status_code == 409
    assert wclient.delete("/api/v1/me/sessions/session_of_someone_else", headers=FETCH).status_code == 404
    assert wclient.delete("/api/v1/me/sessions/session_2", headers=FETCH).status_code == 204
    assert wos.revoked == ["session_2"]
    assert wclient.post("/api/v1/me/sessions/revoke-others", headers=FETCH).status_code == 204
    assert wos.revoked == ["session_2", "session_2", "session_3"]  # the fake doesn't forget revoked ones
    assert _actions()[-2:] == ["session.revoked", "session.revoked_others"]


def test_workos_email_change_and_mfa_url(wclient, wos):
    signed_in(wclient, "user_A", "org_W1", MEMBER_PERMS)
    r = wclient.post("/api/v1/me/email-change", json={"newEmail": "New@Example.com"}, headers=FETCH)
    assert r.status_code == 200 and r.json()["newEmail"] == "new@example.com"
    assert wclient.post("/api/v1/me/email-change/confirm", json={"code": ""}, headers=FETCH).status_code == 422
    r = wclient.post("/api/v1/me/email-change/confirm", json={"code": "123456"}, headers=FETCH)
    assert r.status_code == 200 and r.json()["email"] == "new@example.com"
    assert wclient.get("/api/auth/session").json()["user"]["email"] == "new@example.com"
    assert "profile.email_change_requested" in _actions() and "profile.email_changed" in _actions()
    q = parse_qs(urlsplit(wclient.get("/api/v1/me/mfa-url").json()["url"]).query)
    assert q["max_age"] == ["0"] and q["return_to"] == ["/settings/profile"] and q["login_hint"] == ["new@example.com"]


def test_profile_routes_refuse_agent_tokens(make_client):
    c = make_client()
    with db.session_scope() as d:
        from studio_api.context import issue_session

        token = issue_session(d, "agent:helper", "default", ["*"], on_behalf_of="user:local-expert")
    h = {"Authorization": f"Bearer {token}"}
    assert c.get("/api/v1/me", headers=h).status_code == 403
    assert c.post("/api/v1/me/sessions/revoke-others", headers=h).status_code == 403
