"""todo9 Phase 2: accounts on WorkOS (users, memberships, project members, invitations, keys, audit)

- `users`: people mirrored from WorkOS (`id` = principal `user:<workos user id>`).
- `organizations`: `workos_org_id`, `workos_updated_at`, and our own `zero_retention`, `ai_assist`.
- `organization_members`: `workos_membership_id`, `status`, `role_slugs`, `workos_updated_at`,
  `created_at`. Data (D5): `owner` → `admin`, `editor` and `viewer` → `member`.
- `project_members` (project roles, D5). Backfill: each project's `created_by` as `owner`.
- `pending_project_grants`: project roles promised in an invitation.
- `org_invitations`, `org_api_keys` (dev-mode local keys), `audit_events` (org audit log).
- `workos_event_cursor`, `workos_events_processed`: the Events API consumer (D6).
- `session_delegations`: `org_id` and `permissions` of the minter (an agent's `can()`).

`downgrade` drops the new tables and columns and maps roles back (`admin` → `owner`,
`member`/`billing` → `editor`); a viewer demoted to member comes back as an editor.

Revision ID: 0013
Revises: 0012
Create Date: 2026-11-01 18:00:00.000000
"""

from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op

revision = '0013'
down_revision = '0012'
branch_labels = None
depends_on = None


def _ts(name: str, nullable: bool = True) -> sa.Column:
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable)


