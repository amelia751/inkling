"""todo13-organize: dataset collections, drop plans, dataset structures (todo13 D7, D8, D16)

- `dataset_collections`: a dataset's collections (one logical kind each).
- `tasks.collection_id`: the collection a task works on (null = every collection).
- `drop_plans`: a drop's classification, plan and what applying it created (for Undo).
- `dataset_structures`: `structure.json` per dataset and branch (draft, `work/agent-*`).

Backfill (D16): every existing dataset gets one collection per detected kind among the files it
pins (DICOM files with a series count as `dicom-series`), all `suggested`. A task gets its
dataset's collection when that dataset has exactly one viewable collection; a dataset with
several viewable kinds leaves its tasks at null, so every pre-existing Studio keeps opening on
the same items. Seed datasets keep null too (their items come from the seed manifest).

`downgrade` drops the tables and the column; it never touches files, nodes or datasets.

Revision ID: 0012
Revises: 0010 (the integrator repoints this to 0011, todo13-drops' `drops` migration)
Create Date: 2026-11-01 12:00:00.000000
"""

import json
import uuid
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op

revision = '0012'
down_revision = '0010'
branch_labels = None
depends_on = None

VIEWABLE = {"image", "dicom", "dicom-series", "volume", "video", "waveform", "slide", "mask"}
NAMES = {
    "image": "Images", "dicom": "DICOM images", "dicom-series": "DICOM series", "volume": "3D volumes", "mask": "Masks", "video": "Videos",
    "waveform": "Waveforms", "slide": "Whole-slide images", "table": "Tables", "document": "Documents", "annotations": "Annotation files",
    "archive": "Archives", "unknown": "Files we can't read yet",
}
ORDER = ["dicom-series", "dicom", "volume", "image", "video", "slide", "waveform", "mask", "table", "annotations", "document", "archive", "unknown"]


def _json(v):
    if v is None:
        return {}
    return v if isinstance(v, (dict, list)) else json.loads(v)


def collection_kind(kind, facts) -> str | None:
    if not kind:
        return None
    if kind == "dicom" and isinstance(facts, dict) and isinstance(facts.get("series"), dict):
        return "dicom-series"
    return kind


