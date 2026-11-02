"""todo18 D4: `derivatives`, browser-viewable files the worker makes from a source node
(video → H.264 MP4, slide → DZI pyramid), keyed by content hash, purged with the source.

Revision ID: 0023
Revises: 0021
Create Date: 2026-11-02 20:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = '0023'
down_revision = '0021'  # todo18: 0022 (W1) lands first at merge; rebase this to '0022' then
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'derivatives',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('project_id', sa.String(length=128), nullable=False, index=True),
        sa.Column('source_node_id', sa.String(length=64), nullable=False, index=True),
        sa.Column('kind', sa.String(length=32), nullable=False),
        sa.Column('sha', sa.String(length=128), nullable=True),
        sa.Column('blob_key', sa.String(length=1024), nullable=True),
        sa.Column('blob_keys', sa.JSON(), nullable=True),
        sa.Column('state', sa.String(length=16), nullable=False, server_default='pending'),
        sa.Column('progress', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('attempts', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('error', sa.Text(), nullable=True),
        sa.Column('meta', sa.JSON(), nullable=True),
        sa.Column('lease_until', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint('source_node_id', 'kind', name='uq_derivatives_node_kind'),
    )


def downgrade() -> None:
    op.drop_table('derivatives')
