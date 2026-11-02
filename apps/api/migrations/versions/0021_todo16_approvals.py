"""todo16 D8: `approvals_used`, the single-use ledger of assistant destroy approvals.

Revision ID: 0021
Revises: 0020
Create Date: 2026-11-02 18:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = '0021'
down_revision = '0020'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'approvals_used',
        sa.Column('approval_id', sa.String(length=128), primary_key=True),
        sa.Column('person', sa.String(length=256), nullable=True),
        sa.Column('operation', sa.String(length=64), nullable=True),
        sa.Column('project_id', sa.String(length=128), nullable=True),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('used_at', sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table('approvals_used')
