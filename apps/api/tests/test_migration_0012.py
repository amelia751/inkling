"""todo13 D16: the collections backfill migration on a database with datasets and tasks made
before collections, up and down. Every pre-existing Studio opens on the same items after it."""

from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import command

from studio_api import db
from studio_api.models import SourceNode, Workspace

from .test_migrations import _alembic_at

T = "2026-11-01 10:00:00"


def _node(nid: str, kind: str, facts: dict | None = None) -> SourceNode:
    return SourceNode(id=nid, project_id="p1", parent_id="root", project_root="root", name=f"{nid}.bin", original_path=f"{nid}.bin", is_dir=False, asset_id=f"a-{nid}", sha256=nid.ljust(64, "0")[:64], size=10, detected_kind=kind, facts=facts or {}, flags={}, version=1)


def test_0012_backfills_collections_and_task_collections_then_downgrades(tmp_path):
    cfg = _alembic_at(tmp_path, "0011")
    with db.engine().begin() as c:  # raw SQL: the Organization model has todo9 columns 0011 lacks
        c.execute(sa.text("INSERT INTO organizations (id, name, kind, created_at) VALUES ('o', 'O', 'team', :t)"), {"t": T})
    with db.session_scope() as s:
        s.add(Workspace(id="p1", name="p1"))
    with db.engine().begin() as c:  # raw SQL: the ProjectRow model has todo14's sample_of
        c.execute(sa.text("INSERT INTO projects (id, org_id, title, description, visibility, seed, archived, created_by, created_at, updated_at) VALUES ('p1', 'o', 'P', '', 'private', 0, 0, 'user:a', :t, :t)"), {"t": T})
    with db.session_scope() as s:
        s.add(SourceNode(id="root", project_id="p1", name="Files", is_dir=True, original_path=""))
        for n in [_node("img1", "image"), _node("img2", "image"), _node("ct1", "dicom", {"series": {"seriesUidHash": "s"}}), _node("csv1", "table"), _node("cr1", "dicom")]:
            s.add(n)
    refs = lambda *ids: json.dumps({"files": [{"nodeId": i, "assetId": f"a-{i}", "version": 1} for i in ids], "nodeIds": list(ids), "followedFolders": []})  # noqa: E731
    with db.engine().begin() as c:
        for ds, files in (("ds-single", refs("img1", "img2", "csv1")), ("ds-mixed", refs("img1", "ct1", "cr1")), ("ds-empty", json.dumps({"files": [], "nodeIds": []}))):
            c.execute(sa.text("INSERT INTO datasets (id, project_id, title, description, definition, created_by, created_at) VALUES (:d, 'p1', :d, '', :f, 'user:a', :t)"), {"d": ds, "f": files, "t": T})
        for tid, ds in (("t-single", "ds-single"), ("t-mixed", "ds-mixed"), ("t-empty", "ds-empty")):
            c.execute(sa.text("INSERT INTO tasks (id, dataset_id, project_id, title, kind, revision, created_by, created_at, state) VALUES (:t, :d, 'p1', :t, 'annotate', 0, 'user:a', :at, 'published')"), {"t": tid, "d": ds, "at": T})

    command.upgrade(cfg, "0012")
    with db.engine().begin() as c:
        cols = c.execute(sa.text("SELECT dataset_id, kind, suggested FROM dataset_collections ORDER BY dataset_id, kind")).fetchall()
        assert [(d, k) for d, k, _ in cols] == [("ds-mixed", "dicom"), ("ds-mixed", "dicom-series"), ("ds-mixed", "image"), ("ds-single", "image"), ("ds-single", "table")]
        assert all(bool(sg) for *_, sg in cols)
        tasks = dict(c.execute(sa.text("SELECT id, collection_id FROM tasks")).fetchall())
        single_image = c.execute(sa.text("SELECT id FROM dataset_collections WHERE dataset_id = 'ds-single' AND kind = 'image'")).scalar()
        assert tasks == {"t-single": single_image, "t-mixed": None, "t-empty": None}
        assert {"drop_plans", "dataset_structures"} <= set(sa.inspect(c).get_table_names())

    # Every pre-existing Studio opens on the same items (task_document, the kernel's own code,
    # which reads today's models: so at head, with the later revisions' columns).
    command.upgrade(cfg, "head")
    from studio_api.kernel import projects
    from studio_api.models import Asset, TaskRow

    with db.session_scope() as s:
        for n in ("img1", "img2", "ct1", "cr1", "csv1"):
            s.add(Asset(id=f"a-{n}", workspace_id="p1", path=f"sources/p1/{n}", media_type="application/octet-stream", size=10))
        s.flush()
        names = {t: sorted(a["nodeId"] for a in projects.task_document(s, s.get(TaskRow, t))["assets"]) for t in ("t-single", "t-mixed", "t-empty")}
    assert names == {"t-single": ["img1", "img2"], "t-mixed": ["cr1", "ct1", "img1"], "t-empty": []}

    command.downgrade(cfg, "0011")
    with db.engine().begin() as c:
        names = set(sa.inspect(c).get_table_names())
        assert not {"dataset_collections", "drop_plans", "dataset_structures"} & names
        assert "collection_id" not in {col["name"] for col in sa.inspect(c).get_columns("tasks")}
        # Files and datasets untouched.
        assert c.execute(sa.text("SELECT count(*) FROM source_nodes")).scalar() == 6
        assert c.execute(sa.text("SELECT count(*) FROM datasets")).scalar() == 3
        assert c.execute(sa.text("SELECT count(*) FROM tasks")).scalar() == 3
    command.upgrade(cfg, "head")
    db.reset_engine()
