"""todo25 W7: `organizations.research`, which lets an org select providers whose model weights
are licensed for research or non-commercial use only.

Revision ID: 0034
Revises: 0033
Create Date: 2026-11-04 18:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = '0034'
down_revision = '0033'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('organizations', sa.Column('research', sa.Boolean(), server_default=sa.false(), nullable=False))


def downgrade() -> None:
    with op.batch_alter_table('organizations') as batch:
        batch.drop_column('research')
