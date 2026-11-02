"""todo18 D8: `blob_delete_retries`, after-commit deletes (blobs, versioning repos) that failed.

Revision ID: 0025
Revises: 0023
Create Date: 2026-11-02 20:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = '0025'
down_revision = '0023'
branch_labels = None
depends_on = None


def upgrade() -> None:
    if sa.inspect(op.get_bind()).has_table('blob_delete_retries'):  # a create_all dev database already has it (todo18 P0-6)
        return
    op.create_table(
        'blob_delete_retries',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('kind', sa.String(length=16), nullable=False),
        sa.Column('target', sa.String(length=2048), nullable=False),
        sa.Column('attempts', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('last_error', sa.String(length=512), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table('blob_delete_retries')
