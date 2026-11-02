"""Stored plugin ids under a legacy namespace (naming.json `legacyNamespaces`) move to the current one.

Readers already canonicalise ids, but workspace installs, grants, configs and catalogue rows are
looked up by their primary key, so a workspace pinned to `<old>.wsi` would look empty once the
bundled catalogue says `<new>.wsi`. Every `plugin_id` column and `plugin_packages.id` are
rewritten. `plugin_audit` is a hash chain and keeps its history as written; JSON documents
(environments, manifests) are canonicalised when read. Where a row under the new id already
exists, it wins and the legacy duplicate is dropped.

Revision ID: 0027
Revises: 0026
Create Date: 2026-11-02 21:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

from studio_api.naming import naming

revision = '0027'
down_revision = '0026'
branch_labels = None
depends_on = None

SKIP = {'plugin_audit'}


def _rewrite(bind, old: str, new: str) -> None:
    insp = sa.inspect(bind)
    tables = set(insp.get_table_names())
    params = {'pat': f'{old}.%', 'new': new, 'cut': len(old) + 1}
    moved = ':new || substr({col}, :cut)'

    if 'plugin_packages' in tables:
        bind.execute(sa.text(
            f"INSERT INTO plugin_packages (id, publisher, license, trust_tier) "
            f"SELECT {moved.format(col='p.id')}, p.publisher, p.license, p.trust_tier FROM plugin_packages p "
            f"WHERE p.id LIKE :pat AND NOT EXISTS (SELECT 1 FROM plugin_packages q WHERE q.id = {moved.format(col='p.id')})"
        ), params)

    for table in sorted(tables - SKIP - {'plugin_packages'}):
        if 'plugin_id' not in {c['name'] for c in insp.get_columns(table)}:
            continue
        pk = insp.get_pk_constraint(table).get('constrained_columns') or []
        if 'plugin_id' in pk:
            same = ' AND '.join([f'n.plugin_id = {moved.format(col="o.plugin_id")}'] + [f'n.{c} = o.{c}' for c in pk if c != 'plugin_id'])
            bind.execute(sa.text(
                f"DELETE FROM {table} WHERE plugin_id LIKE :pat AND EXISTS ("
                f"SELECT 1 FROM {table} n, {table} o WHERE {same} AND o.plugin_id = {table}.plugin_id"
                + ''.join(f' AND o.{c} = {table}.{c}' for c in pk if c != 'plugin_id') + ")"
            ), params)
        bind.execute(sa.text(f"UPDATE {table} SET plugin_id = {moved.format(col='plugin_id')} WHERE plugin_id LIKE :pat"), params)

    if 'plugin_packages' in tables:
        bind.execute(sa.text("DELETE FROM plugin_packages WHERE id LIKE :pat"), params)


def upgrade() -> None:
    n = naming()
    for old in n.get('legacyNamespaces') or []:
        if old != n['namespace']:
            _rewrite(op.get_bind(), old, n['namespace'])


def downgrade() -> None:
    pass
