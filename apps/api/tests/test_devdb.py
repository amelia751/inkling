"""todo18 P0-6: dev startup brings a create_all database (no alembic_version) to head."""

from __future__ import annotations

import sqlalchemy as sa

from studio_api import config, db


def _settings(tmp_path, url):
    s = config.load_settings(database_url=url, seed_root=tmp_path / "no-seeds", data_dir=tmp_path / "data", secret_key="test-secret-key", create_tables=True)
    config.set_settings(s)
    db.reset_engine()
    return s


def _head():
    from alembic.script import ScriptDirectory

    from studio_api.devdb import _config

    return ScriptDirectory.from_config(_config()).get_current_head()


def test_create_all_db_missing_a_recent_column_is_stamped_and_upgraded(tmp_path):
    from alembic import command

    from studio_api.devdb import _config, migrate_dev

    path = tmp_path / "api.db"
    _settings(tmp_path, f"sqlite:///{path}")
    # What create_all made before 0020: the schema at revision 0019, without a version row.
    with db.engine().begin() as c:
        command.upgrade(_config(c), "0019")
        c.execute(sa.text("DROP TABLE alembic_version"))
    assert not sa.inspect(db.engine()).has_table("alembic_version")
    migrate_dev()
    with db.engine().connect() as c:
        assert c.execute(sa.text("SELECT version_num FROM alembic_version")).scalar() == _head()
        assert sa.inspect(c).has_table("approvals_used")
        assert "turn_id" in {col["name"] for col in sa.inspect(c).get_columns("fs_batches")}
    assert not list(tmp_path.glob("api.db.*.bak"))


def test_unmatchable_db_is_moved_aside(tmp_path, caplog):
    from studio_api.devdb import migrate_dev

    path = tmp_path / "api.db"
    _settings(tmp_path, f"sqlite:///{path}")
    with db.engine().begin() as c:
        c.execute(sa.text("CREATE TABLE projects (id TEXT PRIMARY KEY)"))  # matches no revision
    migrate_dev()
    assert len(list(tmp_path.glob("api.db.*.bak"))) == 1
    assert "moved the old dev database aside" in caplog.text
    with db.engine().connect() as c:
        assert c.execute(sa.text("SELECT version_num FROM alembic_version")).scalar() == _head()


def test_fresh_and_migrated_dbs_reach_head(tmp_path):
    from studio_api.devdb import migrate_dev

    _settings(tmp_path, f"sqlite:///{tmp_path}/api.db")
    migrate_dev()
    migrate_dev()  # idempotent
    with db.engine().connect() as c:
        assert c.execute(sa.text("SELECT version_num FROM alembic_version")).scalar() == _head()


def test_a_create_all_db_partly_ahead_of_its_stamp_keeps_its_data(tmp_path):
    """A dev DB at 0021 that create_all already gave a later table (change_requests) is upgraded
    in place, not moved aside (todo18 P0-6, seen on a real dev database)."""
    from alembic import command

    from studio_api.devdb import _config, migrate_dev

    path = tmp_path / "api.db"
    _settings(tmp_path, f"sqlite:///{path}")
    with db.engine().begin() as c:
        command.upgrade(_config(c), "0022")
        c.execute(sa.text("DROP TABLE change_request_comments"))  # only part of 0022 is there
        c.execute(sa.text("DROP TABLE alembic_version"))
        c.execute(sa.text("INSERT INTO organizations (id, name, kind, created_at) VALUES ('o', 'O', 'team', '2026-11-02')"))
    migrate_dev()
    with db.engine().connect() as c:
        assert c.execute(sa.text("SELECT version_num FROM alembic_version")).scalar() == _head()
        assert c.execute(sa.text("SELECT count(*) FROM organizations")).scalar() == 1
        assert sa.inspect(c).has_table("change_request_comments")
    assert not list(tmp_path.glob("api.db.*.bak"))
