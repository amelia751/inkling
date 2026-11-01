"""Alembic history stays linear (the api-migrate Job runs `alembic upgrade head`).

Two branches that each add a revision with the same down_revision merge without a git
conflict and only fail at deploy time ("Multiple head revisions"); this catches it in CI.
"""

from __future__ import annotations

from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory

API = Path(__file__).resolve().parents[1]


def test_one_head_and_unique_revisions():
    script = ScriptDirectory.from_config(Config(str(API / "alembic.ini")))
    assert len(script.get_heads()) == 1, f"multiple Alembic heads: {script.get_heads()}; renumber the newer revision"
    revisions = list(script.walk_revisions())
    assert len({r.revision for r in revisions}) == len(revisions)


def _alembic_at(tmp_path, revision: str):
    """A file SQLite database migrated to `revision` (alembic reads the kernel settings)."""
    from alembic import command

    from studio_api import config, db

    s = config.load_settings(database_url=f"sqlite:///{tmp_path}/migrate.db", seed_root=tmp_path / "no-seeds", data_dir=tmp_path / "data", secret_key="test-secret-key", create_tables=False)
    config.set_settings(s)
    db.reset_engine()
    cfg = Config(str(API / "alembic.ini"))
    cfg.set_main_option("script_location", str(API / "migrations"))
    command.upgrade(cfg, revision)
    return cfg


