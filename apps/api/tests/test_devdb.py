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
    from studio_api.devdb import migrate_dev

    path = tmp_path / "api.db"
    _settings(tmp_path, f"sqlite:///{path}")
    db.create_all()
    with db.engine().begin() as c:  # an older create_all (before 0020), no alembic_version
        c.execute(sa.text("DROP TABLE blob_delete_retries"))  # 0025
        c.execute(sa.text("DROP TABLE IF EXISTS derivatives"))  # 0023
        c.execute(sa.text("ALTER TABLE fs_batches DROP COLUMN state"))  # 0022
        c.execute(sa.text("DROP TABLE approvals_used"))
        c.execute(sa.text("DROP INDEX IF EXISTS ix_fs_batches_turn"))
        c.execute(sa.text("ALTER TABLE fs_batches DROP COLUMN turn_id"))
        c.execute(sa.text("ALTER TABLE fs_batches DROP COLUMN on_behalf_of"))
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
