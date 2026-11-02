"""todo14 D7: the Samples templates are read-only.

Until now `ensure_principal` made every `user:` principal an `editor` of the shared Samples
org, so one person's labels on a sample showed up for everyone. Remaining Samples memberships
(dev only, `API_SAMPLE_MEMBERS`) become `viewer`; editing a sample means taking a copy.
Annotations already written on shared samples stay. Data only, no schema change.

`downgrade` turns Samples `viewer` rows back into `editor` (every membership there was an
editor before this revision).

Revision ID: 0013
Revises: 0012
Create Date: 2026-11-01 18:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = '0013'
down_revision = '0012'
branch_labels = None
depends_on = None

SAMPLES_ORG = "org-samples"


def upgrade() -> None:
    op.get_bind().execute(sa.text("UPDATE organization_members SET role = 'viewer' WHERE org_id = :org AND role = 'editor'"), {"org": SAMPLES_ORG})


def downgrade() -> None:
    op.get_bind().execute(sa.text("UPDATE organization_members SET role = 'editor' WHERE org_id = :org AND role = 'viewer'"), {"org": SAMPLES_ORG})
