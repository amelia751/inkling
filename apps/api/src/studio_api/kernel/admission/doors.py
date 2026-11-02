"""Glue the write doors share (todo17 D1, D6, D13): an idempotency store bound to the request's
session (the key commits or rolls back with the write it guards), findings recorded on success,
and a rejection that keeps a route's legacy error fields next to the problem JSON.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...models import IdempotencyKey
from . import Admitted, WriteRejected
from .idempotency import TTL, IdempotencyError, Replay, _check, body_hash, run_idempotent


class SessionIdempotencyStore:
    """`idempotency_keys` through the request's session: the stored response commits with the
    write itself, and a rejected or failed write rolls its key back."""

    def __init__(self, db: Session, ttl=TTL):
        self.db, self.ttl = db, ttl

    def _row(self, key: str, principal: str) -> IdempotencyKey | None:
        return self.db.get(IdempotencyKey, (key, principal))

    def begin(self, key: str, principal: str, op_id: str, digest: str) -> Replay | None:
        now = datetime.now(UTC)
        row = self._row(key, principal)
        if row is not None:
            created = row.created_at if row.created_at.tzinfo else row.created_at.replace(tzinfo=UTC)
            if now - created > self.ttl:
                self.db.delete(row)
                self.db.flush()
                row = None
        if row is None:
            # No savepoint (pysqlite would commit it early): a concurrent duplicate collides on the
            # primary key at flush, which is the "still running" case; the request then rolls back.
            self.db.add(IdempotencyKey(key=key, principal=principal, op_id=op_id, body_hash=digest, status="in_progress", response=None, created_at=now))
            try:
                self.db.flush()
            except IntegrityError:
                raise IdempotencyError(409, "idempotency_in_progress", "A request with this Idempotency-Key is still running.") from None
            return None
        _check(row.op_id, row.body_hash, row.status, op_id, digest)
        stored = row.response if not isinstance(row.response, str) else json.loads(row.response)
        return Replay(stored["status"], stored["body"])

    def complete(self, key: str, principal: str, status: int, response: Any) -> None:
        row = self._row(key, principal)
        if row is not None:
            row.status, row.response = "done", json.loads(json.dumps({"status": status, "body": response}, default=str))
            self.db.flush()

    def abort(self, key: str, principal: str) -> None:
        row = self._row(key, principal)
        if row is not None and row.status == "in_progress":
            self.db.delete(row)
            self.db.flush()


def idempotent(db: Session, key: str | None, principal: str, op_id: str, body: Any, fn: Any) -> tuple[int, Any]:
    """`run_idempotent` against the request's session. `fn() -> (status, body)`."""
    return run_idempotent(SessionIdempotencyStore(db) if key else None, key, principal, op_id, body, fn)


class IdempotentWrite:
    """`with IdempotentWrite(db, key, principal, op_id, body) as w:` — `w.replay` is the stored
    answer of an earlier identical request (answer with it); else run the write and call
    `w.complete(status, body)` on success. Anything else (an error response, an exception) frees
    the key, so only successes replay. Without a key it does nothing."""

    def __init__(self, db: Session, key: str | None, principal: str, op_id: str, body: Any):
        self.store = SessionIdempotencyStore(db) if key else None
        self.key, self.principal, self.op_id, self.body = key, principal, op_id, body
        self.replay: Replay | None = None
        self._done = False

    def __enter__(self) -> IdempotentWrite:
        if self.store is not None and self.key:
            self.replay = self.store.begin(self.key, self.principal, self.op_id, body_hash(self.body))
            self._done = self.replay is not None
        return self

    def complete(self, status: int, response: Any) -> None:
        if self.store is not None and self.key and not self._done:
            self.store.complete(self.key, self.principal, status, response)
            self._done = True

    def __exit__(self, *_exc: Any) -> None:
        if self.store is not None and self.key and not self._done:
            self.store.abort(self.key, self.principal)


def reject(violations: list, *, title: str = "The write breaks the project's rules", **legacy: Any) -> WriteRejected:
    exc = WriteRejected(violations, title=title)
    exc.body_extra = {"ok": False, **legacy}
    return exc


def legacy_errors(violations: list) -> list[dict[str, Any]]:
    """The pre-todo17 `errors[]` shape (`{path, code, message}`) clients still read."""
    return [{"path": v.path, "code": v.extra.get("code", v.rule), "message": v.message} for v in violations]


def record_findings(db: Session, project_id: str | None, resource_kind: str, resource_id: str, admitted: Admitted) -> None:
    """Store a successful write's findings in `lint_findings` (W-HEALTH's `kernel.findings.record`),
    when that module exists; a no-op before it lands or outside a project."""
    if not project_id or admitted.dry_run or not admitted.findings:
        return
    try:
        from .. import findings as findings_mod  # type: ignore[attr-defined]
    except ImportError:
        return
    record = getattr(findings_mod, "record", None)
    if record is None:
        return
    record(db, project_id, resource_kind, resource_id, [{**f.to_json(), "evaluate": f.evaluate} for f in admitted.findings], "write")
