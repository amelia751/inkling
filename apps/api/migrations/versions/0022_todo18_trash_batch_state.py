"""todo18 B: `fs_batches.state`, the Trash batch lock (restoring | destroying | restored | destroyed).

Revision ID: 0022
Revises: 0021
Create Date: 2026-11-02 20:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = '0022'
down_revision = '0021'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('fs_batches', sa.Column('state', sa.String(length=16), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('fs_batches') as b:
        b.drop_column('state')
