"""Side effects that must only happen once the DB transaction is durable (pushing a job id
to Redis, appending an event to a stream, acking a stream entry).

`defer(db, fn, *args)` queues `fn(*args)` on the session; it runs after a successful commit
and is dropped on rollback. A failure is logged, never raised: the DB is the source of
truth and the queue/bus reconcilers repair whatever a lost side effect missed.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

from sqlalchemy import event
from sqlalchemy.orm import Session

log = logging.getLogger(__name__)
_KEY = "after_commit_callbacks"


def defer(db: Session, fn: Callable, *args) -> None:
    db.info.setdefault(_KEY, []).append((fn, args))


@event.listens_for(Session, "after_commit")
def _run(session: Session) -> None:
    for fn, args in session.info.pop(_KEY, None) or []:
        try:
            fn(*args)
        except Exception:  # noqa: BLE001
            log.warning("after-commit side effect %s failed; the reconciler will repair it", getattr(fn, "__qualname__", fn), exc_info=True)


@event.listens_for(Session, "after_rollback")
def _drop(session: Session) -> None:
    session.info.pop(_KEY, None)
