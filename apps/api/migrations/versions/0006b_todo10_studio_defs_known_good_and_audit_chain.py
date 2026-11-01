"""todo10 Phases 2 and 4: task notes, last-known-good Studio refs, hash-chained audit

- `task_studio_notes`: each task's `.studio/tasks/<id>/README.md` (intent and notes).
- `studio_known_good`: the `last-known-good` ref per task, moved only by a person or by
  passing checks: the environment revision and lockfile safe mode and rollback restore.
- `plugin_audit.prev_hash` / `entry_hash`: a per-workspace hash chain over audit entries.

Revision ID: 0006b
Revises: 0006
Create Date: 2026-10-31 20:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = '0006b'
down_revision = '0006'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table('task_studio_notes',
    sa.Column('workspace_id', sa.String(length=128), nullable=False),
    sa.Column('task_id', sa.String(length=128), nullable=False),
    sa.Column('readme', sa.Text(), nullable=False),
    sa.Column('updated_by', sa.String(length=256), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('workspace_id', 'task_id')
    )
    op.create_table('studio_known_good',
    sa.Column('workspace_id', sa.String(length=128), nullable=False),
    sa.Column('task_id', sa.String(length=128), nullable=False),
    sa.Column('revision', sa.Integer(), nullable=False),
    sa.Column('content_hash', sa.String(length=71), nullable=False),
    sa.Column('environment', sa.JSON(), nullable=True),
    sa.Column('lockfile', sa.JSON(), nullable=False),
    sa.Column('lockfile_hash', sa.String(length=71), nullable=False),
    sa.Column('commit_oid', sa.String(length=40), nullable=True),
    sa.Column('moved_by', sa.String(length=256), nullable=False),
    sa.Column('moved_because', sa.String(length=32), nullable=False),
    sa.Column('moved_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('workspace_id', 'task_id')
    )
    with op.batch_alter_table('plugin_audit', schema=None) as batch_op:
        batch_op.add_column(sa.Column('prev_hash', sa.String(length=71), nullable=True))
        batch_op.add_column(sa.Column('entry_hash', sa.String(length=71), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('plugin_audit', schema=None) as batch_op:
        batch_op.drop_column('entry_hash')
        batch_op.drop_column('prev_hash')
    op.drop_table('studio_known_good')
    op.drop_table('task_studio_notes')
