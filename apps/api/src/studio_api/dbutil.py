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


def upsert_newer(db: Session, model: Any, row: dict, keys: list[str], *, stamp: str = "workos_updated_at") -> None:
    """INSERT … ON CONFLICT (keys) DO UPDATE … WHERE the stored `stamp` is older or null
    (todo9 Phase 2): WorkOS events and callback upserts arrive out of order, and a stale
    one never overwrites a newer mirror row. Columns not in `row` are left alone."""
    db.flush()
    if db.get_bind().dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    else:
        from sqlalchemy.dialects.sqlite import insert
    table = model.__table__
    stmt = insert(table).values(**row)
    update = {c: stmt.excluded[c] for c in row if c not in keys}
    if not update:
        db.execute(stmt.on_conflict_do_nothing(index_elements=keys))
        return
    where = None
    if stamp in row and row[stamp] is not None:
        where = table.c[stamp].is_(None) | (stmt.excluded[stamp] > table.c[stamp])
    db.execute(stmt.on_conflict_do_update(index_elements=keys, set_=update, where=where))
