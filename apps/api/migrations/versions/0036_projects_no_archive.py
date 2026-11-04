"""Projects have no archive any more: Delete moves one to Trash for 30 days. Archived projects
come back to the list; `projects.archived` stays as an unused column.

Revision ID: 0036
Revises: 0035
Create Date: 2026-11-04 21:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = '0036'
down_revision = '0035'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(sa.text("UPDATE projects SET archived = false WHERE archived"))


def downgrade() -> None:
    pass
