"""dataset versioning integration tables (todo4 Phase 6)

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-30 12:00:00
"""

from alembic import op
import sqlalchemy as sa


revision = '0002'
down_revision = '0001'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table('dataset_repos',
    sa.Column('workspace_id', sa.String(length=128), nullable=False),
    sa.Column('dataset_id', sa.String(length=128), nullable=False),
    sa.Column('repo_id', sa.String(length=64), nullable=False),
    sa.Column('created_by', sa.String(length=256), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('workspace_id', 'dataset_id')
    )
    op.create_table('session_delegations',
    sa.Column('token_hash', sa.String(length=64), nullable=False),
    sa.Column('on_behalf_of', sa.String(length=256), nullable=False),
    sa.PrimaryKeyConstraint('token_hash')
    )
    op.create_table('versioned_annotation_payloads',
    sa.Column('workspace_id', sa.String(length=128), nullable=False),
    sa.Column('ref', sa.String(length=80), nullable=False),
    sa.Column('annotation_id', sa.String(length=256), nullable=False),
    sa.Column('cache_key', sa.String(length=64), nullable=False),
    sa.Column('annotation', sa.JSON(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('workspace_id', 'ref')
    )
    with op.batch_alter_table('versioned_annotation_payloads', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_versioned_annotation_payloads_annotation_id'), ['annotation_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_versioned_annotation_payloads_cache_key'), ['cache_key'], unique=False)
    op.create_table('event_consumptions',
    sa.Column('subscriber', sa.String(length=128), nullable=False),
    sa.Column('event_id', sa.String(length=64), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('subscriber', 'event_id')
    )


def downgrade() -> None:
    op.drop_table('event_consumptions')
    with op.batch_alter_table('versioned_annotation_payloads', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_versioned_annotation_payloads_cache_key'))
        batch_op.drop_index(batch_op.f('ix_versioned_annotation_payloads_annotation_id'))
    op.drop_table('versioned_annotation_payloads')
    op.drop_table('session_delegations')
    op.drop_table('dataset_repos')
