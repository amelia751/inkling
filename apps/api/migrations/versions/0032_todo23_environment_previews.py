"""todo23 W6: `environment_previews`, a generated Studio booted as a preview (D8).

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
        'environment_previews',
        sa.Column('id', sa.String(64), primary_key=True),
        sa.Column('project_id', sa.String(128), sa.ForeignKey('projects.id'), nullable=False),
        sa.Column('task_id', sa.String(128), nullable=False),
        sa.Column('environment', sa.JSON(), nullable=False),
        sa.Column('plugin_versions', sa.JSON(), nullable=False),
        sa.Column('requested_by', sa.String(256), nullable=False),
        sa.Column('status', sa.String(16), nullable=False),
        sa.Column('verification', sa.JSON(), nullable=True),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('kept_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index('ix_environment_previews_project_id', 'environment_previews', ['project_id'])
    op.create_index('ix_environment_previews_task_id', 'environment_previews', ['task_id'])
    op.create_index('ix_environment_previews_requested_by', 'environment_previews', ['requested_by'])


def downgrade() -> None:
    op.drop_table('environment_previews')
