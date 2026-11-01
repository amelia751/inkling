"""todo13-drops: drops, import origin and name screening (todo13 §5 "Drop", D3, D13)

- `drops`: one row per drop gesture (chat, files, studio, home), with its conversation and
  message, the `Shared in chat/<conversation>` folder it landed in, and its state.
- `import_sessions.drop_id`: the drop a session belongs to.
- `source_nodes.agent_name` / `name_flagged`: the screened name agents see (None until screened;
  the screening backfill fills existing nodes, `python -m studio_api.kernel.name_screen backfill`).

Additive only: `downgrade` drops the table and the columns; no file is touched.

Revision ID: 0011
Revises: 0010
Create Date: 2026-11-01 12:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = '0011'
down_revision = '0010'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'drops',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('project_id', sa.String(length=128), nullable=False),
        sa.Column('origin', sa.String(length=16), nullable=False),
        sa.Column('conversation_id', sa.String(length=128), nullable=True),
        sa.Column('message_id', sa.String(length=128), nullable=True),
        sa.Column('task_id', sa.String(length=128), nullable=True),
        sa.Column('dataset_id', sa.String(length=128), nullable=True),
        sa.Column('folder_node_id', sa.String(length=64), nullable=True),
        sa.Column('state', sa.String(length=16), nullable=False),
        sa.Column('declared', sa.JSON(), nullable=False),
        sa.Column('removed', sa.JSON(), nullable=False),
        sa.Column('created_by', sa.String(length=256), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_drops_project_id', 'drops', ['project_id'])
    op.create_index('ix_drops_conversation', 'drops', ['project_id', 'conversation_id'])
    op.create_index('ix_drops_rate', 'drops', ['created_by', 'created_at'])
    # Plain ALTERs (no batch copy on SQLite: it would lose source_nodes' expression index).
    op.add_column('import_sessions', sa.Column('drop_id', sa.String(length=64), nullable=True))
    op.create_index('ix_import_sessions_drop_id', 'import_sessions', ['drop_id'])
    op.add_column('source_nodes', sa.Column('agent_name', sa.String(length=512), nullable=True))
    op.add_column('source_nodes', sa.Column('name_flagged', sa.Boolean(), nullable=True))


def downgrade() -> None:
    op.drop_column('source_nodes', 'name_flagged')
    op.drop_column('source_nodes', 'agent_name')
    op.drop_index('ix_import_sessions_drop_id', table_name='import_sessions')
    op.drop_column('import_sessions', 'drop_id')
    op.drop_index('ix_drops_rate', table_name='drops')
    op.drop_index('ix_drops_conversation', table_name='drops')
    op.drop_index('ix_drops_project_id', table_name='drops')
    op.drop_table('drops')
