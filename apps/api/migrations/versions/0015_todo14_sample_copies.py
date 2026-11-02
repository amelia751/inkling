"""todo14 D2: samples are opt-in copies.

`projects.sample_of`: the Samples template a project was copied from (null for everything
else). A copy's assets point at the template's blob keys; no bytes are copied, so nothing to
migrate. `downgrade` drops the column (copies stay as ordinary projects).

Revision ID: 0015
Revises: 0014
Create Date: 2026-11-01 19:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = '0015'
down_revision = '0014'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('projects', sa.Column('sample_of', sa.String(length=128), nullable=True))
    op.create_index('ix_projects_sample_of', 'projects', ['sample_of'])


def downgrade() -> None:
    op.drop_index('ix_projects_sample_of', table_name='projects')
    op.drop_column('projects', 'sample_of')
