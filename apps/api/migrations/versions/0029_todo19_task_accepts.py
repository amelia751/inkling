"""todo19 D2: a task accepts a set of item kinds from its dataset (`tasks.accepts`, JSON, null =
no kind filter: legacy tasks keep their `collection_id`).

Revision ID: 0029
Revises: 0028
Create Date: 2026-11-02 22:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = '0029'
down_revision = '0028'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('tasks', sa.Column('accepts', sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column('tasks', 'accepts')
