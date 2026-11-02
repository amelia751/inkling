"""todo14 D8: per-person preferences, stored server-side (a second browser doesn't repeat a
dismissed first-run hint).

`user_prefs (principal, key, value json, updated_at)`, primary key (principal, key). Small and
generic: the web uses `firstRunHintsDismissed`. `downgrade` drops the table.

Revision ID: 0016
Revises: 0015
Create Date: 2026-11-01 20:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = '0016'
down_revision = '0015'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'user_prefs',
        sa.Column('principal', sa.String(length=256), nullable=False),
        sa.Column('key', sa.String(length=64), nullable=False),
        sa.Column('value', sa.JSON(), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('principal', 'key'),
    )


def downgrade() -> None:
    op.drop_table('user_prefs')
