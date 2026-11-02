"""todo17 D12: `agent_connections` (outside agents signed in over MCP OAuth) and `agent_approvals`
(a person's approval of an agent's destroy operation).

Audit rows already carry actor + on_behalf_of (`audit_events`, `plugin_audit`, `fs_batches`,
`project_rules_history`), so no column is added for actor identity.

Revision ID: 0023
Revises: 0022
Create Date: 2026-11-02 20:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = '0023'
down_revision = '0022'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'agent_connections',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('org_id', sa.String(length=128), nullable=True),
        sa.Column('person_id', sa.String(length=256), nullable=False),
        sa.Column('client_name', sa.String(length=256), nullable=False),
        sa.Column('client_id', sa.String(length=256), nullable=False),
        sa.Column('scopes', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('last_used_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index('ix_agent_connections_person', 'agent_connections', ['person_id', 'client_id'])
    op.create_table(
        'agent_approvals',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('connection_id', sa.String(length=64), nullable=False),
        sa.Column('person_id', sa.String(length=256), nullable=False),
        sa.Column('project_id', sa.String(length=128), nullable=False),
        sa.Column('operation', sa.String(length=64), nullable=False),
        sa.Column('targets', sa.JSON(), nullable=False),
        sa.Column('state', sa.String(length=16), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('decided_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index('ix_agent_approvals_connection_id', 'agent_approvals', ['connection_id'])
    op.create_index('ix_agent_approvals_person_id', 'agent_approvals', ['person_id'])


def downgrade() -> None:
    op.drop_table('agent_approvals')
    op.drop_table('agent_connections')
