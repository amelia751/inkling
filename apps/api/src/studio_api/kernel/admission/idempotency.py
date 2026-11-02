"""Idempotency keys (todo17 D13). Same key + same body -> replay the stored response; same key with a
different body -> 422; a duplicate while the first is still running -> 409. Keys are scoped by
principal and kept for `API_IDEMPOTENCY_TTL_HOURS` (default 24).
"""

from __future__ import annotations

import hashlib
import json
import threading
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

TTL = timedelta(hours=24)


def body_hash(body: Any) -> str:
    raw = body if isinstance(body, bytes) else json.dumps(body, sort_keys=True, separators=(",", ":"), default=str).encode()
    return hashlib.sha256(raw).hexdigest()


class IdempotencyError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


@dataclass
class Replay:
    status: int
    response: Any


class IdempotencyStore(Protocol):
    def begin(self, key: str, principal: str, op_id: str, digest: str) -> Replay | None:
        """None: the caller owns the key and must `complete` or `abort`. Replay: answer with it."""

    def complete(self, key: str, principal: str, status: int, response: Any) -> None: ...

    def abort(self, key: str, principal: str) -> None: ...


def _check(row_op: str, row_hash: str, row_status: str, op_id: str, digest: str) -> None:
    if row_op != op_id or row_hash != digest:
        raise IdempotencyError(422, "idempotency_key_reused", "This Idempotency-Key was used with a different request.")
    if row_status == "in_progress":
        raise IdempotencyError(409, "idempotency_in_progress", "A request with this Idempotency-Key is still running.")


class MemoryIdempotencyStore:
    def __init__(self, ttl: timedelta = TTL):
        self.ttl = ttl
        self._rows: dict[tuple[str, str], dict[str, Any]] = {}
        self._lock = threading.Lock()

    def begin(self, key: str, principal: str, op_id: str, digest: str) -> Replay | None:
        now = datetime.now(UTC)
        with self._lock:
            row = self._rows.get((key, principal))
            if row and now - row["created_at"] > self.ttl:
                row = None
            if row is None:
                self._rows[(key, principal)] = {"op": op_id, "hash": digest, "status": "in_progress", "code": None, "response": None, "created_at": now}
                return None
            _check(row["op"], row["hash"], row["status"], op_id, digest)
            return Replay(row["code"], row["response"])

    def complete(self, key: str, principal: str, status: int, response: Any) -> None:
        with self._lock:
            row = self._rows[(key, principal)]
            row.update(status="done", code=status, response=response)

    def abort(self, key: str, principal: str) -> None:
        with self._lock:
            self._rows.pop((key, principal), None)


class SqlIdempotencyStore:
    """Against the `idempotency_keys` table (key, principal, op_id, body_hash, status, response,
    created_at), added by the todo17 migration. The HTTP status is stored inside `response`
    as `{"status": int, "body": ...}`. Uses plain SQL so it does not depend on the ORM model."""

    def __init__(self, engine: Any, ttl: timedelta = TTL):
        self.engine, self.ttl = engine, ttl

    def begin(self, key: str, principal: str, op_id: str, digest: str) -> Replay | None:
        from sqlalchemy import text
        from sqlalchemy.exc import IntegrityError

        now = datetime.now(UTC)
        with self.engine.begin() as c:
            c.execute(text("DELETE FROM idempotency_keys WHERE key = :k AND principal = :p AND created_at < :t"), {"k": key, "p": principal, "t": now - self.ttl})
        try:
            with self.engine.begin() as c:
                c.execute(
                    text("INSERT INTO idempotency_keys (key, principal, op_id, body_hash, status, response, created_at) VALUES (:k, :p, :o, :h, 'in_progress', NULL, :t)"),
                    {"k": key, "p": principal, "o": op_id, "h": digest, "t": now},
                )
            return None
        except IntegrityError:
            pass
        with self.engine.connect() as c:
            row = c.execute(text("SELECT op_id, body_hash, status, response FROM idempotency_keys WHERE key = :k AND principal = :p"), {"k": key, "p": principal}).one()
        _check(row[0], row[1], row[2], op_id, digest)
        stored = row[3] if not isinstance(row[3], str) else json.loads(row[3])
        return Replay(stored["status"], stored["body"])

    def complete(self, key: str, principal: str, status: int, response: Any) -> None:
        from sqlalchemy import text

        with self.engine.begin() as c:
            c.execute(
                text("UPDATE idempotency_keys SET status = 'done', response = :r WHERE key = :k AND principal = :p"),
                {"r": json.dumps({"status": status, "body": response}, default=str), "k": key, "p": principal},
            )

    def abort(self, key: str, principal: str) -> None:
        from sqlalchemy import text

        with self.engine.begin() as c:
            c.execute(text("DELETE FROM idempotency_keys WHERE key = :k AND principal = :p AND status = 'in_progress'"), {"k": key, "p": principal})


def run_idempotent(store: IdempotencyStore | None, key: str | None, principal: str, op_id: str, body: Any, fn: Any) -> tuple[int, Any]:
    """Run `fn() -> (status, body)` at most once per key. Without a key or store, just runs it."""
    if not key or store is None:
        return fn()
    digest = body_hash(body)
    replay = store.begin(key, principal, op_id, digest)
    if replay is not None:
        return replay.status, replay.response
    try:
        status, out = fn()
    except Exception:
        store.abort(key, principal)
        raise
    store.complete(key, principal, status, out)
    return status, out
