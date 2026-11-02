"""todo19 D10: `worker_capabilities`, the converters each worker reports (with a TTL).

Revision ID: 0028
Revises: 0027
Create Date: 2026-11-02 22:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = '0028'
down_revision = '0027'
branch_labels = None
depends_on = None


def upgrade() -> None:
    if not sa.inspect(op.get_bind()).has_table('worker_capabilities'):  # a create_all dev database already has it
        op.create_table(
            'worker_capabilities',
            sa.Column('worker_id', sa.String(length=128), primary_key=True),
            sa.Column('capabilities', sa.JSON(), nullable=False),
            sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False, index=True),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        )
    # todo19 P0-2: slides that failed only because OpenSlide wasn't installed wait for a converter.
    op.execute(
        "UPDATE derivatives SET state = 'waiting', attempts = 0, error = 'Waiting for a converter: OpenSlide' "
        "WHERE state = 'failed' AND error LIKE '%isn''t installed%' AND kind = 'slide-dzi'"
    )
    op.execute(
        "UPDATE derivatives SET state = 'waiting', attempts = 0, error = 'Waiting for a converter: ffmpeg' "
        "WHERE state = 'failed' AND error LIKE '%isn''t installed%' AND kind = 'video-mp4'"
    )


def downgrade() -> None:
    op.drop_table('worker_capabilities')