def upgrade() -> None:
    op.create_table(
        'dataset_collections',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('dataset_id', sa.String(length=128), sa.ForeignKey('datasets.id'), nullable=False),
        sa.Column('project_id', sa.String(length=128), nullable=False),
        sa.Column('name', sa.String(length=256), nullable=False),
        sa.Column('kind', sa.String(length=32), nullable=False),
        sa.Column('shape', sa.JSON(), nullable=False),
        sa.Column('suggested', sa.Boolean(), nullable=False),
        sa.Column('created_by', sa.String(length=256), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_dataset_collections_dataset_id', 'dataset_collections', ['dataset_id'])
    op.create_index('ix_dataset_collections_project_id', 'dataset_collections', ['project_id'])
    with op.batch_alter_table('tasks') as b:
        b.add_column(sa.Column('collection_id', sa.String(length=64), nullable=True))
        b.create_index('ix_tasks_collection_id', ['collection_id'])
    op.create_table(
        'drop_plans',
        sa.Column('drop_id', sa.String(length=64), nullable=False),
        sa.Column('project_id', sa.String(length=128), nullable=False),
        sa.Column('state', sa.String(length=16), nullable=False),
        sa.Column('plan', sa.JSON(), nullable=False),
        sa.Column('groups', sa.JSON(), nullable=False),
        sa.Column('context', sa.JSON(), nullable=False),
        sa.Column('auto', sa.Boolean(), nullable=False),
        sa.Column('fast_path', sa.Boolean(), nullable=False),
        sa.Column('applied', sa.JSON(), nullable=False),
        sa.Column('error', sa.JSON(), nullable=True),
        sa.Column('created_by', sa.String(length=256), nullable=False),
        sa.Column('applied_by', sa.String(length=256), nullable=True),
        sa.Column('applied_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('undo_until', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('drop_id'),
    )
    op.create_index('ix_drop_plans_project_id', 'drop_plans', ['project_id'])
    op.create_table(
        'dataset_structures',
        sa.Column('dataset_id', sa.String(length=128), nullable=False),
        sa.Column('branch', sa.String(length=256), nullable=False),
        sa.Column('project_id', sa.String(length=128), nullable=False),
        sa.Column('structure', sa.JSON(), nullable=False),
        sa.Column('hash', sa.String(length=80), nullable=False),
        sa.Column('updated_by', sa.String(length=256), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('dataset_id', 'branch'),
    )
    op.create_index('ix_dataset_structures_project_id', 'dataset_structures', ['project_id'])
    backfill(op.get_bind())


def backfill(conn) -> None:
    """One collection per detected kind per dataset; tasks of single-viewable-kind datasets get it."""
    at = datetime.now(UTC)
    datasets = conn.execute(sa.text("SELECT id, project_id, definition FROM datasets")).fetchall()
    for ds_id, project_id, raw in datasets:
        definition = _json(raw)
        if conn.execute(sa.text("SELECT 1 FROM dataset_collections WHERE dataset_id = :d LIMIT 1"), {"d": ds_id}).first():
            continue  # resumable: a dataset that has collections is done
        refs = [r for r in definition.get("files") or [] if isinstance(r, dict) and r.get("nodeId")]
        kinds: set[str] = set()
        for i in range(0, len(refs), 500):
            chunk = refs[i : i + 500]
            ids = [str(r["nodeId"]) for r in chunk]
            params = {f"n{j}": nid for j, nid in enumerate(ids)}
            marks = ", ".join(f":n{j}" for j in range(len(ids)))
            nodes = {row[0]: row for row in conn.execute(sa.text(f"SELECT id, version, detected_kind, facts FROM source_nodes WHERE id IN ({marks})"), params)}
            for r in chunk:
                n = nodes.get(str(r["nodeId"]))
                if n is None:
                    continue
                kind, facts = n[2], _json(n[3])
                pinned = int(r.get("version") or 1)
                if pinned != int(n[1] or 1):
                    v = conn.execute(sa.text("SELECT detected_kind, facts FROM node_versions WHERE node_id = :n AND version = :v"), {"n": n[0], "v": pinned}).first()
                    if v is not None:
                        kind, facts = v[0], _json(v[1])
                k = collection_kind(kind, facts)
                if k:
                    kinds.add(k)
        made: dict[str, str] = {}
        for k in sorted(kinds, key=lambda x: ORDER.index(x) if x in ORDER else len(ORDER)):
            cid = f"col-{uuid.uuid4().hex[:20]}"
            conn.execute(
                sa.text("INSERT INTO dataset_collections (id, dataset_id, project_id, name, kind, shape, suggested, created_by, created_at) VALUES (:id, :d, :p, :n, :k, :s, :sg, :by, :at)"),
                {"id": cid, "d": ds_id, "p": project_id, "n": NAMES.get(k, k), "k": k, "s": "{}", "sg": True, "by": "system:backfill", "at": at},
            )
            made[k] = cid
        viewable = [cid for k, cid in made.items() if k in VIEWABLE]
        if len(viewable) == 1 and not definition.get("seed"):
            conn.execute(sa.text("UPDATE tasks SET collection_id = :c WHERE dataset_id = :d AND collection_id IS NULL"), {"c": viewable[0], "d": ds_id})


def downgrade() -> None:
    op.drop_index('ix_dataset_structures_project_id', table_name='dataset_structures')
    op.drop_table('dataset_structures')
    op.drop_index('ix_drop_plans_project_id', table_name='drop_plans')
    op.drop_table('drop_plans')
    with op.batch_alter_table('tasks') as b:
        b.drop_index('ix_tasks_collection_id')
        b.drop_column('collection_id')
    op.drop_index('ix_dataset_collections_project_id', table_name='dataset_collections')
    op.drop_index('ix_dataset_collections_dataset_id', table_name='dataset_collections')
    op.drop_table('dataset_collections')
