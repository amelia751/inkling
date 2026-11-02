"""todo17 D3, D10, D13: project rules (+ history), lint findings, idempotency keys.

`project_rules` holds each project's `rules.v1` document and its revision; `project_rules_history`
every saved revision (append-only). `lint_findings` is what a write or the daily `rules.scan`
found (resolved when a later write or scan clears it). `idempotency_keys` replays a mutating
request sent again with the same `Idempotency-Key` (kept `API_IDEMPOTENCY_TTL_HOURS`).

Revision ID: 0019
Revises: 0018
Create Date: 2026-11-02 18:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = '0019'
down_revision = '0018'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'project_rules',
        sa.Column('project_id', sa.String(length=128), sa.ForeignKey('projects.id'), primary_key=True),
        sa.Column('rules', sa.JSON(), nullable=False),
        sa.Column('revision', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('updated_by', sa.String(length=256), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.create_table(
        'project_rules_history',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('project_id', sa.String(length=128), sa.ForeignKey('projects.id'), nullable=False),
        sa.Column('revision', sa.Integer(), nullable=False),
        sa.Column('rules', sa.JSON(), nullable=False),
        sa.Column('actor', sa.String(length=256), nullable=False),
        sa.Column('on_behalf_of', sa.String(length=256), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint('project_id', 'revision', name='uq_project_rules_history_revision'),
    )
    op.create_index('ix_project_rules_history_project_id', 'project_rules_history', ['project_id'])
    op.create_table(
        'lint_findings',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('project_id', sa.String(length=128), sa.ForeignKey('projects.id'), nullable=False),
        sa.Column('resource_kind', sa.String(length=32), nullable=False),
        sa.Column('resource_id', sa.String(length=128), nullable=False),
        sa.Column('rule', sa.String(length=128), nullable=False),
        sa.Column('severity', sa.String(length=16), nullable=False),
        sa.Column('path', sa.String(length=1024), nullable=True),
        sa.Column('message', sa.Text(), nullable=False, server_default=''),
        sa.Column('source', sa.String(length=8), nullable=False),  # write | scan
        sa.Column('first_seen', sa.DateTime(timezone=True), nullable=False),
        sa.Column('resolved_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index('ix_lint_findings_project_open', 'lint_findings', ['project_id', 'resolved_at'])
    op.create_index('ix_lint_findings_resource', 'lint_findings', ['resource_kind', 'resource_id'])
    op.create_table(
        'idempotency_keys',
        sa.Column('key', sa.String(length=256), primary_key=True),
        sa.Column('principal', sa.String(length=256), primary_key=True),
        sa.Column('op_id', sa.String(length=256), nullable=False),
        sa.Column('body_hash', sa.String(length=71), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),  # in_progress | done; HTTP status is in response
        sa.Column('response', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_idempotency_keys_created_at', 'idempotency_keys', ['created_at'])


def downgrade() -> None:
    op.drop_index('ix_idempotency_keys_created_at', table_name='idempotency_keys')
    op.drop_table('idempotency_keys')
    op.drop_index('ix_lint_findings_resource', table_name='lint_findings')
    op.drop_index('ix_lint_findings_project_open', table_name='lint_findings')
    op.drop_table('lint_findings')
    op.drop_index('ix_project_rules_history_project_id', table_name='project_rules_history')
    op.drop_table('project_rules_history')
    op.drop_table('project_rules')
