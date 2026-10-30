"""EventBus (todo/todo3.md E.2): how published events reach `deliver`.

The outbox table (`plugin_events`, written by `events.publish` in the caller's transaction)
stays the source of truth either way; the bus decides how delivery finds new rows.

- `sql` (default): `deliver` scans the outbox for undelivered rows (SKIP LOCKED on Postgres).
- `redis`: after the publishing transaction commits, the event id is appended to the stream
  `<resourcePrefix>:events`. Replicas read it through one consumer group (each entry goes to
  one consumer), fan the event out, and XACK once that commit is durable. Entries a dead
  consumer left pending are reclaimed after `CLAIM_IDLE_MS`; outbox rows whose append was
  lost are picked up by a slow outbox scan, so delivery stays at-least-once.
"""

from __future__ import annotations

import logging
import os
import socket
from typing import Protocol

from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import aftercommit, redis_client
from ..config import settings
from ..models import PluginEvent
from . import events

log = logging.getLogger(__name__)


class EventBus(Protocol):
    kind: str

    def push(self, event_ids: list[str]) -> None: ...
    def deliver(self, db: Session, limit: int = 100) -> int: ...


class SqlEventBus:
    kind = "sql"

    def push(self, event_ids: list[str]) -> None:
        pass

    def deliver(self, db: Session, limit: int = 100) -> int:
        return events.deliver(db, limit)


class RedisEventBus:
    kind = "redis"
    GROUP = "kernel"
    CLAIM_IDLE_MS = 60_000
    OUTBOX_GRACE_S = 30
    MAXLEN = 100_000

    def __init__(self) -> None:
        self.consumer = f"{socket.gethostname()}-{os.getpid()}"

    @property
    def stream(self) -> str:
        return redis_client.key("events")

    def push(self, event_ids: list[str]) -> None:
        r = redis_client.client()
        pipe = r.pipeline(transaction=False)
        for eid in event_ids:
            pipe.xadd(self.stream, {"event_id": eid}, maxlen=self.MAXLEN, approximate=True)
        pipe.execute()

    def _ensure_group(self) -> None:
        import redis

        try:
            redis_client.client().xgroup_create(self.stream, self.GROUP, id="0", mkstream=True)
        except redis.ResponseError as e:
            if "BUSYGROUP" not in str(e):
                raise

    def _ack(self, entry_ids: list[str]) -> None:
        if entry_ids:
            redis_client.client().xack(self.stream, self.GROUP, *entry_ids)

    def deliver(self, db: Session, limit: int = 100) -> int:
        r = redis_client.client()
        self._ensure_group()
        entries: list[tuple[str, dict]] = []
        # Entries a crashed consumer read but never acked.
        claimed = r.xautoclaim(self.stream, self.GROUP, self.consumer, min_idle_time=self.CLAIM_IDLE_MS, start_id="0-0", count=limit)
        entries.extend(claimed[1] if len(claimed) > 1 else [])
        for _stream, items in r.xreadgroup(self.GROUP, self.consumer, {self.stream: ">"}, count=limit) or []:
            entries.extend(items)
        n, done = 0, []
        for entry_id, fields in entries:
            if not fields:  # trimmed away; nothing to deliver
                done.append(entry_id)
                continue
            q = select(PluginEvent).where(PluginEvent.event_id == fields.get("event_id"))
            if db.get_bind().dialect.name == "postgresql":
                q = q.with_for_update(skip_locked=True)
            ev = db.scalar(q)
            if ev is not None and not ev.delivered:
                events.fan_out(db, ev)
                n += 1
            done.append(entry_id)
        aftercommit.defer(db, self._ack, done)
        # Outbox rows the stream never saw (append lost after commit, Redis restarted).
        n += events.deliver(db, limit, older_than_s=self.OUTBOX_GRACE_S)
        return n


_sql = SqlEventBus()
_redis: RedisEventBus | None = None


def backend() -> EventBus:
    global _redis
    if settings().event_bus == "redis":
        if _redis is None:
            _redis = RedisEventBus()
        return _redis
    return _sql


def notify(db: Session, ev: PluginEvent) -> None:
    b = backend()
    if b.kind != "sql":
        aftercommit.defer(db, b.push, [ev.event_id])


def deliver(db: Session, limit: int = 100) -> int:
    return backend().deliver(db, limit)
