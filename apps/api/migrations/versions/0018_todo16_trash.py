"""todo16 D2: everything a project owns goes to Trash first.

`trashed_at`, `trashed_by`, `trash_batch_id` (+ an index) on `datasets`, `dataset_collections`,
`tasks` (Studios) and `projects`, as `source_nodes` already has. `fs_batches.resource` says what a
batch moved (`source` for the drive's own batches). `downgrade` drops them.

Revision ID: 0018
Revises: 0017
Create Date: 2026-11-02 12:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = '0018'
down_revision = '0017'
branch_labels = None
depends_on = None

TABLES = ('datasets', 'dataset_collections', 'tasks', 'projects')


def upgrade() -> None:
    for t in TABLES:
        # Plain ADD COLUMN (no table rebuild: SQLite would trip over the foreign keys).
        op.add_column(t, sa.Column('trashed_at', sa.DateTime(timezone=True), nullable=True))
        op.add_column(t, sa.Column('trashed_by', sa.String(length=256), nullable=True))
        op.add_column(t, sa.Column('trash_batch_id', sa.String(length=64), nullable=True))
        op.create_index(f'ix_{t}_trash_batch_id', t, ['trash_batch_id'])
    op.add_column('fs_batches', sa.Column('resource', sa.String(length=16), nullable=False, server_default='source'))


def downgrade() -> None:
    op.drop_column('fs_batches', 'resource')
    for t in TABLES:
        op.drop_index(f'ix_{t}_trash_batch_id', table_name=t)
        for c in ('trash_batch_id', 'trashed_by', 'trashed_at'):
            op.drop_column(t, c)
