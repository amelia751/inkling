"""SQLAlchemy engine and sessions. SQLite in dev; the same models run on Postgres."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import settings


class Base(DeclarativeBase):
    pass


_engine: Engine | None = None
_Session: sessionmaker[Session] | None = None


def engine() -> Engine:
    global _engine, _Session
    if _engine is None:
        url = settings().database_url
        if url.startswith("sqlite:///") and not url.startswith("sqlite:///:memory:"):
            settings().data_dir.mkdir(parents=True, exist_ok=True)
        kw: dict = {"connect_args": {"check_same_thread": False}} if url.startswith("sqlite") else {}
        if url == "sqlite:///:memory:":
            from sqlalchemy.pool import StaticPool

            kw["poolclass"] = StaticPool
        _engine = create_engine(url, **kw)
        if url.startswith("sqlite"):

            @event.listens_for(_engine, "connect")
            def _pragmas(conn, _):  # noqa: ANN001
                cur = conn.cursor()
                cur.execute("PRAGMA foreign_keys=ON")
                cur.execute("PRAGMA journal_mode=WAL") if ":memory:" not in url else None
                cur.close()

        _Session = sessionmaker(_engine, expire_on_commit=False)
    return _engine


def reset_engine() -> None:
    global _engine, _Session
    if _engine is not None:
        _engine.dispose()
    _engine, _Session = None, None


@contextmanager
def session_scope() -> Iterator[Session]:
    engine()
    assert _Session is not None
    s = _Session()
    try:
        yield s
        s.commit()
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


def get_session() -> Iterator[Session]:
    """FastAPI dependency: one transaction per request."""
    with session_scope() as s:
        yield s


def create_all() -> None:
    """Create every table (tests and first dev run; production uses Alembic)."""
    from . import models  # noqa: F401

    Base.metadata.create_all(engine())
