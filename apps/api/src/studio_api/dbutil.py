"""Small dialect helpers shared by the kernel (SQLite in dev, Postgres in production)."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session


def insert_ignore(db: Session, model: Any, rows: list[dict]) -> None:
    """INSERT … ON CONFLICT DO NOTHING: the idempotent half of get-or-create. Concurrent
    first requests (two replicas, two tabs) both succeed; callers select afterwards."""
    if not rows:
        return
    db.flush()
    if db.get_bind().dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    else:
        from sqlalchemy.dialects.sqlite import insert
    # A multi-row VALUES takes its columns from the first row: insert rows with the same keys together.
    groups: dict[tuple[str, ...], list[dict]] = {}
    for r in rows:
        groups.setdefault(tuple(sorted(r)), []).append(r)
    for group in groups.values():
        # executemany (one compiled statement, "insertmanyvalues" batches): a multi-row VALUES
        # compiled per call costs seconds of Python for thousands of rows.
        db.execute(insert(model.__table__).on_conflict_do_nothing(), group)