def upgrade() -> None:
    op.create_table(
        'users',
        sa.Column('id', sa.String(length=256), nullable=False),
        sa.Column('workos_user_id', sa.String(length=64), nullable=False),
        sa.Column('email', sa.String(length=320), nullable=False),
        sa.Column('first_name', sa.String(length=256), nullable=True),
        sa.Column('last_name', sa.String(length=256), nullable=True),
        sa.Column('avatar_url', sa.Text(), nullable=True),
        sa.Column('email_verified', sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column('marketing', sa.Boolean(), server_default=sa.false(), nullable=False),
        _ts('last_sign_in_at'),
        _ts('workos_updated_at'),
        _ts('deleted_at'),
        _ts('created_at', nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('workos_user_id', name='uq_users_workos_user_id'),
    )
    op.create_index('ix_users_email', 'users', ['email'])

    # Plain ADD COLUMN + unique indexes, no batch copy: SQLite can't drop and recreate
    # `organizations` while projects reference it (foreign keys are on).
    op.add_column('organizations', sa.Column('workos_org_id', sa.String(length=64), nullable=True))
    op.add_column('organizations', _ts('workos_updated_at'))
    op.add_column('organizations', sa.Column('zero_retention', sa.Boolean(), server_default=sa.true(), nullable=False))
    op.add_column('organizations', sa.Column('ai_assist', sa.Boolean(), server_default=sa.true(), nullable=False))
    op.create_index('uq_organizations_workos_org_id', 'organizations', ['workos_org_id'], unique=True)

    op.add_column('organization_members', sa.Column('workos_membership_id', sa.String(length=64), nullable=True))
    op.add_column('organization_members', sa.Column('status', sa.String(length=16), server_default='active', nullable=False))
    op.add_column('organization_members', sa.Column('role_slugs', sa.JSON(), nullable=True))
    op.add_column('organization_members', _ts('workos_updated_at'))
    op.add_column('organization_members', _ts('created_at'))
    op.create_index('uq_organization_members_workos_membership_id', 'organization_members', ['workos_membership_id'], unique=True)
    op.execute("UPDATE organization_members SET role = 'admin' WHERE role = 'owner'")
    op.execute("UPDATE organization_members SET role = 'member' WHERE role IN ('editor', 'viewer')")

    op.create_table(
        'project_members',
        sa.Column('project_id', sa.String(length=128), sa.ForeignKey('projects.id'), nullable=False),
        sa.Column('principal', sa.String(length=256), nullable=False),
        sa.Column('role', sa.String(length=16), nullable=False),
        sa.Column('added_by', sa.String(length=256), nullable=True),
        _ts('added_at', nullable=False),
        sa.PrimaryKeyConstraint('project_id', 'principal'),
    )
    op.create_index('ix_project_members_principal', 'project_members', ['principal'])
    bind = op.get_bind()
    now = datetime.now(UTC)
    rows = bind.execute(sa.text("SELECT id, created_by FROM projects")).fetchall()
    if rows:
        bind.execute(
            sa.text("INSERT INTO project_members (project_id, principal, role, added_by, added_at) VALUES (:p, :u, 'owner', NULL, :t)"),
            [{"p": pid, "u": who, "t": now} for pid, who in rows if who],
        )

    op.create_table(
        'pending_project_grants',
        sa.Column('invitation_id', sa.String(length=64), nullable=False),
        sa.Column('project_id', sa.String(length=128), sa.ForeignKey('projects.id'), nullable=False),
        sa.Column('role', sa.String(length=16), nullable=False),
        sa.Column('added_by', sa.String(length=256), nullable=True),
        _ts('created_at', nullable=False),
        sa.PrimaryKeyConstraint('invitation_id', 'project_id'),
    )

    op.create_table(
        'org_invitations',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('org_id', sa.String(length=64), sa.ForeignKey('organizations.id'), nullable=False),
        sa.Column('email', sa.String(length=320), nullable=False),
        sa.Column('role', sa.String(length=64), nullable=False),
        sa.Column('state', sa.String(length=16), nullable=False),
        sa.Column('inviter', sa.String(length=256), nullable=True),
        sa.Column('workos_invitation_id', sa.String(length=64), nullable=True),
        _ts('expires_at'),
        _ts('created_at', nullable=False),
        _ts('workos_updated_at'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('workos_invitation_id', name='uq_org_invitations_workos_invitation_id'),
    )
    op.create_index('ix_org_invitations_org_id', 'org_invitations', ['org_id'])

    op.create_table(
        'org_api_keys',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('org_id', sa.String(length=64), sa.ForeignKey('organizations.id'), nullable=False),
        sa.Column('name', sa.String(length=256), nullable=False),
        sa.Column('prefix', sa.String(length=64), nullable=False),
        sa.Column('secret_hash', sa.String(length=64), nullable=False),
        sa.Column('scopes', sa.JSON(), nullable=False),
        sa.Column('created_by', sa.String(length=256), nullable=False),
        _ts('created_at', nullable=False),
        _ts('expires_at'),
        _ts('revoked_at'),
        _ts('last_used_at'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('secret_hash', name='uq_org_api_keys_secret_hash'),
    )
    op.create_index('ix_org_api_keys_org_id', 'org_api_keys', ['org_id'])

    op.create_table(
        'audit_events',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('org_id', sa.String(length=64), nullable=True),
        sa.Column('actor', sa.String(length=256), nullable=False),
        sa.Column('on_behalf_of', sa.String(length=256), nullable=True),
        sa.Column('action', sa.String(length=128), nullable=False),
        sa.Column('target', sa.String(length=256), nullable=True),
        sa.Column('ip', sa.String(length=64), nullable=True),
        sa.Column('user_agent', sa.String(length=512), nullable=True),
        sa.Column('detail', sa.JSON(), nullable=True),
        _ts('at', nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_audit_events_org_at', 'audit_events', ['org_id', 'at'])

    op.create_table(
        'workos_event_cursor',
        sa.Column('consumer', sa.String(length=64), nullable=False),
        sa.Column('last_event_id', sa.String(length=64), nullable=True),
        _ts('updated_at', nullable=False),
        sa.PrimaryKeyConstraint('consumer'),
    )
    op.create_table(
        'workos_events_processed',
        sa.Column('event_id', sa.String(length=64), nullable=False),
        _ts('processed_at', nullable=False),
        sa.PrimaryKeyConstraint('event_id'),
    )

    op.add_column('session_delegations', sa.Column('org_id', sa.String(length=64), nullable=True))
    op.add_column('session_delegations', sa.Column('permissions', sa.JSON(), nullable=True))
    op.create_index('ix_session_delegations_on_behalf_of', 'session_delegations', ['on_behalf_of'])


def downgrade() -> None:
    op.drop_index('ix_session_delegations_on_behalf_of', table_name='session_delegations')
    op.drop_column('session_delegations', 'permissions')
    op.drop_column('session_delegations', 'org_id')
    op.drop_table('workos_events_processed')
    op.drop_table('workos_event_cursor')
    op.drop_index('ix_audit_events_org_at', table_name='audit_events')
    op.drop_table('audit_events')
    op.drop_index('ix_org_api_keys_org_id', table_name='org_api_keys')
    op.drop_table('org_api_keys')
    op.drop_index('ix_org_invitations_org_id', table_name='org_invitations')
    op.drop_table('org_invitations')
    op.drop_table('pending_project_grants')
    op.drop_index('ix_project_members_principal', table_name='project_members')
    op.drop_table('project_members')
    op.execute("UPDATE organization_members SET role = 'owner' WHERE role = 'admin'")
    op.execute("UPDATE organization_members SET role = 'editor' WHERE role IN ('member', 'billing')")
    op.drop_index('uq_organization_members_workos_membership_id', table_name='organization_members')
    for col in ('created_at', 'workos_updated_at', 'role_slugs', 'status', 'workos_membership_id'):
        op.drop_column('organization_members', col)
    op.drop_index('uq_organizations_workos_org_id', table_name='organizations')
    for col in ('ai_assist', 'zero_retention', 'workos_updated_at', 'workos_org_id'):
        op.drop_column('organizations', col)
    op.drop_index('ix_users_email', table_name='users')
    op.drop_table('users')
