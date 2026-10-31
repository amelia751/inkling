"""files namespace (todo7 Phase 1)

One drive per project (D1): a root folder per project, every source's top folder moved under
it (names made unique), seed nodes locked (D2). Paths are computed (D4): `rel_path` becomes
the immutable `original_path`. Trash, versions, the journal, stars and recents get their
columns and tables; every file gets version 1. Folder counts are recomputed (now with
`total_bytes`), existing case-only duplicate siblings are numbered (`name_dup`) before the
unique (parent, lower(name)) index is created (D10). Dataset definitions are resolved once
into frozen `files` plus `followedFolders` (D7).

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-30 18:00:00.000000
"""

import hashlib
import re
from datetime import datetime, timezone

import sqlalchemy as sa
from alembic import op

revision = '0005'
down_revision = '0004'
branch_labels = None
depends_on = None

_DIGITS = re.compile(r"\d+")


def _drive_root_id(project_id: str) -> str:
    # Same formula as studio_api.kernel.tree.drive_root_id (migrations don't import app code).
    return "nod-" + hashlib.sha256(f"{project_id}\x1fdrive".encode()).hexdigest()[:20]


def _natural(name: str) -> tuple:
    out, pos = [], 0
    for m in _DIGITS.finditer(name):
        if m.start() > pos:
            out.append((0, name[pos:m.start()].lower(), 0))
        out.append((1, "", int(m.group())))
        pos = m.end()
    if pos < len(name):
        out.append((0, name[pos:].lower(), 0))
    return tuple(out)


def _free(name: str, taken: set) -> str:
    if name.lower() not in taken:
        return name
    i = 2
    while f"{name} ({i})".lower() in taken:
        i += 1
    return f"{name} ({i})"


def _tables():
    m = sa.MetaData()
    nodes = sa.Table('source_nodes', m,
        sa.Column('id', sa.String(64), primary_key=True),
        sa.Column('source_id', sa.String(128)),
        sa.Column('project_id', sa.String(128)),
        sa.Column('project_root', sa.String(64)),
        sa.Column('parent_id', sa.String(64)),
        sa.Column('name', sa.String(512)),
        sa.Column('name_dup', sa.Integer),
        sa.Column('original_path', sa.String(2048)),
        sa.Column('is_dir', sa.Boolean),
        sa.Column('asset_id', sa.String(64)),
        sa.Column('sha256', sa.String(64)),
        sa.Column('size', sa.BigInteger),
        sa.Column('detected_kind', sa.String(32)),
        sa.Column('facts', sa.JSON),
        sa.Column('flags', sa.JSON),
        sa.Column('sequence_key', sa.String(512)),
        sa.Column('child_count', sa.Integer),
        sa.Column('descendant_count', sa.Integer),
        sa.Column('total_bytes', sa.BigInteger),
        sa.Column('revision', sa.Integer),
        sa.Column('locked', sa.Boolean),
        sa.Column('version', sa.Integer),
        sa.Column('trashed_at', sa.DateTime(timezone=True)),
        sa.Column('import_session_id', sa.String(64)),
        sa.Column('created_at', sa.DateTime(timezone=True)))
    versions = sa.Table('node_versions', m,
        sa.Column('node_id', sa.String(64)), sa.Column('version', sa.Integer), sa.Column('project_id', sa.String(128)),
        sa.Column('asset_id', sa.String(64)), sa.Column('sha256', sa.String(64)), sa.Column('size', sa.BigInteger),
        sa.Column('detected_kind', sa.String(32)), sa.Column('facts', sa.JSON), sa.Column('flags', sa.JSON),
        sa.Column('created_by', sa.String(256)), sa.Column('created_at', sa.DateTime(timezone=True)))
    projects = sa.Table('projects', m, sa.Column('id', sa.String(128)), sa.Column('seed', sa.Boolean))
    sources = sa.Table('sources', m, sa.Column('id', sa.String(128)), sa.Column('project_id', sa.String(128)), sa.Column('kind', sa.String(16)), sa.Column('root_node_id', sa.String(64)))
    datasets = sa.Table('datasets', m, sa.Column('id', sa.String(128)), sa.Column('project_id', sa.String(128)), sa.Column('definition', sa.JSON))
    return nodes, versions, projects, sources, datasets