def test_0005_builds_one_drive_per_project_and_freezes_datasets(tmp_path):
    """todo7 D1, D2, D4, D7, D10 on a 0004-shaped database."""
    import sqlalchemy as sa
    from alembic import command

    from studio_api import db

    cfg = _alembic_at(tmp_path, "0004")
    t = "2026-10-30 10:00:00"
    with db.engine().begin() as c:
        c.execute(sa.text("INSERT INTO organizations (id, name, kind, created_at) VALUES ('o', 'O', 'team', :t)"), {"t": t})
        for pid, seed in (("p1", False), ("seed1", True)):
            c.execute(sa.text("INSERT INTO projects (id, org_id, title, description, visibility, seed, archived, created_by, created_at, updated_at) VALUES (:p, 'o', :p, '', 'private', :s, 0, 'user:a', :t, :t)"), {"p": pid, "s": seed, "t": t})
        sources = [("s1", "p1", "study", "upload"), ("s2", "p1", "study", "upload"), ("seed1", "seed1", "samples", "seed")]
        for sid, pid, title, kind in sources:
            c.execute(sa.text("INSERT INTO sources (id, project_id, title, kind, root_node_id, created_by, status, created_at) VALUES (:s, :p, :title, :k, :r, 'user:a', 'ready', :t)"), {"s": sid, "p": pid, "title": title, "k": kind, "r": f"r-{sid}", "t": t})
        rows = [
            ("r-s1", "s1", "p1", None, "study", "", True, None, None),
            ("f-mri", "s1", "p1", "r-s1", "MRI", "MRI", True, None, None),
            ("f-a", "s1", "p1", "f-mri", "Scan.png", "MRI/Scan.png", False, "a1", 10),
            ("f-b", "s1", "p1", "f-mri", "scan.png", "MRI/scan.png", False, "a2", 20),
            ("r-s2", "s2", "p1", None, "study", "", True, None, None),
            ("f-c", "s2", "p1", "r-s2", "c.csv", "c.csv", False, "a3", 5),
            ("r-seed1", "seed1", "seed1", None, "samples", "", True, None, None),
            ("f-s", "seed1", "seed1", "r-seed1", "x.png", "x.png", False, "a4", 7),
        ]
        for nid, sid, pid, parent, name, rel, is_dir, asset, size in rows:
            c.execute(sa.text("INSERT INTO source_nodes (id, source_id, project_id, parent_id, name, rel_path, is_dir, asset_id, size, facts, flags, child_count, descendant_count, created_at) VALUES (:id, :s, :p, :parent, :n, :rel, :d, :a, :size, '{}', '{}', 0, 0, :t)"), {"id": nid, "s": sid, "p": pid, "parent": parent, "n": name, "rel": rel, "d": is_dir, "a": asset, "size": size, "t": t})
        c.execute(sa.text("INSERT INTO datasets (id, project_id, title, description, definition, created_by, created_at) VALUES ('d1', 'p1', 'D', '', :def, 'user:a', :t)"), {"def": '{"nodeIds": ["f-mri"]}', "t": t})
    command.upgrade(cfg, "head")
    with db.engine().begin() as c:
        nodes = {r.id: r for r in c.execute(sa.text("SELECT * FROM source_nodes"))}
        root = next(n for n in nodes.values() if n.project_id == "p1" and n.parent_id is None)
        assert root.name == "Files" and root.source_id is None
        # Both imports are top-level folders now, with unique names.
        assert {nodes["r-s1"].name, nodes["r-s2"].name} == {"study", "study (2)"}
        assert nodes["r-s1"].parent_id == nodes["r-s2"].parent_id == root.id
        assert nodes["f-a"].original_path == "MRI/Scan.png"
        assert (root.child_count, root.descendant_count, root.total_bytes) == (2, 3, 35)
        assert (nodes["f-mri"].descendant_count, nodes["f-mri"].total_bytes) == (2, 30)
        # Case-only duplicates are kept and numbered; the unique index holds.
        assert sorted((nodes["f-a"].name_dup, nodes["f-b"].name_dup)) == [0, 1]
        assert nodes["f-s"].locked and nodes["r-seed1"].locked and not nodes["f-a"].locked
        assert c.execute(sa.text("SELECT count(*) FROM node_versions")).scalar() == 4
        import json

        definition = json.loads(c.execute(sa.text("SELECT definition FROM datasets WHERE id = 'd1'")).scalar())
        assert definition["followedFolders"] == ["f-mri"]
        assert sorted(f["nodeId"] for f in definition["files"]) == ["f-a", "f-b"]
        assert {"nodeId": "f-a", "assetId": "a1", "version": 1} in definition["files"]
        try:
            c.execute(sa.text("INSERT INTO source_nodes (id, project_id, parent_id, name, name_dup, original_path, is_dir, facts, flags, child_count, descendant_count, total_bytes, revision, locked, version, created_at) VALUES ('dup', 'p1', 'f-mri', 'SCAN.png', 0, '', 0, '{}', '{}', 0, 0, 0, 0, 0, 1, :t)"), {"t": t})
            raise AssertionError("the unique sibling-name index is missing")
        except sa.exc.IntegrityError:
            pass
    command.downgrade(cfg, "0004")
    with db.engine().begin() as c:
        assert c.execute(sa.text("SELECT parent_id FROM source_nodes WHERE id = 'r-s1'")).scalar() is None
        assert c.execute(sa.text("SELECT rel_path FROM source_nodes WHERE id = 'f-a'")).scalar() == "MRI/Scan.png"
    db.reset_engine()


