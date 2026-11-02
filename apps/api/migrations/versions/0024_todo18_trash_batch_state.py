"""todo18 B: `fs_batches.state`, the Trash batch lock (restoring | destroying | restored | destroyed).

Revision ID: 0024
Revises: 0023
Create Date: 2026-11-02 20:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = '0024'
down_revision = '0023'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Idempotent: a dev database built by create_all may already have the column (todo18 P0-6).
    if 'state' in {c['name'] for c in sa.inspect(op.get_bind()).get_columns('fs_batches')}:
        return
    op.add_column('fs_batches', sa.Column('state', sa.String(length=16), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('fs_batches') as b:
        b.drop_column('state')