def upgrade() -> None:
    with op.batch_alter_table('source_nodes', schema=None) as b:
        b.alter_column('rel_path', new_column_name='original_path', existing_type=sa.String(length=2048), existing_nullable=False)
        b.alter_column('source_id', existing_type=sa.String(length=128), nullable=True)
        b.alter_column('size', existing_type=sa.Integer(), type_=sa.BigInteger(), existing_nullable=True)
        b.add_column(sa.Column('project_root', sa.String(length=64), nullable=True))
        b.add_column(sa.Column('name_dup', sa.Integer(), nullable=False, server_default='0'))
        b.add_column(sa.Column('total_bytes', sa.BigInteger(), nullable=False, server_default='0'))
        b.add_column(sa.Column('revision', sa.Integer(), nullable=False, server_default='0'))
        b.add_column(sa.Column('locked', sa.Boolean(), nullable=False, server_default=sa.false()))
        b.add_column(sa.Column('version', sa.Integer(), nullable=False, server_default='1'))
        b.add_column(sa.Column('trashed_at', sa.DateTime(timezone=True), nullable=True))
        b.add_column(sa.Column('trashed_by', sa.String(length=256), nullable=True))
        b.add_column(sa.Column('trash_batch_id', sa.String(length=64), nullable=True))
        b.create_index('ix_source_nodes_parent', ['parent_id'], unique=False)
    with op.batch_alter_table('upload_files', schema=None) as b:
        b.add_column(sa.Column('node_id', sa.String(length=64), nullable=True))

    op.create_table('node_versions',
        sa.Column('node_id', sa.String(length=64), nullable=False),
        sa.Column('version', sa.Integer(), nullable=False),
        sa.Column('project_id', sa.String(length=128), nullable=False),
        sa.Column('asset_id', sa.String(length=64), nullable=True),
        sa.Column('sha256', sa.String(length=64), nullable=True),
        sa.Column('size', sa.BigInteger(), nullable=True),
        sa.Column('detected_kind', sa.String(length=32), nullable=True),
        sa.Column('facts', sa.JSON(), nullable=False),
        sa.Column('flags', sa.JSON(), nullable=False),
        sa.Column('created_by', sa.String(length=256), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('node_id', 'version'))
    with op.batch_alter_table('node_versions', schema=None) as b:
        b.create_index(b.f('ix_node_versions_project_id'), ['project_id'], unique=False)
        b.create_index(b.f('ix_node_versions_asset_id'), ['asset_id'], unique=False)
    op.create_table('fs_batches',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('project_id', sa.String(length=128), nullable=False),
        sa.Column('actor', sa.String(length=256), nullable=False),
        sa.Column('kind', sa.String(length=16), nullable=False),
        sa.Column('label', sa.String(length=256), nullable=False),
        sa.Column('summary', sa.Text(), nullable=False),
        sa.Column('undoable', sa.Boolean(), nullable=False),
        sa.Column('reverts_batch_id', sa.String(length=64), nullable=True),
        sa.Column('undone_by', sa.String(length=64), nullable=True),
        sa.Column('redone_by', sa.String(length=64), nullable=True),
        sa.Column('seq', sa.Integer(), nullable=False),
        sa.Column('at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('id'))
    with op.batch_alter_table('fs_batches', schema=None) as b:
        b.create_index(b.f('ix_fs_batches_project_id'), ['project_id'], unique=False)
        b.create_index('ix_fs_batches_actor', ['project_id', 'actor', 'at'], unique=False)
    op.create_table('fs_ops',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('project_id', sa.String(length=128), nullable=False),
        sa.Column('batch_id', sa.String(length=64), nullable=False),
        sa.Column('actor', sa.String(length=256), nullable=False),
        sa.Column('kind', sa.String(length=32), nullable=False),
        sa.Column('node_id', sa.String(length=64), nullable=False),
        sa.Column('before', sa.JSON(), nullable=True),
        sa.Column('after', sa.JSON(), nullable=True),
        sa.Column('at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('undone_by_batch', sa.String(length=64), nullable=True),
        sa.PrimaryKeyConstraint('id'))
    with op.batch_alter_table('fs_ops', schema=None) as b:
        b.create_index(b.f('ix_fs_ops_batch_id'), ['batch_id'], unique=False)
        b.create_index(b.f('ix_fs_ops_node_id'), ['node_id'], unique=False)
        b.create_index('ix_fs_ops_actor', ['project_id', 'actor', 'at'], unique=False)
    for table in ('node_stars', 'node_recent'):
        op.create_table(table,
            sa.Column('node_id', sa.String(length=64), nullable=False),
            sa.Column('principal', sa.String(length=256), nullable=False),
            sa.Column('project_id', sa.String(length=128), nullable=False),
            sa.Column('at', sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint('node_id', 'principal'))
        with op.batch_alter_table(table, schema=None) as b:
            b.create_index(b.f(f'ix_{table}_project_id'), ['project_id'], unique=False)
    op.create_table('scheduled_runs',
        sa.Column('name', sa.String(length=128), nullable=False),
        sa.Column('period', sa.String(length=32), nullable=False),
        sa.Column('result', sa.JSON(), nullable=True),
        sa.Column('at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('name', 'period'))

    _migrate_data()

    op.create_index('ix_source_nodes_trash', 'source_nodes', ['project_id', 'trashed_at'], unique=False,
                    sqlite_where=sa.text('trashed_at IS NOT NULL'), postgresql_where=sa.text('trashed_at IS NOT NULL'))
    op.create_index('uq_source_nodes_sibling_name', 'source_nodes', ['parent_id', sa.text('lower(name)'), 'name_dup'], unique=True,
                    sqlite_where=sa.text('trashed_at IS NULL'), postgresql_where=sa.text('trashed_at IS NULL'))


def _migrate_data() -> None:
    conn = op.get_bind()
    nodes, versions, projects, sources, datasets = _tables()
    at = datetime.now(timezone.utc)
    seed_sources = {r.id for r in conn.execute(sa.select(sources.c.id).where(sources.c.kind == 'seed'))}
    for (pid,) in conn.execute(sa.select(projects.c.id)).all():
        root = _drive_root_id(pid)
        if conn.execute(sa.select(nodes.c.id).where(nodes.c.id == root)).first() is None:
            conn.execute(nodes.insert().values(id=root, source_id=None, project_id=pid, project_root=root, parent_id=None, name='Files', name_dup=0, original_path='', is_dir=True, facts={}, flags={}, child_count=0, descendant_count=0, total_bytes=0, revision=0, locked=False, version=1, created_at=at))
        # Every source's top folder becomes a top-level folder of the drive (D1).
        taken: set = set()
        tops = conn.execute(sa.select(nodes.c.id, nodes.c.name).where(nodes.c.project_id == pid, nodes.c.parent_id.is_(None), nodes.c.id != root).order_by(nodes.c.created_at, nodes.c.id)).all()
        for nid, name in tops:
            new = _free(name, taken)
            taken.add(new.lower())
            conn.execute(nodes.update().where(nodes.c.id == nid).values(parent_id=root, name=new))
        conn.execute(nodes.update().where(nodes.c.project_id == pid).values(project_root=root))
        _recount_and_number(conn, nodes, pid, root)
    if seed_sources:
        conn.execute(nodes.update().where(nodes.c.source_id.in_(sorted(seed_sources))).values(locked=True))
    # Version 1 of every file (D6).
    conn.execute(versions.insert().from_select(
        ['node_id', 'version', 'project_id', 'asset_id', 'sha256', 'size', 'detected_kind', 'facts', 'flags', 'created_by', 'created_at'],
        sa.select(nodes.c.id, sa.literal(1), nodes.c.project_id, nodes.c.asset_id, nodes.c.sha256, nodes.c.size, nodes.c.detected_kind, nodes.c.facts, nodes.c.flags, sa.literal('system:migration'), nodes.c.created_at).where(nodes.c.is_dir == sa.false())))
    _resolve_datasets(conn, nodes, datasets)


def _recount_and_number(conn, nodes, pid: str, root: str) -> None:
    rows = conn.execute(sa.select(nodes.c.id, nodes.c.parent_id, nodes.c.name, nodes.c.is_dir, nodes.c.size, nodes.c.child_count, nodes.c.descendant_count, nodes.c.total_bytes, nodes.c.created_at).where(nodes.c.project_id == pid)).all()
    kids: dict = {}
    for r in rows:
        kids.setdefault(r.parent_id, []).append(r)
    totals: dict = {}
    stack = [(root, False)]
    while stack:
        cur, done = stack.pop()
        if done:
            c = kids.get(cur, [])
            totals[cur] = (len(c), sum(1 if not k.is_dir else totals.get(k.id, (0, 0, 0))[1] for k in c), sum((k.size or 0) if not k.is_dir else totals.get(k.id, (0, 0, 0))[2] for k in c))
            continue
        stack.append((cur, True))
        stack.extend((k.id, False) for k in kids.get(cur, []) if k.is_dir)
    by_id = {r.id: r for r in rows}
    for nid, (c, d, b) in totals.items():
        r = by_id.get(nid)
        if r is None or (r.child_count, r.descendant_count, r.total_bytes) != (c, d, b):
            conn.execute(nodes.update().where(nodes.c.id == nid).values(child_count=c, descendant_count=d, total_bytes=b))
    # Case-only duplicate siblings (`Scan.png`, `scan.png`): allowed, and numbered (D10).
    for parent, members in kids.items():
        groups: dict = {}
        for r in members:
            groups.setdefault(r.name.lower(), []).append(r)
        for same in groups.values():
            if len(same) > 1:
                same.sort(key=lambda r: (r.created_at or datetime.min, r.id))
                for i, r in enumerate(same[1:], start=1):
                    conn.execute(nodes.update().where(nodes.c.id == r.id).values(name_dup=i))


def _resolve_datasets(conn, nodes, datasets) -> None:
    """Folder references become frozen files at version 1 plus followed folders (D7)."""
    cache: dict = {}
    for d in conn.execute(sa.select(datasets.c.id, datasets.c.project_id, datasets.c.definition)).all():
        definition = dict(d.definition or {})
        if isinstance(definition.get('files'), list):
            continue
        if d.project_id not in cache:
            rows = conn.execute(sa.select(nodes.c.id, nodes.c.parent_id, nodes.c.name, nodes.c.is_dir, nodes.c.asset_id).where(nodes.c.project_id == d.project_id)).all()
            kids: dict = {}
            for r in rows:
                kids.setdefault(r.parent_id, []).append(r)
            cache[d.project_id] = ({r.id: r for r in rows}, kids)
        by_id, kids = cache[d.project_id]
        ids = [str(x) for x in definition.get('nodeIds') or []]
        found: dict = {}
        for start in ids:
            if start not in by_id:
                continue
            stack = [(by_id[start], by_id[start].name)]
            while stack:
                n, path = stack.pop()
                if n.is_dir:
                    stack.extend((k, f"{path}/{k.name}") for k in kids.get(n.id, []))
                else:
                    found.setdefault(n.id, (path, n))
        files = [{'nodeId': n.id, 'assetId': n.asset_id, 'version': 1} for _, n in sorted(found.values(), key=lambda pn: _natural(pn[0]))]
        definition['files'] = files
        definition['followedFolders'] = [i for i in ids if i in by_id and by_id[i].is_dir]
        conn.execute(datasets.update().where(datasets.c.id == d.id).values(definition=definition))


def downgrade() -> None:
    """Best effort: the namespace changes made since (new folders, Trash, versions) are lost;
    imports' folders become roots again."""
    op.drop_index('uq_source_nodes_sibling_name', table_name='source_nodes')
    op.drop_index('ix_source_nodes_trash', table_name='source_nodes')
    conn = op.get_bind()
    nodes, *_ = _tables()
    roots = [r.id for r in conn.execute(sa.select(nodes.c.id).where(nodes.c.parent_id.is_(None), nodes.c.source_id.is_(None)))]
    if roots:
        conn.execute(nodes.update().where(nodes.c.parent_id.in_(roots)).values(parent_id=None))
    conn.execute(nodes.delete().where(nodes.c.source_id.is_(None)))
    for table in ('scheduled_runs', 'node_recent', 'node_stars', 'fs_ops', 'fs_batches', 'node_versions'):
        op.drop_table(table)
    with op.batch_alter_table('upload_files', schema=None) as b:
        b.drop_column('node_id')
    with op.batch_alter_table('source_nodes', schema=None) as b:
        b.drop_index('ix_source_nodes_parent')
        for col in ('trash_batch_id', 'trashed_by', 'trashed_at', 'version', 'locked', 'revision', 'total_bytes', 'name_dup', 'project_root'):
            b.drop_column(col)
        b.alter_column('size', existing_type=sa.BigInteger(), type_=sa.Integer(), existing_nullable=True)
        b.alter_column('source_id', existing_type=sa.String(length=128), nullable=False)
        b.alter_column('original_path', new_column_name='rel_path', existing_type=sa.String(length=2048), existing_nullable=False)
