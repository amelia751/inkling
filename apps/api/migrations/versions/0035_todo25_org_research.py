"""todo25 W7: `organizations.research`, which lets an org select providers whose model weights
are licensed for research or non-commercial use only.

Revision ID: 0035
Revises: 0034
Create Date: 2026-11-04 18:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = '0035'
down_revision = '0034'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('organizations', sa.Column('research', sa.Boolean(), server_default=sa.false(), nullable=False))


def downgrade() -> None:
    op.drop_column('organizations', 'research')
