"""Dev startup migrates the local SQLite database with Alembic (todo18 P0-6).

`create_all()` alone never adds a column to an existing table, so every new column broke a
tester's `.data/api.db` ("no such column"). Startup now runs `alembic upgrade head`. A database
an older `create_all()` built (tables, no `alembic_version` row) is stamped with the newest
revision whose tables and columns all exist, then upgraded; if that fails the file is moved
aside to `<name>.<UTC timestamp>.bak` (logged with its path) and a fresh one is migrated.
In-memory and non-SQLite databases keep `create_all()` (tests; production runs the migrate Job).
"""

from __future__ import annotations

import logging
import tempfile
from datetime import UTC, datetime
from pathlib import Path

import sqlalchemy as sa
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory

from . import db

log = logging.getLogger(__name__)

API_DIR = Path(__file__).resolve().parents[2]

Schema = set[tuple[str, str]]


def _config(conn: sa.Connection | None = None) -> Config:
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(API_DIR / "migrations"))
    if conn is not None:
        cfg.attributes["connection"] = conn
    return cfg


def _schema(conn: sa.Connection) -> Schema:
    insp = sa.inspect(conn)
    return {(t, c["name"]) for t in insp.get_table_names() if t != "alembic_version" for c in insp.get_columns(t)}


def _version(conn: sa.Connection) -> str | None:
    if not sa.inspect(conn).has_table("alembic_version"):
        return None
    return conn.execute(sa.text("SELECT version_num FROM alembic_version")).scalar()


def _sqlite_file(url: str) -> Path | None:
    url = db.normalize_url(url)
    if not url.startswith("sqlite:///") or ":memory:" in url:
        return None
    return Path(url[len("sqlite:///"):])


def revision_schemas() -> list[tuple[str, Schema]]:
    """(revision, tables+columns after it) for every revision, base to head, built in a temp file."""
    revs = [r.revision for r in reversed(list(ScriptDirectory.from_config(_config()).walk_revisions()))]
    out: list[tuple[str, Schema]] = []
    with tempfile.TemporaryDirectory() as tmp:
        eng = sa.create_engine(f"sqlite:///{tmp}/ref.db")
        try:
            for rev in revs:
                with eng.begin() as conn:
                    command.upgrade(_config(conn), rev)
                with eng.connect() as conn:
                    out.append((rev, _schema(conn)))
        finally:
            eng.dispose()
    return out


def detect_revision(have: Schema) -> str | None:
    """The newest revision whose tables and columns all exist in `have`."""
    best = None
    for rev, want in revision_schemas():
        if want <= have:
            best = rev
    return best


def _upgrade_head() -> None:
    with db.engine().begin() as conn:
        command.upgrade(_config(conn), "head")


def _stamp_and_upgrade() -> None:
    with db.engine().connect() as conn:
        have = _schema(conn)
        version = _version(conn)
    if have and version is None:
        rev = detect_revision(have)
        if rev is None:
            raise RuntimeError("no migration matches the existing tables")
        log.warning("database built by create_all (no alembic_version); stamping %s from its tables", rev)
        with db.engine().begin() as conn:
            command.stamp(_config(conn), rev)
    _upgrade_head()


def migrate_dev() -> None:
    """Bring the dev database to Alembic head (see module doc)."""
    path = _sqlite_file(db.settings().database_url)
    if path is None:
        db.create_all()
        return
    try:
        _stamp_and_upgrade()
        return
    except Exception:  # noqa: BLE001
        log.exception("dev database %s could not be migrated", path)
    db.reset_engine()
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    aside = path.with_name(f"{path.name}.{stamp}.bak")
    for suffix in ("", "-wal", "-shm"):
        src = Path(str(path) + suffix)
        if src.exists():
            src.rename(Path(str(aside) + suffix))
    log.warning("moved the old dev database aside to %s; starting a fresh one at %s", aside, path)
    _upgrade_head()
