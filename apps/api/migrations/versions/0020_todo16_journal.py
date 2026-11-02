"""todo16 D9: the assistant's turns are journaled in the database, not in the agent.

`fs_batches` gains `on_behalf_of` (the person an assistant acted for; NULL for a person's own
change) and `turn_id` (the assistant turn, `X-Turn-Id`; indexed with the project for
`GET /projects/{pid}/turns/{turnId}`). `actor` and `summary` already exist. Plain nullable
ADD COLUMN, like 0018, so an existing SQLite dev DB upgrades in place.

Revision ID: 0020
Revises: 0019
Create Date: 2026-11-02 14:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = '0020'
down_revision = '0019'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('fs_batches', sa.Column('on_behalf_of', sa.String(length=256), nullable=True))
    op.add_column('fs_batches', sa.Column('turn_id', sa.String(length=64), nullable=True))
    op.create_index('ix_fs_batches_turn', 'fs_batches', ['project_id', 'turn_id'])


def downgrade() -> None:
    op.drop_index('ix_fs_batches_turn', table_name='fs_batches')
    op.drop_column('fs_batches', 'turn_id')
    op.drop_column('fs_batches', 'on_behalf_of')
