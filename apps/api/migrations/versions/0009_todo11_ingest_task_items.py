"""todo11-ingest: task items and their lifecycle (todo11 D8, Milestone 3 Slice A)

- `task_items`: one row per file dropped into a Studio, `registered` → `uploaded` → `probed`
  → `thumb_ready` → `preview_ready` → `ready` (or `failed`), with the derivatives' paths in
  `meta`, a lease for the worker that processes it, and `priority` (the latest visible-items
  hint, ms since the epoch) so workers serve what's on screen first.

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-31 21:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = '0009'
down_revision = '0008'
branch_labels = None
depends_on = None


def upgrade() -> None:
    big = sa.BigInteger().with_variant(sa.Integer(), 'sqlite')
    op.create_table(
        'task_items',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('task_id', sa.String(length=128), nullable=False),
        sa.Column('project_id', sa.String(length=128), nullable=False),
        sa.Column('session_id', sa.String(length=64), nullable=False),
        sa.Column('client_file_id', sa.String(length=128), nullable=False),
        sa.Column('item_id', sa.String(length=2048), nullable=False),
        sa.Column('node_id', sa.String(length=64), nullable=False),
        sa.Column('name', sa.String(length=1024), nullable=False),
        sa.Column('rel_path', sa.String(length=2048), nullable=False),
        sa.Column('kind', sa.String(length=32), nullable=False),
        sa.Column('size', big, nullable=False),
        sa.Column('sha256', sa.String(length=64), nullable=False),
        sa.Column('state', sa.String(length=16), nullable=False),
        sa.Column('meta', sa.JSON(), nullable=False),
        sa.Column('priority', big, nullable=False),
        sa.Column('lease_until', sa.DateTime(timezone=True), nullable=True),
        sa.Column('attempts', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('task_id', 'item_id'),
    )
    op.create_index('ix_task_items_task_id', 'task_items', ['task_id'])
    op.create_index('ix_task_items_project_id', 'task_items', ['project_id'])
    op.create_index('ix_task_items_claim', 'task_items', ['state', 'priority'])


def downgrade() -> None:
    op.drop_index('ix_task_items_claim', table_name='task_items')
    op.drop_index('ix_task_items_project_id', table_name='task_items')
    op.drop_index('ix_task_items_task_id', table_name='task_items')
    op.drop_table('task_items')
