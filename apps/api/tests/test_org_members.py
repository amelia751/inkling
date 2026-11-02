"""todo9 Phase 6: org settings, members, invitations and project members, in dev mode (local
database only) and workos mode (against the fake WorkOS from auth_fakes)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from studio_api import db
from studio_api.auth.invitations import apply_accepted_invitation
from studio_api.context import issue_session
from studio_api.kernel.projects import personal_org_id
from studio_api.models import AuditEvent, OrganizationMember, OrgInvitation, PendingProjectGrant, ProjectMember, SessionDelegation, SessionToken, User
from studio_api.routes.org import _local_membership_id

from .auth_fakes import ADMIN_PERMS, FETCH, MEMBER_PERMS, signed_in, workos_settings

ME = "user:local-expert"
MY_ORG = personal_org_id(ME)


def _actions() -> list[str]:
    with db.session_scope() as d:
        return [e.action for e in d.scalars(select(AuditEvent).order_by(AuditEvent.at))]


def _add_member(org_id: str, principal: str, role: str = "member", status: str = "active", email: str | None = None, workos_mid: str | None = None) -> str:
    with db.session_scope() as d:
        d.add(OrganizationMember(org_id=org_id, principal=principal, role=role, status=status, workos_membership_id=workos_mid))
        if email:
            wid = principal.split(":", 1)[1]
            d.add(User(id=principal, workos_user_id=wid, email=email, first_name=wid.capitalize(), last_name=None))
    return workos_mid or _local_membership_id(org_id, principal)


def _mid(members: list[dict], principal: str) -> str:
    return next(m["id"] for m in members if m["userId"] == principal)


# ---- dev mode ---------------------------------------------------------------------------------------


def test_dev_org_settings(client):
    org = client.get("/api/v1/org").json()
    assert org["id"] == MY_ORG and org["name"] == "Personal" and org["zeroRetention"] is True and org["domains"] == []
    r = client.patch("/api/v1/org", json={"name": "Cardio Lab", "aiAssist": False})
    assert r.status_code == 200 and r.json()["name"] == "Cardio Lab" and r.json()["aiAssist"] is False
    assert client.patch("/api/v1/org", json={"name": ""}).status_code == 422
    assert client.patch("/api/v1/org", json={"zeroRetention": "yes"}).status_code == 422
    assert _actions() == ["org.updated"]


def test_dev_members_roles_and_guards(client):
    members = client.get("/api/v1/org/members").json()["members"]
    assert [(m["userId"], m["role"], m["status"]) for m in members] == [(ME, "admin", "active")]
    me = members[0]["id"]
    assert client.patch(f"/api/v1/org/members/{me}", json={"role": "member"}).status_code == 409
    assert client.delete(f"/api/v1/org/members/{me}").status_code == 409
    bob = _add_member(MY_ORG, "user:bob", email="bob@example.com")
    pid = client.post("/api/v1/projects", json={"title": "P"}).json()["id"]
    assert client.post(f"/api/v1/projects/{pid}/members", json={"userId": "user:bob", "role": "reviewer"}).status_code == 200
    members = {m["userId"]: m for m in client.get("/api/v1/org/members").json()["members"]}
    assert members["user:bob"]["projects"] == 1 and members["user:bob"]["email"] == "bob@example.com" and members["user:bob"]["id"] == bob
    assert client.patch(f"/api/v1/org/members/{bob}", json={"role": "owner-ish"}).status_code == 422
    r = client.patch(f"/api/v1/org/members/{bob}", json={"role": "admin"})
    assert r.status_code == 200 and r.json()["role"] == "admin"
    # The last Admin can't be demoted: make me a plain member, then try to demote bob.
    with db.session_scope() as d:
        d.get(OrganizationMember, (MY_ORG, ME)).role = "member"
    r = client.patch(f"/api/v1/org/members/{bob}", json={"role": "billing"})
    assert r.status_code == 409 and "at least one Admin" in r.json()["detail"]
    assert client.delete(f"/api/v1/org/members/{bob}").status_code == 409
    assert client.patch("/api/v1/org/members/mem_nope", json={"role": "member"}).status_code == 404
    assert "member.role_changed" in _actions()


def test_dev_remove_member_revokes_tokens_and_project_roles(client):
    client.get("/api/v1/org")
    bob = _add_member(MY_ORG, "user:bob")
    pid = client.post("/api/v1/projects", json={"title": "P"}).json()["id"]
    client.post(f"/api/v1/projects/{pid}/members", json={"userId": "user:bob", "role": "annotator"})
    with db.session_scope() as d:
        issue_session(d, "agent:x", pid, ["*"], on_behalf_of="user:bob")
    assert client.delete(f"/api/v1/org/members/{bob}").status_code == 204
    with db.session_scope() as d:
        assert d.get(OrganizationMember, (MY_ORG, "user:bob")) is None
        assert d.scalar(select(ProjectMember).where(ProjectMember.principal == "user:bob")) is None
        assert d.scalar(select(SessionDelegation)) is None and d.scalar(select(SessionToken)) is None
    ev = [e for e in _audit() if e.action == "member.removed"][0]
    assert ev.target == "user:bob" and ev.detail["revokedTokens"] == 1


def _audit() -> list[AuditEvent]:
    with db.session_scope() as d:
        rows = list(d.scalars(select(AuditEvent).order_by(AuditEvent.at)))
        d.expunge_all()
        return rows


def test_dev_pending_membership_can_only_be_revoked(client):
    client.get("/api/v1/org")
    dave = _add_member(MY_ORG, "user:dave", status="pending", email="dave@example.com")
    r = client.post("/api/v1/org/invitations", json={"emails": ["dave@example.com"], "role": "member", "projects": []})
    inv = r.json()["invitations"][0]["id"]
    assert client.patch(f"/api/v1/org/members/{dave}", json={"role": "admin"}).status_code == 409
    assert client.delete(f"/api/v1/org/members/{dave}").status_code == 204
    with db.session_scope() as d:
        assert d.get(OrganizationMember, (MY_ORG, "user:dave")) is None
        assert d.get(OrgInvitation, inv).state == "revoked"


def test_dev_invitations_and_acceptance(client):
    pid = client.post("/api/v1/projects", json={"title": "P"}).json()["id"]
    body = {"emails": ["Ann@Example.com", "ann@example.com", "ben@example.com"], "role": "member", "projects": [{"projectId": pid, "role": "reviewer"}]}
    invs = client.post("/api/v1/org/invitations", json=body).json()["invitations"]
    assert [i["email"] for i in invs] == ["ann@example.com", "ben@example.com"]
    assert all(i["id"].startswith("inv_") and i["state"] == "pending" and i["projects"] == [{"projectId": pid, "role": "reviewer"}] for i in invs)
    assert client.post("/api/v1/org/invitations", json={"emails": ["ann@example.com"], "role": "member"}).status_code == 409
    assert client.post("/api/v1/org/invitations", json={"emails": ["nope"], "role": "member"}).status_code == 422
    assert client.post("/api/v1/org/invitations", json={"emails": ["x@example.com"], "role": "god"}).status_code == 422
    assert client.post("/api/v1/org/invitations", json={"emails": ["x@example.com"], "role": "member", "projects": [{"projectId": "ws-a", "role": "viewer"}]}).status_code == 404
    listed = client.get("/api/v1/org/invitations").json()["invitations"]
    assert {i["id"] for i in listed} == {i["id"] for i in invs}
    ann, ben = invs[0]["id"], invs[1]["id"]
    r = client.post(f"/api/v1/org/invitations/{ben}/resend")
    assert r.status_code == 200 and r.json()["state"] == "pending"
    assert client.delete(f"/api/v1/org/invitations/{ben}").status_code == 204
    assert client.post(f"/api/v1/org/invitations/{ben}/resend").status_code == 409
    # Expired invitations say so.
    with db.session_scope() as d:
        d.get(OrgInvitation, ben).state = "pending"
        d.get(OrgInvitation, ben).expires_at = datetime.now(UTC) - timedelta(days=1)
    assert next(i for i in client.get("/api/v1/org/invitations").json()["invitations"] if i["id"] == ben)["state"] == "expired"
    # Acceptance turns the pending grants into project roles, once.
    with db.session_scope() as d:
        assert apply_accepted_invitation(d, ann, "user:ann") == 1
        assert apply_accepted_invitation(d, ann, "user:ann") == 0
        assert d.get(ProjectMember, (pid, "user:ann")).role == "reviewer"
        assert d.get(OrgInvitation, ann).state == "accepted"
        assert d.scalar(select(PendingProjectGrant).where(PendingProjectGrant.invitation_id == ann)) is None
    assert client.delete(f"/api/v1/org/invitations/{ann}").status_code == 409
    acts = _actions()
    assert acts.count("invitation.sent") == 2 and {"invitation.resent", "invitation.revoked", "invitation.accepted", "project_member.added"} <= set(acts)


def test_dev_project_members(client):
    pid = client.post("/api/v1/projects", json={"title": "P"}).json()["id"]
    _add_member(MY_ORG, "user:bob")
    assert client.post(f"/api/v1/projects/{pid}/members", json={"userId": "user:stranger", "role": "viewer"}).status_code == 404
    assert client.post(f"/api/v1/projects/{pid}/members", json={"userId": "user:bob", "role": "boss"}).status_code == 422
    r = client.post(f"/api/v1/projects/{pid}/members", json={"userId": "user:bob", "role": "annotator"})
    assert r.status_code == 200 and r.json()["addedBy"] == ME and r.json()["role"] == "annotator"
    assert client.post(f"/api/v1/projects/{pid}/members", json={"userId": "user:bob", "role": "viewer"}).status_code == 409
    assert client.patch(f"/api/v1/projects/{pid}/members/user:bob", json={"role": "reviewer"}).json()["role"] == "reviewer"
    assert [(m["userId"], m["role"]) for m in client.get(f"/api/v1/projects/{pid}/members").json()["members"]] == [(ME, "owner"), ("user:bob", "reviewer")]
    # bob (a reviewer, not the project's admin) can see the members but not change them.
    bob = {"X-Dev-Principal": "user:bob"}
    assert client.get(f"/api/v1/projects/{pid}/members", headers=bob).status_code == 200
    assert client.patch(f"/api/v1/projects/{pid}/members/user:bob", json={"role": "owner"}, headers=bob).status_code == 403
    assert client.delete(f"/api/v1/projects/{pid}/members/user:bob", headers=bob).status_code == 403
    # Another person's project doesn't exist for you.
    assert client.get(f"/api/v1/projects/{pid}/members", headers={"X-Dev-Principal": "user:eve"}).status_code == 404
    assert client.delete(f"/api/v1/projects/{pid}/members/user:bob").status_code == 204
    assert client.delete(f"/api/v1/projects/{pid}/members/user:bob").status_code == 404
    assert {"project_member.added", "project_member.role_changed", "project_member.removed"} <= set(_actions())


def test_dev_cross_org_ids_are_404(client):
    client.get("/api/v1/org", headers={"X-Dev-Principal": "user:eve"})  # eve's personal org
    eve_mid = _local_membership_id(personal_org_id("user:eve"), "user:eve")
    assert client.patch(f"/api/v1/org/members/{eve_mid}", json={"role": "member"}).status_code == 404
    assert client.delete(f"/api/v1/org/members/{eve_mid}").status_code == 404
    inv = client.post("/api/v1/org/invitations", json={"emails": ["z@example.com"], "role": "member"}, headers={"X-Dev-Principal": "user:eve"}).json()["invitations"][0]["id"]
    assert client.post(f"/api/v1/org/invitations/{inv}/resend").status_code == 404
    assert client.delete(f"/api/v1/org/invitations/{inv}").status_code == 404
    assert client.get("/api/v1/org/invitations").json()["invitations"] == []


# ---- workos mode ------------------------------------------------------------------------------------


def _extend(fake) -> None:
    """The Phase 6 surface on the shared fake: memberships, invitations, organization updates."""
    from workos._errors import APIError

    fake.invitations, fake.reject_emails = {}, {}

    async def update_organization_membership(id, *, role=None):  # noqa: A002
        fake.calls.append(("update_membership", {"id": id, "role": getattr(role, "role_slug", None)}))
        return SimpleNamespace(id=id)

    async def deactivate_organization_membership(id):  # noqa: A002
        fake.calls.append(("deactivate_membership", {"id": id}))
        return SimpleNamespace(id=id, status="inactive")

    async def delete_organization_membership(id):  # noqa: A002
        fake.calls.append(("delete_membership", {"id": id}))

    def _inv(**kw):
        base = {"object": "invitation", "state": "pending", "accepted_user_id": None, "created_at": "2026-11-01T00:00:00Z", "updated_at": "2026-11-01T00:00:00Z", "expires_at": "2099-01-01T00:00:00Z"}
        return SimpleNamespace(**{**base, **kw})

    async def send_invitation(**kw):
        fake.calls.append(("send_invitation", kw))
        if kw["email"] in fake.reject_emails:
            raise APIError(fake.reject_emails[kw["email"]], status_code=422)
        i = _inv(id=f"invitation_{len(fake.invitations) + 1}", email=kw["email"], organization_id=kw["organization_id"], role_slug=kw.get("role_slug"))
        fake.invitations[i.id] = i
        return i

    async def resend_invitation(id):  # noqa: A002
        fake.calls.append(("resend_invitation", {"id": id}))
        fake.invitations[id].updated_at = "2026-11-02T00:00:00Z"
        return fake.invitations[id]

    async def revoke_invitation(id):  # noqa: A002
        fake.calls.append(("revoke_invitation", {"id": id}))
        fake.invitations[id].state, fake.invitations[id].updated_at = "revoked", "2026-11-03T00:00:00Z"
        return fake.invitations[id]

    async def list_invitations(**kw):
        from .auth_fakes import _Page

        return _Page([i for i in fake.invitations.values() if i.organization_id == kw.get("organization_id")])

    async def update_organization(id, *, name=None, **_):  # noqa: A002
        fake.calls.append(("update_org", {"id": id, "name": name}))
        return SimpleNamespace(id=id, name=name)

    async def get_organization(id):  # noqa: A002
        return SimpleNamespace(id=id, domains=[SimpleNamespace(domain="lab.example", state="verified"), SimpleNamespace(domain="new.example", state="pending")])

    m, um, o = fake.organization_membership, fake.user_management, fake.organizations
    m.update_organization_membership, m.deactivate_organization_membership, m.delete_organization_membership = update_organization_membership, deactivate_organization_membership, delete_organization_membership
    um.send_invitation, um.resend_invitation, um.revoke_invitation, um.list_invitations = send_invitation, resend_invitation, revoke_invitation, list_invitations
    o.update_organization, o.get_organization = update_organization, get_organization


@pytest.fixture
def wc(make_client, fake_workos):
    _extend(fake_workos)
    c = make_client(**workos_settings())
    signed_in(c, "user_A", "org_W1", ADMIN_PERMS)
    org = c.get("/api/v1/org").json()["id"]  # the org's stub row
    _add_member(org, "user:user_A", role="admin", email="user_a@example.com", workos_mid="om_A")
    _add_member(org, "user:user_B", role="member", email="user_b@example.com", workos_mid="om_B")
    c.org_id = org
    return c


def test_workos_org_settings_rename_calls_workos(wc, fake_workos):
    org = wc.get("/api/v1/org").json()
    assert org["workosOrgId"] == "org_W1" and org["domains"] == [{"domain": "lab.example", "state": "verified"}, {"domain": "new.example", "state": "pending"}]
    r = wc.patch("/api/v1/org", json={"name": "Cardio", "zeroRetention": False}, headers=FETCH)
    assert r.status_code == 200 and r.json()["name"] == "Cardio" and r.json()["zeroRetention"] is False
    assert ("update_org", {"id": "org_W1", "name": "Cardio"}) in fake_workos.calls
    # The flags are ours only.
    wc.patch("/api/v1/org", json={"aiAssist": False}, headers=FETCH)
    assert fake_workos.count("update_org") == 1


def test_workos_role_change_and_removal(wc, fake_workos):
    members = {m["userId"]: m for m in wc.get("/api/v1/org/members").json()["members"]}
    assert members["user:user_B"]["id"] == "om_B" and members["user:user_B"]["name"] == "User_b"
    assert wc.patch("/api/v1/org/members/om_A", json={"role": "member"}, headers=FETCH).status_code == 409  # yourself
    r = wc.patch("/api/v1/org/members/om_B", json={"role": "billing"}, headers=FETCH)
    assert r.status_code == 200 and r.json()["role"] == "billing"
    assert ("update_membership", {"id": "om_B", "role": "billing"}) in fake_workos.calls
    with db.session_scope() as d:
        issue_session(d, "agent:x", "ws-x", ["*"], on_behalf_of="user:user_B")
    assert wc.delete("/api/v1/org/members/om_B", headers=FETCH).status_code == 204
    assert ("deactivate_membership", {"id": "om_B"}) in fake_workos.calls
    with db.session_scope() as d:
        assert d.get(OrganizationMember, (wc.org_id, "user:user_B")).status == "inactive"
        assert d.scalar(select(SessionToken)) is None
    assert {m["userId"]: m["status"] for m in wc.get("/api/v1/org/members").json()["members"]}["user:user_B"] == "deactivated"
    assert {"member.role_changed", "member.removed"} <= set(_actions())


def test_workos_invitations_pass_errors_through_and_accept_on_sign_in(wc, fake_workos):
    pid = wc.post("/api/v1/projects", json={"title": "P"}, headers=FETCH).json()["id"]
    fake_workos.reject_emails["bad@gmail.com"] = "Invitations to consumer domains must match the address exactly."
    body = {"emails": ["user_c@example.com", "bad@gmail.com"], "role": "member", "projects": [{"projectId": pid, "role": "annotator"}]}
    r = wc.post("/api/v1/org/invitations", json=body, headers=FETCH)
    assert r.status_code == 422 and r.json()["detail"] == "bad@gmail.com: Invitations to consumer domains must match the address exactly."
    sent = [kw for n, kw in fake_workos.calls if n == "send_invitation"][0]
    assert sent["organization_id"] == "org_W1" and sent["role_slug"] == "member" and sent["expires_in_days"] == 7 and sent["inviter_user_id"] == "user_A"
    listed = wc.get("/api/v1/org/invitations").json()["invitations"]
    assert [(i["id"], i["email"], i["projects"]) for i in listed] == [("invitation_1", "user_c@example.com", [{"projectId": pid, "role": "annotator"}])]
    assert wc.post("/api/v1/org/invitations/invitation_1/resend", headers=FETCH).status_code == 200
    # user_C accepts on the hosted page and lands on our callback, signed in to org_W1.
    fake_workos.code_user = {"sub": "user_C", "org": "org_W1", "perms": MEMBER_PERMS}
    from urllib.parse import parse_qs, urlsplit

    loc = wc.get("/api/auth/login", follow_redirects=False).headers["location"]
    state = parse_qs(urlsplit(loc).query)["state"][0]
    assert wc.get("/api/auth/callback", params={"code": "c", "state": state}, follow_redirects=False).status_code == 302
    with db.session_scope() as d:
        assert d.get(ProjectMember, (pid, "user:user_C")).role == "annotator"
        assert d.get(OrgInvitation, "invitation_1").state == "accepted"


def test_workos_revoke_invitation(wc, fake_workos):
    inv = wc.post("/api/v1/org/invitations", json={"emails": ["d@example.com"], "role": "member", "projects": []}, headers=FETCH).json()["invitations"][0]
    assert inv["id"] == "invitation_1"
    assert wc.delete("/api/v1/org/invitations/invitation_1", headers=FETCH).status_code == 204
    assert ("revoke_invitation", {"id": "invitation_1"}) in fake_workos.calls
    assert wc.get("/api/v1/org/invitations").json()["invitations"][0]["state"] == "revoked"


def test_workos_permission_gates(wc, fake_workos):
    pid = wc.post("/api/v1/projects", json={"title": "P"}, headers=FETCH).json()["id"]
    wc.post("/api/v1/org/invitations", json={"emails": ["d@example.com"], "role": "member"}, headers=FETCH)
    signed_in(wc, "user_B", "org_W1", MEMBER_PERMS)
    assert wc.get("/api/v1/org").status_code == 200
    assert wc.get("/api/v1/org/members").status_code == 200
    denied = [
        ("PATCH", "/api/v1/org", {"name": "x"}),
        ("PATCH", "/api/v1/org/members/om_A", {"role": "member"}),
        ("DELETE", "/api/v1/org/members/om_A", None),
        ("GET", "/api/v1/org/invitations", None),
        ("POST", "/api/v1/org/invitations", {"emails": ["e@example.com"], "role": "member"}),
        ("POST", "/api/v1/org/invitations/invitation_1/resend", None),
        ("DELETE", "/api/v1/org/invitations/invitation_1", None),
    ]
    for method, url, body in denied:
        r = wc.request(method, url, json=body, headers=FETCH)
        assert r.status_code == 403, (method, url, r.status_code)
    # A plain member doesn't see a project they aren't in; once added as a viewer, they see its
    # members but can't change them.
    assert wc.get(f"/api/v1/projects/{pid}/members").status_code == 404
    with db.session_scope() as d:
        d.add(ProjectMember(project_id=pid, principal="user:user_B", role="viewer"))
    assert wc.get(f"/api/v1/projects/{pid}/members").status_code == 200
    assert wc.post(f"/api/v1/projects/{pid}/members", json={"userId": "user:user_A", "role": "viewer"}, headers=FETCH).status_code == 403
    assert wc.patch(f"/api/v1/projects/{pid}/members/user:user_B", json={"role": "owner"}, headers=FETCH).status_code == 403
    assert wc.delete(f"/api/v1/projects/{pid}/members/user:user_B", headers=FETCH).status_code == 403
    assert fake_workos.count("update_membership") == 0 and fake_workos.count("send_invitation") == 1


def test_workos_cross_org_is_404(wc, fake_workos):
    pid = wc.post("/api/v1/projects", json={"title": "P"}, headers=FETCH).json()["id"]
    wc.post("/api/v1/org/invitations", json={"emails": ["d@example.com"], "role": "member"}, headers=FETCH)
    # The same person, now in another organization: org_W1's ids don't exist there.
    signed_in(wc, "user_A", "org_W2", ADMIN_PERMS)
    other = wc.get("/api/v1/org").json()["id"]
    assert other != wc.org_id
    assert wc.patch("/api/v1/org/members/om_B", json={"role": "admin"}, headers=FETCH).status_code == 404
    assert wc.delete("/api/v1/org/members/om_B", headers=FETCH).status_code == 404
    assert wc.post("/api/v1/org/invitations/invitation_1/resend", headers=FETCH).status_code == 404
    assert wc.delete("/api/v1/org/invitations/invitation_1", headers=FETCH).status_code == 404
    assert wc.get(f"/api/v1/projects/{pid}/members").status_code == 404
    assert wc.post(f"/api/v1/projects/{pid}/members", json={"userId": "user:user_B", "role": "viewer"}, headers=FETCH).status_code == 404
    assert wc.post("/api/v1/org/invitations", json={"emails": ["e@example.com"], "role": "member", "projects": [{"projectId": pid, "role": "viewer"}]}, headers=FETCH).status_code == 404
    assert all(m["userId"] != "user:user_B" for m in wc.get("/api/v1/org/members").json()["members"])
