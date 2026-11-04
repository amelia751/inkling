"""todo25 D4: `organizations.managed_provider_keys` (null = the stage's default).

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
    op.add_column('organizations', sa.Column('managed_provider_keys', sa.Boolean(), nullable=True))


def downgrade() -> None:
    op.drop_column('organizations', 'managed_provider_keys')
