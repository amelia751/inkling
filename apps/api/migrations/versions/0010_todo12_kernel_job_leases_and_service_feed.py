"""todo12-kernel: resource classes, fairness caps, resource leases, service event feed

- `plugin_jobs.resource_class` (`cpu` default, `memory`, `gpu`): which worker pool claims it;
  `plugin_jobs.error_class`: why a failed or cancelled job ended (docs/pipeline.md §12).
- `workspace_resource_limits`: per workspace and class, how many jobs may run at once
  (workspace `*` is the default row).
- `resource_leases`: one row per running `gpu` / `memory` attempt, taken in the claim
  transaction and renewed by the heartbeat.
- `plugin_events.feed_seq`: the service feed's order. On Postgres it defaults to the writing
  transaction's id; rows that existed before this migration get 0 (they are all committed).

Revision ID: 0010
Revises: 0009
Create Date: 2026-11-01 12:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = '0010'
down_revision = '0009'
branch_labels = None
depends_on = None

FEED_SEQ_DEFAULT = "(pg_current_xact_id()::text::bigint)"


def upgrade() -> None:
    with op.batch_alter_table('plugin_jobs') as b:
        b.add_column(sa.Column('resource_class', sa.String(length=16), nullable=False, server_default='cpu'))
        b.add_column(sa.Column('error_class', sa.String(length=64), nullable=True))
    op.create_table(
        'workspace_resource_limits',
        sa.Column('workspace_id', sa.String(length=128), nullable=False),
        sa.Column('resource_class', sa.String(length=16), nullable=False),
        sa.Column('max_running', sa.Integer(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('workspace_id', 'resource_class'),
    )
    op.create_table(
        'resource_leases',
        sa.Column('job_id', sa.String(length=64), nullable=False),
        sa.Column('workspace_id', sa.String(length=128), nullable=False),
        sa.Column('resource_class', sa.String(length=16), nullable=False),
        sa.Column('worker_id', sa.String(length=128), nullable=False),
        sa.Column('attempt', sa.Integer(), nullable=False),
        sa.Column('acquired_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('job_id'),
    )
    op.create_index('ix_resource_leases_slot', 'resource_leases', ['workspace_id', 'resource_class', 'expires_at'])
    with op.batch_alter_table('plugin_events') as b:
        b.add_column(sa.Column('feed_seq', sa.BigInteger(), nullable=True))
    if op.get_bind().dialect.name == 'postgresql':
        op.execute("UPDATE plugin_events SET feed_seq = 0")
        op.execute(f"ALTER TABLE plugin_events ALTER COLUMN feed_seq SET DEFAULT {FEED_SEQ_DEFAULT}")
    op.create_index('ix_plugin_events_feed', 'plugin_events', ['feed_seq', 'event_id'])


def downgrade() -> None:
    op.drop_index('ix_plugin_events_feed', table_name='plugin_events')
    with op.batch_alter_table('plugin_events') as b:
        b.drop_column('feed_seq')
    op.drop_index('ix_resource_leases_slot', table_name='resource_leases')
    op.drop_table('resource_leases')
    op.drop_table('workspace_resource_limits')
    with op.batch_alter_table('plugin_jobs') as b:
        b.drop_column('error_class')
        b.drop_column('resource_class')