def test_0006_backfills_revision_hashes_and_parents(tmp_path):
    """todo10 Phase 1: every existing revision gets its RFC 8785 hash and a parent."""
    import json

    import sqlalchemy as sa
    from alembic import command

    from studio_api import db
    from studio_api.kernel.canonical import NULL_CONTENT_HASH, content_hash

    cfg = _alembic_at(tmp_path, "0005")
    t = "2026-10-30 10:00:00"
    envs = [{"task": "a", "x": 1.0}, {"x": 1, "task": "b"}, {"task": "a", "x": 1}]
    with db.engine().begin() as c:
        c.execute(sa.text("INSERT INTO workspaces (id, name, created_at) VALUES ('w', 'w', :t)"), {"t": t})
        for i, (task, env, author) in enumerate([("t1", envs[0], "ann"), ("t1", envs[1], "agent:m"), ("t1", envs[2], "ann"), ("t2", envs[1], None)]):
            rev = i + 1 if task == "t1" else 1
            c.execute(sa.text("INSERT INTO workspace_environment_history (workspace_id, task_id, revision, environment, author, saved_at) VALUES ('w', :task, :rev, :env, :a, :t)"), {"task": task, "rev": rev, "env": json.dumps(env), "a": author, "t": t})
    command.upgrade(cfg, "0006")
    with db.engine().begin() as c:
        rows = c.execute(sa.text("SELECT task_id, revision, content_hash, parent_hash, author_kind FROM workspace_environment_history ORDER BY task_id, revision")).all()
    h = [content_hash(e) for e in envs]
    assert h[0] == h[2]  # 1.0 and 1 are the same JSON number
    assert [(r.task_id, r.revision, r.content_hash, r.parent_hash, r.author_kind) for r in rows] == [
        ("t1", 1, h[0], NULL_CONTENT_HASH, "person"),
        ("t1", 2, h[1], h[0], "agent"),
        ("t1", 3, h[2], h[1], "person"),
        ("t2", 1, h[1], NULL_CONTENT_HASH, "person"),
    ]
    command.downgrade(cfg, "0005")


def test_0010_adds_classes_limits_leases_and_the_feed_order_and_downgrades(tmp_path):
    """todo12-kernel: existing jobs become `cpu`, existing events get a feed position; the
    downgrade drops it all again."""
    import sqlalchemy as sa
    from alembic import command

    from studio_api import db

    cfg = _alembic_at(tmp_path, "0009")
    t = "2026-11-01 10:00:00"
    with db.engine().begin() as c:
        c.execute(sa.text("INSERT INTO workspaces (id, name, created_at) VALUES ('w', 'w', :t)"), {"t": t})
        c.execute(sa.text("INSERT INTO plugin_jobs (job_id, workspace_id, plugin_id, version, tool, input, state, progress, recoverable, estimated_cost_usd, cost_usd, correlation_id, principal, attempts, max_attempts, timeout_s, created_at, updated_at) VALUES ('j', 'w', 'p', '1', 't', '{}', 'queued', 0, 1, 0, 0, 'c', 'user:a', 0, 3, 60, :t, :t)"), {"t": t})
        c.execute(sa.text("INSERT INTO plugin_events (event_id, workspace_id, type, payload, source, correlation_id, depth, delivered, attempts, created_at) VALUES ('e', 'w', 'job.succeeded', '{}', 's', 'c', 0, 0, 0, :t)"), {"t": t})
    command.upgrade(cfg, "0010")
    with db.engine().begin() as c:
        assert c.execute(sa.text("SELECT resource_class, error_class FROM plugin_jobs")).one() == ("cpu", None)
        c.execute(sa.text("INSERT INTO workspace_resource_limits (workspace_id, resource_class, max_running, updated_at) VALUES ('*', 'gpu', 2, :t)"), {"t": t})
        c.execute(sa.text("INSERT INTO resource_leases (job_id, workspace_id, resource_class, worker_id, attempt, acquired_at, expires_at) VALUES ('j', 'w', 'gpu', 'g', 1, :t, :t)"), {"t": t})
        names = set(sa.inspect(c).get_table_names())
        assert {"workspace_resource_limits", "resource_leases"} <= names
        assert "feed_seq" in {col["name"] for col in sa.inspect(c).get_columns("plugin_events")}
    command.downgrade(cfg, "0009")
    with db.engine().begin() as c:
        names = set(sa.inspect(c).get_table_names())
        assert not {"workspace_resource_limits", "resource_leases"} & names
        assert "resource_class" not in {col["name"] for col in sa.inspect(c).get_columns("plugin_jobs")}
        assert "feed_seq" not in {col["name"] for col in sa.inspect(c).get_columns("plugin_events")}
        assert c.execute(sa.text("SELECT count(*) FROM plugin_jobs")).scalar() == 1
    command.upgrade(cfg, "head")
    db.reset_engine()
