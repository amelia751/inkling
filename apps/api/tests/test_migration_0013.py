"""todo9 Phase 2: the accounts migration on a database with organizations, members and
projects made before it, up and down."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import command

from studio_api import db

from .test_migrations import _alembic_at

T = "2026-11-01 10:00:00"
NEW = {"users", "project_members", "pending_project_grants", "org_invitations", "org_api_keys", "audit_events", "workos_event_cursor", "workos_events_processed"}


def test_0013_maps_roles_backfills_project_owners_then_downgrades(tmp_path):
    cfg = _alembic_at(tmp_path, "0012")
    with db.engine().begin() as c:
        c.execute(sa.text("INSERT INTO organizations (id, name, kind, created_at) VALUES ('o', 'O', 'team', :t)"), {"t": T})
        for who, role in (("user:a", "owner"), ("user:b", "editor"), ("user:c", "viewer")):
            c.execute(sa.text("INSERT INTO organization_members (org_id, principal, role) VALUES ('o', :p, :r)"), {"p": who, "r": role})
        for pid, by in (("p1", "user:a"), ("p2", "user:b")):
            c.execute(sa.text("INSERT INTO workspaces (id, name, created_at) VALUES (:p, :p, :t)"), {"p": pid, "t": T})
            c.execute(sa.text("INSERT INTO projects (id, org_id, title, description, visibility, seed, archived, created_by, created_at, updated_at) VALUES (:p, 'o', :p, '', 'private', 0, 0, :by, :t, :t)"), {"p": pid, "by": by, "t": T})

    command.upgrade(cfg, "0013")
    with db.engine().begin() as c:
        assert NEW <= set(sa.inspect(c).get_table_names())
        roles = dict(c.execute(sa.text("SELECT principal, role FROM organization_members")).fetchall())
        assert roles == {"user:a": "admin", "user:b": "member", "user:c": "member"}
        assert {r[0] for r in c.execute(sa.text("SELECT status FROM organization_members"))} == {"active"}
        owners = sorted(c.execute(sa.text("SELECT project_id, principal, role FROM project_members")).fetchall())
        assert owners == [("p1", "user:a", "owner"), ("p2", "user:b", "owner")]
        org = c.execute(sa.text("SELECT workos_org_id, zero_retention, ai_assist FROM organizations")).one()
        assert org[0] is None and bool(org[1]) and bool(org[2])
        assert {"org_id", "permissions"} <= {col["name"] for col in sa.inspect(c).get_columns("session_delegations")}
        assert "ix_audit_events_org_at" in {i["name"] for i in sa.inspect(c).get_indexes("audit_events")}

    # The models work against the migrated schema (the upsert helper included).
    from datetime import UTC, datetime, timedelta

    from studio_api.dbutil import upsert_newer
    from studio_api.models import User

    t = datetime.now(UTC)
    with db.session_scope() as s:
        upsert_newer(s, User, {"id": "user:u1", "workos_user_id": "u1", "email": "a@example.com", "workos_updated_at": t, "created_at": t}, ["id"])
        upsert_newer(s, User, {"id": "user:u1", "workos_user_id": "u1", "email": "stale@example.com", "workos_updated_at": t - timedelta(seconds=1), "created_at": t}, ["id"])
    with db.session_scope() as s:
        assert s.get(User, "user:u1").email == "a@example.com"

    command.downgrade(cfg, "0012")
    with db.engine().begin() as c:
        assert not NEW & set(sa.inspect(c).get_table_names())
        roles = dict(c.execute(sa.text("SELECT principal, role FROM organization_members")).fetchall())
        assert roles == {"user:a": "owner", "user:b": "editor", "user:c": "editor"}
        assert "workos_org_id" not in {col["name"] for col in sa.inspect(c).get_columns("organizations")}
        assert c.execute(sa.text("SELECT count(*) FROM projects")).scalar() == 2
    command.upgrade(cfg, "head")
    db.reset_engine()
