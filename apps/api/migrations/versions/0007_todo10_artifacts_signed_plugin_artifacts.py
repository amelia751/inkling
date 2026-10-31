"""todo10 artifacts: signed, content-addressed plugin artifacts and promotion reviews

`plugin_artifacts` replaces the dev-only `registry-generated.json` file and the
`plugin-artifacts/<id>/<version>/` tree under the API data dir: the bytes now live in the
BlobStore at `artifacts/sha256/<hex>` and this table is their registry entry. Generated
artifacts from before this revision were local dev files only; rebuild them (POST
/api/v1/plugins/artifacts) if you still need them.

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-31 12:00:00.000000

(down_revision is 0006, todo10-studio-defs; the integrator re-chains if needed.)
"""

import sqlalchemy as sa
from alembic import op

revision = '0007'
down_revision = '0006'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'plugin_artifacts',
        sa.Column('plugin_id', sa.String(length=256), nullable=False),
        sa.Column('version', sa.String(length=64), nullable=False),
        sa.Column('manifest_digest', sa.String(length=80), nullable=False),
        sa.Column('artifact_digest', sa.String(length=80), nullable=False),
        sa.Column('trust_tier', sa.String(length=32), nullable=False),
        sa.Column('publisher', sa.String(length=256), nullable=False),
        sa.Column('workspace_id', sa.String(length=128), nullable=True),
        sa.Column('org_id', sa.String(length=64), nullable=True),
        sa.Column('manifest', sa.JSON(), nullable=False),
        sa.Column('signature', sa.JSON(), nullable=False),
        sa.Column('referrers', sa.JSON(), nullable=False),
        sa.Column('attestation_digest', sa.String(length=80), nullable=True),
        sa.Column('review', sa.JSON(), nullable=True),
        sa.Column('licenses', sa.JSON(), nullable=False),
        sa.Column('source', sa.String(length=32), nullable=False),
        sa.Column('created_by', sa.String(length=256), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('promoted_by', sa.String(length=256), nullable=True),
        sa.Column('promoted_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('plugin_id', 'version'),
    )
    with op.batch_alter_table('plugin_artifacts', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_plugin_artifacts_manifest_digest'), ['manifest_digest'], unique=False)
        batch_op.create_index(batch_op.f('ix_plugin_artifacts_workspace_id'), ['workspace_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_plugin_artifacts_org_id'), ['org_id'], unique=False)

    op.create_table(
        'plugin_promotions',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('plugin_id', sa.String(length=256), nullable=False),
        sa.Column('version', sa.String(length=64), nullable=False),
        sa.Column('manifest_digest', sa.String(length=80), nullable=False),
        sa.Column('from_tier', sa.String(length=32), nullable=False),
        sa.Column('to_tier', sa.String(length=32), nullable=False),
        sa.Column('state', sa.String(length=16), nullable=False),
        sa.Column('requested_by', sa.String(length=256), nullable=False),
        sa.Column('reviewed_by', sa.String(length=256), nullable=True),
        sa.Column('reason', sa.Text(), nullable=False),
        sa.Column('workspace_id', sa.String(length=128), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('reviewed_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    with op.batch_alter_table('plugin_promotions', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_plugin_promotions_plugin_id'), ['plugin_id'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('plugin_promotions', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_plugin_promotions_plugin_id'))
    op.drop_table('plugin_promotions')
    with op.batch_alter_table('plugin_artifacts', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_plugin_artifacts_org_id'))
        batch_op.drop_index(batch_op.f('ix_plugin_artifacts_workspace_id'))
        batch_op.drop_index(batch_op.f('ix_plugin_artifacts_manifest_digest'))
    op.drop_table('plugin_artifacts')
