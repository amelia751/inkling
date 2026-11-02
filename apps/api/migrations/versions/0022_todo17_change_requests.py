"""todo17 D7: change requests (an agent's operations on published things, reviewed or auto-merged)
and their comments.

The brief reserved '0020' for this, but todo16's journal and approvals took 0020 and 0021 on
main first; history stays linear, so this is 0022.

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
    op.create_table(
        'change_requests',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('project_id', sa.String(length=128), sa.ForeignKey('projects.id'), nullable=False),
        sa.Column('title', sa.String(length=300), nullable=False, server_default=''),
        sa.Column('actor', sa.String(length=256), nullable=False),
        sa.Column('on_behalf_of', sa.String(length=256), nullable=True),
        sa.Column('agent', sa.String(length=256), nullable=True),
        sa.Column('state', sa.String(length=16), nullable=False),
        sa.Column('base', sa.JSON(), nullable=False),
        sa.Column('operations', sa.JSON(), nullable=False),
        sa.Column('findings', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('merged_by', sa.String(length=256), nullable=True),
        sa.Column('merged_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index('ix_change_requests_project_state', 'change_requests', ['project_id', 'state'])
    op.create_table(
        'change_request_comments',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('change_request_id', sa.String(length=64), sa.ForeignKey('change_requests.id'), nullable=False, index=True),
        sa.Column('author', sa.String(length=256), nullable=False),
        sa.Column('body', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table('change_request_comments')
    op.drop_index('ix_change_requests_project_state', table_name='change_requests')
    op.drop_table('change_requests')
