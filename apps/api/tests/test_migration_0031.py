"""0030/0031 (todo20 D3, D4, D7): `default_task_id`; dataset proposals dismissed; a drop's
per-kind Studios without annotations combine into one "Studio" and the rest (plus "Annotate"
Studios from proposals) go to one Trash batch per project, restorable."""

from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import command

from studio_api import db

from .test_migrations import _alembic_at

T = "2026-11-02 10:00:00"


def _task(c, tid, ds, title, boot=None, col=None):
    c.execute(sa.text("INSERT INTO tasks (id, dataset_id, project_id, title, kind, revision, created_by, created_at, state, boot_id, collection_id) VALUES (:id, :ds, 'p1', :t, 'annotate', 0, 'user:a', :at, 'draft', :b, :c)"), {"id": tid, "ds": ds, "t": title, "at": T, "b": boot, "c": col})


def test_0031_combines_per_kind_studios_and_trashes_the_rest(tmp_path):
    cfg = _alembic_at(tmp_path, "0029")
    with db.engine().begin() as c:
        c.execute(sa.text("INSERT INTO organizations (id, name, kind, created_at) VALUES ('o', 'O', 'team', :t)"), {"t": T})
        c.execute(sa.text("INSERT INTO workspaces (id, name, created_at) VALUES ('p1', 'p1', :t)"), {"t": T})
        c.execute(sa.text("INSERT INTO projects (id, org_id, title, description, visibility, seed, archived, created_by, created_at, updated_at) VALUES ('p1', 'o', 'P', '', 'private', 0, 0, 'user:a', :t, :t)"), {"t": T})
        for ds, prop in (("ds1", None), ("ds2", "prop-1")):
            c.execute(sa.text("INSERT INTO datasets (id, project_id, title, description, definition, created_by, created_at, created_from_proposal_id) VALUES (:d, 'p1', 'D', '', '{}', 'user:a', :t, :p)"), {"d": ds, "t": T, "p": prop})
        for col, kind in (("col-a", "image"), ("col-b", "waveform"), ("col-c", "video")):
            c.execute(sa.text("INSERT INTO dataset_collections (id, dataset_id, project_id, name, kind, shape, suggested, created_by, created_at) VALUES (:c, 'ds1', 'p1', :k, :k, '{}', 1, 'user:a', :t)"), {"c": col, "k": kind, "t": T})
        _task(c, "t-img", "ds1", "Images Studio", "drop-drp-1-col-a", "col-a")
        _task(c, "t-wave", "ds1", "Waveforms Studio", "drop-drp-1-col-b", "col-b")
        _task(c, "t-vid", "ds1", "Videos Studio", "drop-drp-1-col-c", "col-c")
        _task(c, "t-ann", "ds2", "Annotate")
        for tid, preset in (("t-img", "preset:image-2d"), ("t-wave", "preset:ecg")):
            c.execute(sa.text("INSERT INTO workspace_environments (workspace_id, task_id, revision, environment) VALUES ('p1', :t, 1, :e)"), {"t": tid, "e": json.dumps({"extends": preset})})
        # The video Studio has annotations: it stays as it is.
        c.execute(sa.text("INSERT INTO annotation_documents (workspace_id, task_id, revision, annotations) VALUES ('p1', 't-vid', 1, :a)"), {"a": json.dumps([{"id": "a1"}])})
        c.execute(sa.text("INSERT INTO proposals (id, project_id, kind, payload, evidence, strength, status, created_by, created_at) VALUES ('prop-2', 'p1', 'dataset', '{}', '{}', 'strong', 'proposed', 'worker:inspect', :t)"), {"t": T})

    command.upgrade(cfg, "head")
    try:
        with db.engine().begin() as c:
            tasks = {r.id: r for r in c.execute(sa.text("SELECT id, title, accepts, collection_id, trash_batch_id FROM tasks"))}
            assert tasks["t-img"].title == "Studio" and json.loads(tasks["t-img"].accepts) == ["image", "waveform"] and tasks["t-img"].collection_id is None
            assert tasks["t-img"].trash_batch_id is None and tasks["t-vid"].trash_batch_id is None and tasks["t-vid"].title == "Videos Studio"
            batch = tasks["t-wave"].trash_batch_id
            assert batch and tasks["t-ann"].trash_batch_id == batch
            assert c.execute(sa.text("SELECT trash_batch_id FROM datasets WHERE id = 'ds2'")).scalar() == batch
            assert c.execute(sa.text("SELECT kind, resource FROM fs_batches WHERE id = :b"), {"b": batch}).fetchone() == ("trash", "studio")
            assert c.execute(sa.text("SELECT default_task_id FROM projects WHERE id = 'p1'")).scalar() == "t-img"
            env = json.loads(c.execute(sa.text("SELECT environment FROM workspace_environments WHERE task_id = 't-img'")).scalar())
            assert env["extends"] == ["preset:image-2d", "preset:ecg"]
            assert c.execute(sa.text("SELECT status FROM proposals WHERE id = 'prop-2'")).scalar() == "dismissed"

        # Restorable through Trash.
        from studio_api.context import RequestContext
        from studio_api.kernel import trash
        from studio_api.models import ProjectRow

        with db.session_scope() as s:
            p = s.get(ProjectRow, "p1")
            ctx = RequestContext(workspace_id="p1", principal="user:a", correlation_id="t")
            trash.restore(s, ctx, p, batch)
        with db.engine().begin() as c:
            assert c.execute(sa.text("SELECT count(*) FROM tasks WHERE trash_batch_id IS NOT NULL")).scalar() == 0
    finally:
        db.reset_engine()
