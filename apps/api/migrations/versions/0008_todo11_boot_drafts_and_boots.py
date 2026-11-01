"""todo11-boot: draft tasks, boots, and the task an agent token was opened on

- `tasks.state` (`draft` | `published`, default `published`), `boot_id`, `booted_by`,
  `published_by`, `published_at`: a boot makes drafts; only a person publishes (D1).
- `boots`: one row per bootId (idempotent `POST /api/v1/projects/:id/boots`).
- `session_delegations.task_id`: the task a person had open when minting an agent token; the
  agent may write that task's environment (D2.1).

Revision ID: 0008
Revises: 0006b
Create Date: 2026-10-31 18:00:00.000000

(down_revision is 0006b, the current head; the integrator re-chains if needed.)
"""

import sqlalchemy as sa
from alembic import op

revision = '0008'
down_revision = '0006b'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table('tasks') as b:
        b.add_column(sa.Column('state', sa.String(length=16), nullable=False, server_default='published'))
        b.add_column(sa.Column('boot_id', sa.String(length=64), nullable=True))
        b.add_column(sa.Column('booted_by', sa.String(length=256), nullable=True))
        b.add_column(sa.Column('published_by', sa.String(length=256), nullable=True))
        b.add_column(sa.Column('published_at', sa.DateTime(timezone=True), nullable=True))
        b.create_index('ix_tasks_boot_id', ['boot_id'])
    with op.batch_alter_table('session_delegations') as b:
        b.add_column(sa.Column('task_id', sa.String(length=128), nullable=True))
    op.create_table(
        'boots',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('project_id', sa.String(length=128), nullable=False),
        sa.Column('preset', sa.String(length=128), nullable=False),
        sa.Column('state', sa.String(length=16), nullable=False),
        sa.Column('task_ids', sa.JSON(), nullable=False),
        sa.Column('steps', sa.JSON(), nullable=False),
        sa.Column('initiator', sa.JSON(), nullable=False),
        sa.Column('principal', sa.String(length=256), nullable=False),
        sa.Column('on_behalf_of', sa.String(length=256), nullable=False),
        sa.Column('request_hash', sa.String(length=80), nullable=False),
        sa.Column('error', sa.JSON(), nullable=True),
        sa.Column('ms', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_boots_project_id', 'boots', ['project_id'])


def downgrade() -> None:
    op.drop_index('ix_boots_project_id', table_name='boots')
    op.drop_table('boots')
    with op.batch_alter_table('session_delegations') as b:
        b.drop_column('task_id')
    with op.batch_alter_table('tasks') as b:
        b.drop_index('ix_tasks_boot_id')
        for c in ('published_at', 'published_by', 'booted_by', 'boot_id', 'state'):
            b.drop_column(c)
