"""todo23 W9: artifact reviews (`review.v1` rows per artifact version) and hidden tests.

Revision ID: 0032
Revises: 0031
Create Date: 2026-11-04 12:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = '0032'
down_revision = '0031'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'artifact_reviews',
        sa.Column('id', sa.String(32), primary_key=True),
        sa.Column('workspace_id', sa.String(128), nullable=False, index=True),
        sa.Column('artifact_kind', sa.String(64), nullable=False),
        sa.Column('artifact_id', sa.String(256), nullable=False),
        sa.Column('artifact_version', sa.String(128), nullable=False),
        sa.Column('review', sa.JSON(), nullable=False),
        sa.Column('verdict', sa.String(16), nullable=False),
        sa.Column('reviewer', sa.String(256), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_artifact_reviews_artifact', 'artifact_reviews', ['artifact_kind', 'artifact_id', 'artifact_version'])
    op.create_table(
        'hidden_tests',
        sa.Column('id', sa.String(32), primary_key=True),
        sa.Column('workspace_id', sa.String(128), nullable=False, index=True),
        sa.Column('artifact_kind', sa.String(64), nullable=False),
        sa.Column('artifact_id', sa.String(256), nullable=False),
        sa.Column('artifact_version', sa.String(128), nullable=False),
        sa.Column('path', sa.String(512), nullable=False),
        sa.Column('content', sa.Text(), nullable=False),
        sa.Column('created_by', sa.String(256), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table('hidden_tests')
    op.drop_index('ix_artifact_reviews_artifact', table_name='artifact_reviews')
    op.drop_table('artifact_reviews')
