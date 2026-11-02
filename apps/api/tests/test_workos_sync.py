"""todo9 Phase 7: the WorkOS Events API sync, against a fake event source (no network)."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import delete, select

from studio_api import db
from studio_api.auth import sync
from studio_api.models import (
    AuditEvent,
    Organization,
    OrganizationMember,
    OrgInvitation,
    PendingProjectGrant,
    ProjectMember,
    SessionDelegation,
    User,
    WorkosEventCursor,
    WorkosEventProcessed,
)


class FakeEvents:
    """The Events API: ascending, `after` an event id, `limit` per page."""

    def __init__(self, events: list[dict[str, Any]] | None = None) -> None:
        self.events: list[dict[str, Any]] = list(events or [])
        self.calls: list[str | None] = []

    def list_events(self, *, after: str | None, limit: int) -> list[dict[str, Any]]:
        self.calls.append(after)
        ids = [e["id"] for e in self.events]
        start = ids.index(after) + 1 if after in ids else 0
        return self.events[start:start + limit]


_n = 0


def ev(kind: str, data: dict[str, Any], *, at: str = "2026-11-01T10:00:00Z", **extra) -> dict[str, Any]:
    global _n
    _n += 1
    return {"object": "event", "id": f"event_{_n:06d}", "event": kind, "data": data, "created_at": at, **extra}


def user(uid: str, first: str = "Ada", *, at: str = "2026-11-01T10:00:00Z") -> dict[str, Any]:
    return {"object": "user", "id": uid, "email": f"{uid}@Example.com", "first_name": first, "last_name": "Lovelace", "email_verified": True, "profile_picture_url": None, "created_at": "2026-11-01T00:00:00Z", "updated_at": at}


def org(oid: str, name: str, *, at: str = "2026-11-01T10:00:00Z") -> dict[str, Any]:
    return {"object": "organization", "id": oid, "name": name, "created_at": "2026-11-01T00:00:00Z", "updated_at": at}


def membership(mid: str, uid: str, oid: str, role: str = "member", status: str = "active", *, at: str = "2026-11-01T10:00:00Z") -> dict[str, Any]:
    return {"object": "organization_membership", "id": mid, "user_id": uid, "organization_id": oid, "status": status, "role": {"slug": role}, "roles": [{"slug": role}], "created_at": "2026-11-01T00:00:00Z", "updated_at": at}


def _snapshot() -> dict[str, list]:
    with db.session_scope() as d:
        return {
            "users": sorted((u.id, u.email, u.first_name, u.last_name, u.deleted_at is not None) for u in d.scalars(select(User))),
            "orgs": sorted((o.id, o.name, o.workos_org_id) for o in d.scalars(select(Organization))),
            "members": sorted((m.org_id, m.principal, m.role, m.status, m.workos_membership_id) for m in d.scalars(select(OrganizationMember))),
            "invitations": sorted((i.id, i.state) for i in d.scalars(select(OrgInvitation))),
            "projectMembers": sorted((p.project_id, p.principal, p.role) for p in d.scalars(select(ProjectMember))),
            "audit": sorted((a.id, a.action) for a in d.scalars(select(AuditEvent))),
        }


def _member(org_workos_id: str, uid: str) -> OrganizationMember | None:
    with db.session_scope() as d:
        oid = d.scalar(select(Organization.id).where(Organization.workos_org_id == org_workos_id))
        return d.get(OrganizationMember, (oid, f"user:{uid}"))


def _agent_token(client, principal: str) -> tuple[str, str]:
    pid = client.post("/api/v1/projects", json={"title": "P"}, headers={"X-Dev-Principal": principal}).json()["id"]
    tok = client.post("/api/v1/sessions", json={"scopes": ["*"]}, headers={"X-Workspace-Id": pid, "X-Dev-Principal": principal}).json()["token"]
    assert client.get(f"/api/v1/projects/{pid}", headers={"Authorization": f"Bearer {tok}"}).status_code == 200
    return pid, tok


@pytest.fixture
def stats():
    st = sync.Stats()
    return st


def test_events_fill_the_mirror_and_replaying_the_last_100_changes_nothing(client, stats):
    events = [
        ev("organization.created", org("org_A", "Acme")),
        ev("user.created", user("user_1")),
        ev("organization_membership.created", membership("om_1", "user_1", "org_A", "admin")),
        ev("user.created", user("user_2", "Bob")),
        ev("organization_membership.created", membership("om_2", "user_2", "org_A")),
        ev("user.updated", user("user_1", "Ada2", at="2026-11-01T11:00:00Z")),
        ev("organization_membership.updated", membership("om_2", "user_2", "org_A", "billing", at="2026-11-01T11:00:00Z")),
        ev("organization.updated", org("org_A", "Acme Health", at="2026-11-01T11:00:00Z")),
        ev("session.created", {"object": "session", "id": "session_1", "user_id": "user_1", "organization_id": "org_A", "ip_address": "10.1.2.3", "user_agent": "UA", "status": "active"}),
    ]
    src = FakeEvents(events)
    out = sync.tick(src, stats)
    assert out["events"] == len(events) and out["drained"] and out["failures"] == 0
    snap = _snapshot()
    assert [u for u in snap["users"] if u[0] == "user:user_1"] == [("user:user_1", "user_1@example.com", "Ada2", "Lovelace", False)]
    assert any(o[1] == "Acme Health" and o[2] == "org_A" for o in snap["orgs"])
    assert _member("org_A", "user_1").role == "admin" and _member("org_A", "user_2").role == "billing"
    assert snap["audit"] == [(events[-1]["id"], "workos.session.created")]
    with db.session_scope() as d:
        a = d.get(AuditEvent, events[-1]["id"])
        assert a.actor == "user:user_1" and a.ip == "10.1.2.3" and a.org_id is not None
        assert d.get(WorkosEventCursor, sync.CONSUMER).last_event_id == events[-1]["id"]

    # Another poll: nothing new, nothing applied.
    assert sync.tick(src, stats)["events"] == 0
    # Replay the last 100 as delivered: every one is skipped.
    assert sync.process(events[-100:], stats) == (0, 0, False)
    assert _snapshot() == snap
    # Even with the processed table emptied, re-applying them converges on the same state.
    with db.session_scope() as d:
        d.execute(delete(WorkosEventProcessed))
    assert sync.process(events[-100:], stats)[0] == len(events)
    assert _snapshot() == snap


def test_out_of_order_events_make_stubs_and_never_overwrite_newer_rows(client, stats):
    sync.process([
        # The membership before its user and org: both become stubs.
        ev("organization_membership.created", membership("om_9", "user_9", "org_Z", "admin")),
        ev("user.updated", user("user_9", "Newer", at="2026-11-01T12:00:00Z")),
        ev("user.created", user("user_9", "Older", at="2026-11-01T09:00:00Z")),
        ev("organization.updated", org("org_Z", "Zed new", at="2026-11-01T12:00:00Z")),
        ev("organization.created", org("org_Z", "Zed old", at="2026-11-01T09:00:00Z")),
        ev("organization_membership.updated", membership("om_9", "user_9", "org_Z", "member", at="2026-11-01T12:00:00Z")),
        ev("organization_membership.updated", membership("om_9", "user_9", "org_Z", "billing", at="2026-11-01T11:00:00Z")),
    ], stats)
    with db.session_scope() as d:
        u = d.get(User, "user:user_9")
        assert u.first_name == "Newer" and u.email == "user_9@example.com"
        o = d.scalar(select(Organization).where(Organization.workos_org_id == "org_Z"))
        assert o.name == "Zed new" and o.kind == "team"
    assert _member("org_Z", "user_9").role == "member"


def test_user_deleted_tombstones_but_keeps_the_principal(client, stats):
    principal = "user:user_d"
    pid, tok = _agent_token(client, principal)
    sync.process([
        ev("user.created", user("user_d")),
        ev("organization_membership.created", membership("om_d", "user_d", "org_D")),
    ], stats)
    later = user("user_d", "Ghost", at="2026-11-01T13:00:00Z")
    sync.process([ev("user.deleted", user("user_d", at="2026-11-01T12:00:00Z")), ev("user.updated", later)], stats)
    with db.session_scope() as d:
        u = d.get(User, principal)
        assert u.deleted_at is not None and u.first_name is None and u.last_name is None and u.email == ""
        # Provenance: the project they own still names them.
        assert d.get(ProjectMember, (pid, principal)).role == "owner"
        assert not list(d.scalars(select(SessionDelegation).where(SessionDelegation.on_behalf_of == principal)))
    assert _member("org_D", "user_d").status == "inactive"
    assert client.get(f"/api/v1/projects/{pid}", headers={"Authorization": f"Bearer {tok}"}).status_code == 401


def test_membership_deleted_or_deactivated_revokes_agent_tokens(client, stats):
    pa, tok_a = _agent_token(client, "user:user_a")
    pb, tok_b = _agent_token(client, "user:user_b")
    sync.process([
        ev("organization_membership.created", membership("om_a", "user_a", "org_M")),
        ev("organization_membership.created", membership("om_b", "user_b", "org_M")),
    ], stats)
    assert client.get(f"/api/v1/projects/{pa}", headers={"Authorization": f"Bearer {tok_a}"}).status_code == 200

    sync.process([ev("organization_membership.deleted", membership("om_a", "user_a", "org_M", at="2026-11-01T12:00:00Z"))], stats)
    assert _member("org_M", "user_a") is None
    assert client.get(f"/api/v1/projects/{pa}", headers={"Authorization": f"Bearer {tok_a}"}).status_code == 401
    assert client.get(f"/api/v1/projects/{pb}", headers={"Authorization": f"Bearer {tok_b}"}).status_code == 200

    sync.process([ev("organization_membership.updated", membership("om_b", "user_b", "org_M", status="inactive", at="2026-11-01T12:00:00Z"))], stats)
    assert _member("org_M", "user_b").status == "inactive"
    assert client.get(f"/api/v1/projects/{pb}", headers={"Authorization": f"Bearer {tok_b}"}).status_code == 401


def test_invitation_accepted_applies_pending_project_grants(client, stats):
    pid = client.post("/api/v1/projects", json={"title": "Grants"}).json()["id"]
    sync.process([ev("organization.created", org("org_I", "Inv"))], stats)
    inv = {"object": "invitation", "id": "invitation_1", "email": "new@example.com", "state": "pending", "organization_id": "org_I", "inviter_user_id": "user_1", "accepted_user_id": None, "role_slug": "member", "expires_at": "2026-11-08T00:00:00Z", "created_at": "2026-11-01T10:00:00Z", "updated_at": "2026-11-01T10:00:00Z"}
    sync.process([ev("invitation.created", inv)], stats)
    with db.session_scope() as d:
        d.add(PendingProjectGrant(invitation_id="invitation_1", project_id=pid, role="reviewer", added_by="user:local-expert"))
    accepted = {**inv, "state": "accepted", "accepted_user_id": "user_new", "updated_at": "2026-11-01T11:00:00Z"}
    sync.process([ev("invitation.accepted", accepted), ev("organization_membership.created", membership("om_new", "user_new", "org_I"))], stats)
    with db.session_scope() as d:
        assert d.get(OrgInvitation, "invitation_1").state == "accepted"
        assert d.get(ProjectMember, (pid, "user:user_new")).role == "reviewer"
        assert not list(d.scalars(select(PendingProjectGrant)))


def test_apply_accepted_invitation_keeps_an_existing_role(client):
    pid = client.post("/api/v1/projects", json={"title": "Keep"}).json()["id"]
    with db.session_scope() as d:
        d.add(ProjectMember(project_id=pid, principal="user:x", role="viewer"))
        d.add(PendingProjectGrant(invitation_id="inv_1", project_id=pid, role="owner"))
    with db.session_scope() as d:
        assert sync.apply_accepted_invitation(d, "inv_1", "user:x") == 1
    with db.session_scope() as d:
        assert d.get(ProjectMember, (pid, "user:x")).role == "viewer"


def test_a_failing_event_stops_the_batch_then_is_skipped(client, stats):
    bad = ev("organization_membership.created", {"id": "om_bad"})  # no user or org
    good = ev("user.created", user("user_ok"))
    src = FakeEvents([bad, good])
    for attempt in range(1, sync.MAX_ATTEMPTS):
        out = sync.tick(src, stats)
        assert out["failures"] == 1 and out["events"] == 0
        with db.session_scope() as d:
            assert d.get(WorkosEventCursor, sync.CONSUMER) is None
    out = sync.tick(src, stats)
    assert out["events"] == 1 and out["drained"]
    with db.session_scope() as d:
        assert d.get(User, "user:user_ok") is not None
        assert d.get(WorkosEventCursor, sync.CONSUMER).last_event_id == good["id"]


def test_tick_pages_through_a_backlog(client, stats, monkeypatch):
    monkeypatch.setattr(sync, "PAGE", 3)
    src = FakeEvents([ev("user.created", user(f"user_p{i}")) for i in range(7)])
    out = sync.tick(src, stats)
    assert out["events"] == 7 and out["drained"] and len(src.calls) == 3
    assert stats.lag_s() < 5


def test_workos_event_source_asks_for_ascending_events_after_the_cursor():
    seen: dict[str, Any] = {}

    class Ev:
        def __init__(self, d):
            self.d = d

        def to_dict(self):
            return self.d

    def list_events(**kw):
        seen.update(kw)
        return SimpleNamespace(data=[Ev({"id": "event_1", "event": "user.created", "data": {}})])

    src = sync.WorkOSEventSource(SimpleNamespace(events=SimpleNamespace(list_events=list_events)))
    assert src.list_events(after="event_0", limit=100) == [{"id": "event_1", "event": "user.created", "data": {}}]
    assert seen["after"] == "event_0" and seen["order"] == "asc" and seen["limit"] == 100 and "user.deleted" in seen["events"]
    seen.clear()
    src.list_events(after=None, limit=10)
    assert "after" not in seen and seen["range_start"].endswith("Z")


class _Paged:
    def __init__(self, items):
        self.data = items

    def auto_paging_iter(self):
        yield from self.data


def test_reconcile_fixes_drift_and_logs_counts(client, stats, caplog):
    pg, tok = _agent_token(client, "user:user_gone_m")
    sync.process([
        ev("organization.created", org("org_R", "Old name")),
        ev("user.created", user("user_keep")),
        ev("user.created", user("user_gone")),
        ev("organization_membership.created", membership("om_keep", "user_keep", "org_R")),
        ev("organization_membership.created", membership("om_gone", "user_gone_m", "org_R", at="2026-10-01T00:00:00Z")),
    ], stats)
    fake = SimpleNamespace(
        user_management=SimpleNamespace(list_users=lambda **kw: _Paged([user("user_keep", "Kept", at="2026-11-02T00:00:00Z"), user("user_gone_m")])),
        organizations=SimpleNamespace(get_organization=lambda oid: org(oid, "New name", at="2026-11-02T00:00:00Z")),
        organization_membership=SimpleNamespace(list_organization_memberships=lambda **kw: _Paged([membership("om_keep", "user_keep", "org_R", "admin", at="2026-11-02T00:00:00Z")])),
    )
    with caplog.at_level("INFO"):
        counts = sync.reconcile(fake)
    assert counts == {"users": 2, "usersTombstoned": 1, "orgs": 1, "memberships": 1, "membershipsRemoved": 1}
    assert any(r.getMessage() == "workos_sync.reconciled" for r in caplog.records)
    with db.session_scope() as d:
        assert d.get(User, "user:user_keep").first_name == "Kept"
        assert d.get(User, "user:user_gone").deleted_at is not None
        assert d.scalar(select(Organization.name).where(Organization.workos_org_id == "org_R")) == "New name"
    assert _member("org_R", "user_keep").role == "admin" and _member("org_R", "user_gone_m") is None
    assert client.get(f"/api/v1/projects/{pg}", headers={"Authorization": f"Bearer {tok}"}).status_code == 401
    assert not sync.reconcile_due()


def test_the_loop_starts_only_in_workos_mode(client):
    import threading

    from studio_api import config

    assert sync.start(threading.Event()) is None  # dev mode
    s = config.settings()
    config.set_settings(s.model_copy(update={"auth_mode": "workos", "workos_sync_interval_s": 0}))
    try:
        assert sync.start(threading.Event()) is None  # interval 0 = off
    finally:
        config.set_settings(s)


def test_api_key_revoked_is_audited_and_drops_the_cached_validation(client, stats, monkeypatch):
    from studio_api.auth import api_keys

    dropped: list[str] = []
    monkeypatch.setattr(api_keys, "forget_key", dropped.append)
    sync.process([ev("organization.created", org("org_K", "Keys"))], stats)
    e = ev("api_key.revoked", {"object": "api_key", "id": "api_key_1", "owner": {"type": "organization", "id": "org_K"}, "name": "ci", "obfuscated_value": "sk_…abcd", "permissions": [], "created_at": "2026-11-01T00:00:00Z", "updated_at": "2026-11-01T10:00:00Z"})
    sync.process([e], stats)
    assert dropped == ["api_key_1"]
    with db.session_scope() as d:
        a = d.get(AuditEvent, e["id"])
        assert a.action == "workos.api_key.revoked" and a.target == "api_key_1" and a.actor == "workos" and a.org_id is not None
