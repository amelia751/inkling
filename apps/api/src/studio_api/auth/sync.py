"""The WorkOS event sync (todo9 Phase 7, D6): WorkOS → the local mirror, through the Events API.

One api replica at a time (a Postgres session advisory lock; SQLite, a single dev process, takes
none) polls `events.list_events(events=EVENT_TYPES, after=<cursor>, order="asc", limit=100)`
every `API_WORKOS_SYNC_INTERVAL_S` (5 s) in workos mode. Per event, in one transaction: skip it
if `workos_events_processed` has its id, else apply it; record the id; advance
`workos_event_cursor`. Side effects (revoking kernel session tokens, the switcher cache) run
after the commit. Replaying events changes nothing: the processed table skips them, and
`dbutil.upsert_newer` never lets an older `workos_updated_at` overwrite a newer row.

It runs in api rather than the worker: the worker runs plugin code on real data and has no
internet egress, and import rules keep it out of `studio_api` (it would duplicate the mirror
upserts and `revoke_sessions_for`).

Handlers (data only):

    user.created|updated     upsert `users` (a tombstoned user stays deleted)
    user.deleted             tombstone: names, email and avatar cleared, `deleted_at` set; the
                             principal stays on annotations, revisions and commits; memberships
                             inactive, agent tokens revoked
    organization.*           the org's name (a stub org for an unseen id); deleted → memberships
                             inactive, tokens revoked
    organization_membership.created|updated|deleted
                             upsert or delete `organization_members` (role slugs mapped); not
                             active or deleted → the user's agent tokens in that org revoked
    invitation.*             mirror `org_invitations`; accepted → pending project grants become
                             `project_members`; revoked → its grants dropped
    session.*, organization_domain.*, api_key.*, connection.*, authentication.*
                             one `audit_events` row each (id = the event id)

Unknown users and organizations referenced by an event become stubs, filled in by their own
events (out-of-order safety). `reconcile()` runs about once a day (and from the CLI) to catch
drift the events missed:

    uv run python -m studio_api.auth.sync reconcile     # list_users, memberships per org
    uv run python -m studio_api.auth.sync once          # one poll, then exit

Metrics are log lines (Cloud Logging log-based metrics, infra/terraform/phi/monitoring.tf):
`workos_sync.batch {events, failures, lag_ms, events_per_s}`, `workos_sync.failed {eventId,
eventType, errorClass}`, `workos_sync.lagging {lag_ms}` (once a minute while the sync is more
than 5 minutes behind) and `workos_sync.reconciled {counts}`. Ids only, never emails or names.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Iterable
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from sqlalchemy import delete, select, text, update
from sqlalchemy.orm import Session

from ..config import settings
from ..db import engine, session_scope
from ..dbutil import insert_ignore, upsert_newer
from ..models import (
    AuditEvent,
    Organization,
    OrganizationMember,
    OrgInvitation,
    PendingProjectGrant,
    ProjectMember,
    User,
    WorkosEventCursor,
    WorkosEventProcessed,
    now,
)
from . import client as wclient
from .bootstrap import _dt, forget_memberships, org_for_workos_id, principal_of

log = logging.getLogger(__name__)

CONSUMER = "workos"
RECONCILE_CONSUMER = "workos_reconcile"
PAGE = 100
MAX_PAGES_PER_TICK = 20
MAX_ATTEMPTS = 5  # an event that fails this often is skipped (logged), so it can't block the stream
RECONCILE_EVERY = timedelta(hours=24)
LAG_ALERT = timedelta(minutes=5)
FIRST_RANGE = timedelta(days=29)  # the Events API answers at most 30 days per query
LOCK_KEY = "workos_sync"

ORG_ROLES = ("admin", "member", "billing")

USER_EVENTS = ("user.created", "user.updated", "user.deleted")
ORG_EVENTS = ("organization.created", "organization.updated", "organization.deleted")
MEMBERSHIP_EVENTS = ("organization_membership.created", "organization_membership.updated", "organization_membership.deleted")
INVITATION_EVENTS = ("invitation.created", "invitation.resent", "invitation.accepted", "invitation.revoked")
AUDIT_EVENTS = (
    "session.created",
    "session.revoked",
    "organization_domain.created",
    "organization_domain.updated",
    "organization_domain.deleted",
    "organization_domain.verified",
    "organization_domain.verification_failed",
    "api_key.created",
    "api_key.revoked",
    "connection.activated",
    "connection.deactivated",
    "connection.deleted",
    "authentication.email_verification_failed",
    "authentication.email_verification_succeeded",
    "authentication.magic_auth_failed",
    "authentication.magic_auth_succeeded",
    "authentication.mfa_failed",
    "authentication.mfa_succeeded",
    "authentication.oauth_failed",
    "authentication.oauth_succeeded",
    "authentication.passkey_failed",
    "authentication.passkey_succeeded",
    "authentication.password_failed",
    "authentication.password_succeeded",
    "authentication.radar_risk_detected",
    "authentication.sso_failed",
    "authentication.sso_succeeded",
)
EVENT_TYPES: tuple[str, ...] = (*USER_EVENTS, *ORG_EVENTS, *MEMBERSHIP_EVENTS, *INVITATION_EVENTS, *AUDIT_EVENTS)

Effects = list[Callable[[], Any]]


# ---- Small helpers -----------------------------------------------------------------------------


def _aware(t: datetime | None) -> datetime | None:
    if t is None:
        return None
    return t if t.tzinfo else t.replace(tzinfo=UTC)


def _stamp(ev: dict[str, Any]) -> datetime | None:
    """The object's `updated_at` (what `upsert_newer` compares), else the event's time."""
    d = ev.get("data") or {}
    return _dt(d.get("updated_at")) or _dt(ev.get("created_at"))


def _newer(new: datetime | None, stored: datetime | None) -> bool:
    if stored is None or new is None:
        return True
    return _aware(new) > _aware(stored)  # type: ignore[operator]


def _ensure_user(db: Session, workos_user_id: str) -> str:
    """The principal; a stub `users` row (no email yet) when we haven't seen this user."""
    principal = principal_of(workos_user_id)
    insert_ignore(db, User, [{"id": principal, "workos_user_id": workos_user_id, "email": "", "created_at": now()}])
    return principal


def _known_org(db: Session, workos_org_id: str | None) -> str | None:
    """Our org id for a WorkOS org we already mirror (audit rows don't create stubs)."""
    if not workos_org_id:
        return None
    return db.scalar(select(Organization.id).where(Organization.workos_org_id == workos_org_id))


def map_role(slugs: list[str]) -> str:
    """The `organization_members.role` for WorkOS role slugs: our first known role, else the
    first custom slug when it fits the column, else `member`. All slugs stay in `role_slugs`;
    code checks permissions from the token, never this column (D5)."""
    for s in slugs:
        if s in ORG_ROLES:
            return s
    return slugs[0] if slugs and len(slugs[0]) <= 16 else "member"


def _revoke(principal: str, org_id: str | None) -> Callable[[], None]:
    def run() -> None:
        from .session import revoke_sessions_for

        with session_scope() as db:
            n = revoke_sessions_for(db, principal, org_id)
        if n:
            log.info("workos_sync.revoked", extra={"event": "workos_sync.revoked", "principal": principal, "orgId": org_id, "tokens": n})

    return run


def _forget(workos_user_id: str) -> Callable[[], None]:
    return lambda: forget_memberships(workos_user_id)


# ---- Users ------------------------------------------------------------------------------------


def apply_user(db: Session, d: dict[str, Any], stamp: datetime | None, fx: Effects) -> None:
    principal = principal_of(d["id"])
    row = db.get(User, principal)
    if row is not None and row.deleted_at is not None:
        return  # a deleted WorkOS user never comes back under the same id
    upsert_newer(db, User, {
        "id": principal,
        "workos_user_id": d["id"],
        "email": str(d.get("email") or "").strip().lower(),
        "first_name": d.get("first_name"),
        "last_name": d.get("last_name"),
        "avatar_url": d.get("profile_picture_url"),
        "email_verified": bool(d.get("email_verified")),
        "last_sign_in_at": _dt(d.get("last_sign_in_at")),
        "workos_updated_at": stamp,
    }, ["id"])


def tombstone_user(db: Session, workos_user_id: str, at: datetime | None, fx: Effects) -> bool:
    """Clear what identifies the person and mark the row deleted. The principal itself stays
    wherever it's recorded (annotations, revisions, commits, audit): provenance survives."""
    principal = _ensure_user(db, workos_user_id)
    row = db.get(User, principal)
    assert row is not None
    if row.deleted_at is not None:
        return False
    row.email, row.first_name, row.last_name, row.avatar_url = "", None, None, None
    row.email_verified, row.marketing = False, False
    row.deleted_at = at or now()
    row.workos_updated_at = at or row.workos_updated_at
    orgs = list(db.scalars(select(OrganizationMember.org_id).where(OrganizationMember.principal == principal)))
    db.execute(update(OrganizationMember).where(OrganizationMember.principal == principal).values(status="inactive"))
    db.flush()
    fx.append(_revoke(principal, None))
    fx.append(_forget(workos_user_id))
    log.info("workos_sync.user_deleted", extra={"event": "workos_sync.user_deleted", "principal": principal, "orgs": len(orgs)})
    return True


def _on_user(db: Session, ev: dict[str, Any], fx: Effects) -> None:
    d = ev["data"]
    if ev["event"] == "user.deleted":
        tombstone_user(db, d["id"], _stamp(ev), fx)
    else:
        apply_user(db, d, _stamp(ev), fx)


# ---- Organizations ----------------------------------------------------------------------------


def apply_org(db: Session, d: dict[str, Any], stamp: datetime | None) -> str:
    oid = org_for_workos_id(db, d["id"], d.get("name"))
    row = db.get(Organization, oid)
    assert row is not None
    if _newer(stamp, row.workos_updated_at):
        if d.get("name"):
            row.name = d["name"]
        row.workos_updated_at = stamp
        db.flush()
    return oid


def _on_org(db: Session, ev: dict[str, Any], fx: Effects) -> None:
    d = ev["data"]
    if ev["event"] != "organization.deleted":
        apply_org(db, d, _stamp(ev))
        return
    oid = _known_org(db, d["id"])
    if oid is None:
        return
    # The row stays (projects reference it); nobody is a member any more.
    members = list(db.scalars(select(OrganizationMember.principal).where(OrganizationMember.org_id == oid)))
    db.execute(update(OrganizationMember).where(OrganizationMember.org_id == oid).values(status="inactive"))
    db.flush()
    for p in members:
        fx.append(_revoke(p, oid))
    fx.append(lambda: forget_memberships())


# ---- Memberships ------------------------------------------------------------------------------


def _slugs(d: dict[str, Any]) -> list[str]:
    roles = [r.get("slug") for r in (d.get("roles") or []) if isinstance(r, dict) and r.get("slug")]
    if not roles and isinstance(d.get("role"), dict) and d["role"].get("slug"):
        roles = [d["role"]["slug"]]
    return roles


def apply_membership(db: Session, d: dict[str, Any], stamp: datetime | None, fx: Effects, *, deleted: bool = False) -> None:
    org_id = org_for_workos_id(db, d["organization_id"], d.get("organization_name"))
    principal = _ensure_user(db, d["user_id"])
    existing = db.get(OrganizationMember, (org_id, principal))
    if deleted:
        # Only the membership this event is about: a person invited again has a new membership
        # id, which a replayed deletion of the old one leaves alone.
        if existing is not None and existing.workos_membership_id in (None, d["id"]):
            db.delete(existing)
            db.flush()
        fx.append(_revoke(principal, org_id))
        fx.append(_forget(d["user_id"]))
        return
    slugs = _slugs(d)
    status = str(d.get("status") or "active")
    upsert_newer(db, OrganizationMember, {
        "org_id": org_id,
        "principal": principal,
        "role": map_role(slugs),
        "role_slugs": slugs or None,
        "status": status,
        "workos_membership_id": d["id"],
        "workos_updated_at": stamp,
    }, ["org_id", "principal"])
    row = db.get(OrganizationMember, (org_id, principal))
    if row is not None:
        db.refresh(row)
    if row is not None and row.status != "active":
        fx.append(_revoke(principal, org_id))  # deactivated (or still pending): no agent tokens
    fx.append(_forget(d["user_id"]))


def _on_membership(db: Session, ev: dict[str, Any], fx: Effects) -> None:
    apply_membership(db, ev["data"], _stamp(ev), fx, deleted=ev["event"].endswith(".deleted"))


# ---- Invitations ------------------------------------------------------------------------------


def apply_accepted_invitation(db: Session, invitation_id: str, principal: str) -> int:
    """Pending project grants of an accepted invitation become `project_members` rows (todo9
    Phase 6). `invitation_id` is ours or WorkOS's; grants under either are applied. A role the
    person already has on a project is kept. Returns how many grants were applied."""
    ids = {invitation_id}
    inv = db.get(OrgInvitation, invitation_id) or db.scalar(select(OrgInvitation).where(OrgInvitation.workos_invitation_id == invitation_id))
    if inv is not None:
        ids |= {inv.id, *([inv.workos_invitation_id] if inv.workos_invitation_id else [])}
    grants = list(db.scalars(select(PendingProjectGrant).where(PendingProjectGrant.invitation_id.in_(ids))))
    if grants:
        insert_ignore(db, ProjectMember, [{"project_id": g.project_id, "principal": principal, "role": g.role, "added_by": g.added_by, "added_at": now()} for g in grants])
        db.execute(delete(PendingProjectGrant).where(PendingProjectGrant.invitation_id.in_(ids)))
        db.flush()
    return len(grants)


_INVITATION_STATE = {"invitation.created": "pending", "invitation.accepted": "accepted", "invitation.revoked": "revoked"}


def _on_invitation(db: Session, ev: dict[str, Any], fx: Effects) -> None:
    d = ev["data"]
    wid = d["id"]
    stamp = _stamp(ev)
    state = str(d.get("state") or _INVITATION_STATE.get(ev["event"], "pending"))
    row = db.scalar(select(OrgInvitation).where(OrgInvitation.workos_invitation_id == wid)) or db.get(OrgInvitation, wid)
    if row is None and d.get("organization_id"):
        org_id = org_for_workos_id(db, d["organization_id"])
        insert_ignore(db, OrgInvitation, [{
            "id": wid, "org_id": org_id, "email": str(d.get("email") or "").strip().lower(), "role": d.get("role_slug") or "member",
            "state": state, "inviter": principal_of(d["inviter_user_id"]) if d.get("inviter_user_id") else None,
            "workos_invitation_id": wid, "expires_at": _dt(d.get("expires_at")), "created_at": _dt(d.get("created_at")) or now(), "workos_updated_at": stamp,
        }])
        row = db.get(OrgInvitation, wid)
    elif row is not None and _newer(stamp, row.workos_updated_at):
        row.state = state
        row.expires_at = _dt(d.get("expires_at")) or row.expires_at
        row.workos_updated_at = stamp
        if not row.workos_invitation_id:
            row.workos_invitation_id = wid
        db.flush()
    our_id = row.id if row is not None else wid
    if ev["event"] == "invitation.accepted" and d.get("accepted_user_id"):
        apply_accepted_invitation(db, our_id, _ensure_user(db, d["accepted_user_id"]))
    elif ev["event"] == "invitation.revoked":
        db.execute(delete(PendingProjectGrant).where(PendingProjectGrant.invitation_id.in_({our_id, wid})))
        db.flush()


# ---- Audit-only events ------------------------------------------------------------------------


def _on_audit(db: Session, ev: dict[str, Any], fx: Effects) -> None:
    """One `audit_events` row: ids, kinds and states only (never the email in the payload)."""
    d = ev.get("data") or {}
    owner = d.get("owner") if isinstance(d.get("owner"), dict) else {}
    workos_org = d.get("organization_id") or (owner.get("id") if owner.get("type") == "organization" else None)
    user_id = d.get("user_id") or (owner.get("id") if owner.get("type") == "user" else None)
    ctx = ev.get("context") or {}
    detail = {k: d[k] for k in ("status", "type", "state", "connection_type", "domain") if isinstance(d.get(k), str)}
    insert_ignore(db, AuditEvent, [{
        "id": ev["id"][:64],
        "org_id": _known_org(db, workos_org),
        "actor": principal_of(user_id) if user_id else "workos",
        "action": f"workos.{ev['event']}",
        "target": str(d.get("id") or (principal_of(user_id) if user_id else ""))[:256] or None,
        "ip": (d.get("ip_address") or ctx.get("ip_address") or None),
        "user_agent": (str(d.get("user_agent") or ctx.get("user_agent") or "")[:512] or None),
        "detail": detail or None,
        "at": _dt(ev.get("created_at")) or now(),
    }])


def _handler(event_type: str) -> Callable[[Session, dict[str, Any], Effects], None] | None:
    if event_type in USER_EVENTS:
        return _on_user
    if event_type in ORG_EVENTS:
        return _on_org
    if event_type in MEMBERSHIP_EVENTS:
        return _on_membership
    if event_type in INVITATION_EVENTS:
        return _on_invitation
    if event_type.split(".", 1)[0] in ("session", "organization_domain", "api_key", "connection", "authentication"):
        return _on_audit
    return None


def apply_event(db: Session, ev: dict[str, Any], fx: Effects) -> bool:
    """Apply one event (dict form) unless already processed; record it. True when applied."""
    if db.get(WorkosEventProcessed, ev["id"]) is not None:
        return False
    h = _handler(str(ev.get("event")))
    if h is not None:
        h(db, ev, fx)
    insert_ignore(db, WorkosEventProcessed, [{"event_id": ev["id"], "processed_at": now()}])
    return True


# ---- The cursor -------------------------------------------------------------------------------


def cursor(db: Session, consumer: str = CONSUMER) -> WorkosEventCursor | None:
    return db.get(WorkosEventCursor, consumer)


def _set_cursor(db: Session, event_id: str | None, consumer: str = CONSUMER) -> None:
    row = db.get(WorkosEventCursor, consumer)
    if row is None:
        insert_ignore(db, WorkosEventCursor, [{"consumer": consumer, "last_event_id": event_id, "updated_at": now()}])
        row = db.get(WorkosEventCursor, consumer)
    if row is not None:
        row.last_event_id = event_id if event_id is not None else row.last_event_id
        row.updated_at = now()
        db.flush()


# ---- Event sources ----------------------------------------------------------------------------


class EventSource(Protocol):
    def list_events(self, *, after: str | None, limit: int) -> list[dict[str, Any]]: ...


def _as_dict(obj: Any) -> dict[str, Any]:
    return obj if isinstance(obj, dict) else obj.to_dict()


_sync_client: Any = None


def sync_client() -> Any:
    """A synchronous `WorkOSClient` for the sync thread (the api's async client belongs to the
    request event loop). Built from settings only; tests swap it with `set_sync_client`."""
    global _sync_client
    if _sync_client is None:
        from workos import WorkOSClient

        s = settings()
        _sync_client = WorkOSClient(api_key=s.workos_api_key, client_id=s.workos_client_id, base_url=wclient.base_url())
    return _sync_client


def set_sync_client(c: Any) -> None:
    global _sync_client
    _sync_client = c


class WorkOSEventSource:
    """`GET /events` in ascending order after the cursor; the first poll (no cursor) starts 29
    days back, the Events API's per-query limit."""

    def __init__(self, c: Any | None = None) -> None:
        self._c = c

    def list_events(self, *, after: str | None, limit: int) -> list[dict[str, Any]]:
        c = self._c or sync_client()
        kw: dict[str, Any] = {"events": list(EVENT_TYPES), "limit": limit, "order": "asc"}
        if after:
            kw["after"] = after
        else:
            kw["range_start"] = (datetime.now(UTC) - FIRST_RANGE).isoformat().replace("+00:00", "Z")
        page = c.events.list_events(**kw)
        return [_as_dict(e) for e in page.data]


# ---- One poll ---------------------------------------------------------------------------------


class Stats:
    """What the loop reports (log lines; `status()` for the CLI and tests)."""

    def __init__(self) -> None:
        self.events = 0
        self.failures = 0
        self.caught_up_at: float | None = None  # wall clock of the last fully drained poll
        self.newest_event_at: datetime | None = None
        self.attempts: dict[str, int] = {}

    def lag_s(self) -> float:
        return 0.0 if self.caught_up_at is None else max(0.0, time.time() - self.caught_up_at)


stats = Stats()


def _run_effects(fx: Effects, ev: dict[str, Any]) -> None:
    for f in fx:
        try:
            f()
        except Exception as e:  # noqa: BLE001 — the event is applied; a failed side effect is logged
            log.warning("workos_sync.effect_failed", extra={"event": "workos_sync.effect_failed", "eventId": ev.get("id"), "eventType": ev.get("event"), "errorClass": type(e).__name__})


def process(events: Iterable[dict[str, Any]], st: Stats | None = None) -> tuple[int, int, bool]:
    """Apply events in order, one transaction each. Returns (applied, failures, stopped): a
    failure stops the batch (retried next poll) until the event has failed MAX_ATTEMPTS times,
    then it's skipped with an error line so one bad event can't stall the stream."""
    st = st or stats
    applied = failures = 0
    for raw in events:
        ev = _as_dict(raw)
        eid = ev["id"]
        fx: Effects = []
        try:
            with session_scope() as db:
                did = apply_event(db, ev, fx)
                _set_cursor(db, eid)
        except Exception as e:  # noqa: BLE001
            failures += 1
            st.failures += 1
            n = st.attempts[eid] = st.attempts.get(eid, 0) + 1
            log.warning("workos_sync.failed", extra={"event": "workos_sync.failed", "eventId": eid, "eventType": ev.get("event"), "errorClass": type(e).__name__, "attempt": n}, exc_info=True)
            if n < MAX_ATTEMPTS:
                return applied, failures, True
            log.error("workos_sync.skipped", extra={"event": "workos_sync.skipped", "eventId": eid, "eventType": ev.get("event")})
            with session_scope() as db:
                _set_cursor(db, eid)
            st.attempts.pop(eid, None)
            continue
        st.attempts.pop(eid, None)
        if did:
            applied += 1
            st.events += 1
        st.newest_event_at = _dt(ev.get("created_at")) or st.newest_event_at
        _run_effects(fx, ev)
    return applied, failures, False


def tick(source: EventSource | None = None, st: Stats | None = None) -> dict[str, Any]:
    """Poll until drained (at most MAX_PAGES_PER_TICK pages). Logs one `workos_sync.batch`
    line when anything happened."""
    st = st or stats
    source = source or WorkOSEventSource()
    started = time.monotonic()
    applied = failures = seen = 0
    drained = False
    for _ in range(MAX_PAGES_PER_TICK):
        with session_scope() as db:
            c = cursor(db)
            after = c.last_event_id if c is not None else None
        page = source.list_events(after=after, limit=PAGE)
        seen += len(page)
        a, f, stopped = process(page, st)
        applied, failures = applied + a, failures + f
        if stopped:
            break
        if len(page) < PAGE:
            drained = True
            break
    if drained:
        st.caught_up_at = time.time()
    out = {"events": applied, "seen": seen, "failures": failures, "drained": drained}
    if seen or failures:
        elapsed = max(time.monotonic() - started, 1e-3)
        lag_ms = int((datetime.now(UTC) - _aware(st.newest_event_at)).total_seconds() * 1000) if st.newest_event_at else 0  # type: ignore[operator]
        log.info("workos_sync.batch", extra={"event": "workos_sync.batch", "events": applied, "seen": seen, "failures": failures, "lag_ms": lag_ms, "events_per_s": round(applied / elapsed, 2)})
        out["lag_ms"] = lag_ms
    return out


# ---- Reconciliation ---------------------------------------------------------------------------


def _paged(page: Any) -> Iterable[Any]:
    return page.auto_paging_iter() if hasattr(page, "auto_paging_iter") else page.data


def reconcile(c: Any | None = None) -> dict[str, int]:
    """Fix drift the events missed (a gap longer than the 90 days WorkOS keeps, a skipped
    event): every user, every mirrored org's name and memberships. People gone from WorkOS are
    tombstoned; memberships gone are deleted and their tokens revoked. Logs the counts."""
    c = c or sync_client()
    started = datetime.now(UTC)
    counts = {"users": 0, "usersTombstoned": 0, "orgs": 0, "memberships": 0, "membershipsRemoved": 0}
    fx: Effects = []
    seen_users: set[str] = set()
    for u in _paged(c.user_management.list_users(limit=PAGE)):
        d = _as_dict(u)
        seen_users.add(d["id"])
        with session_scope() as db:
            apply_user(db, d, _dt(d.get("updated_at")), fx)
        counts["users"] += 1
    with session_scope() as db:
        # Rows written after the listing began (a sign-up meanwhile) aren't drift.
        gone = [r for r in db.scalars(select(User).where(User.deleted_at.is_(None))) if r.workos_user_id not in seen_users and _before(r.created_at, started)]
        for r in gone:
            if tombstone_user(db, r.workos_user_id, now(), fx):
                counts["usersTombstoned"] += 1
    with session_scope() as db:
        orgs = [(o.id, o.workos_org_id) for o in db.scalars(select(Organization).where(Organization.workos_org_id.is_not(None)))]
    for oid, workos_org_id in orgs:
        try:
            o = _as_dict(c.organizations.get_organization(workos_org_id))
        except Exception:  # noqa: BLE001 — a deleted org: its memberships go below
            o = None
        if o is not None:
            with session_scope() as db:
                apply_org(db, o, _dt(o.get("updated_at")))
            counts["orgs"] += 1
        seen_m: set[str] = set()
        if o is not None:
            for m in _paged(c.organization_membership.list_organization_memberships(organization_id=workos_org_id, statuses=["active", "inactive", "pending"], limit=PAGE)):
                d = _as_dict(m)
                seen_m.add(d["id"])
                with session_scope() as db:
                    apply_membership(db, d, _dt(d.get("updated_at")), fx)
                counts["memberships"] += 1
        with session_scope() as db:
            for row in db.scalars(select(OrganizationMember).where(OrganizationMember.org_id == oid, OrganizationMember.workos_membership_id.is_not(None))):
                if row.workos_membership_id not in seen_m and _before(row.created_at, started) and _before(row.workos_updated_at, started):
                    fx.append(_revoke(row.principal, oid))
                    db.delete(row)
                    counts["membershipsRemoved"] += 1
    for f in fx:
        try:
            f()
        except Exception:  # noqa: BLE001
            log.warning("workos_sync.effect_failed", exc_info=True)
    with session_scope() as db:
        _set_cursor(db, None, RECONCILE_CONSUMER)
    log.info("workos_sync.reconciled", extra={"event": "workos_sync.reconciled", **counts})
    return counts


def _before(t: datetime | None, at: datetime) -> bool:
    return t is None or _aware(t) < at  # type: ignore[operator]


def reconcile_due(at: datetime | None = None) -> bool:
    with session_scope() as db:
        row = cursor(db, RECONCILE_CONSUMER)
        last = _aware(row.updated_at) if row is not None else None
    return last is None or (at or datetime.now(UTC)) - last >= RECONCILE_EVERY


# ---- The single-replica lock and the loop -----------------------------------------------------


class _Lock:
    """A Postgres session advisory lock on its own connection, held while the loop runs (lost
    with the connection, then retaken). SQLite (one dev process): always held."""

    def __init__(self) -> None:
        self._conn: Any = None

    def held(self) -> bool:
        if engine().dialect.name != "postgresql":
            return True
        if self._conn is not None:
            try:
                self._conn.execute(text("SELECT 1"))
                return True
            except Exception:  # noqa: BLE001 — the connection died with the lock
                self.release()
        try:
            conn = engine().connect()
            ok = bool(conn.execute(text("SELECT pg_try_advisory_lock(hashtextextended(:k, 0))"), {"k": LOCK_KEY}).scalar())
            conn.commit()
            if ok:
                self._conn = conn
                log.info("workos_sync.leader", extra={"event": "workos_sync.leader"})
                return True
            conn.close()
        except Exception:  # noqa: BLE001
            log.warning("workos sync lock unavailable", exc_info=True)
        return False

    def release(self) -> None:
        if self._conn is None:
            return
        try:
            self._conn.execute(text("SELECT pg_advisory_unlock(hashtextextended(:k, 0))"), {"k": LOCK_KEY})
            self._conn.close()
        except Exception:  # noqa: BLE001
            pass
        self._conn = None


def run(stop: threading.Event, source: EventSource | None = None) -> None:
    interval = settings().workos_sync_interval_s
    lock = _Lock()
    lag_logged = 0.0
    stats.caught_up_at = stats.caught_up_at or time.time()
    try:
        while not stop.is_set():
            if lock.held():
                try:
                    tick(source)
                    if reconcile_due():
                        reconcile()
                except Exception as e:  # noqa: BLE001 — WorkOS down, DB blip: the next poll retries
                    log.warning("workos_sync.poll_failed", extra={"event": "workos_sync.poll_failed", "errorClass": type(e).__name__})
                lag = stats.lag_s()
                if lag > LAG_ALERT.total_seconds() and time.monotonic() - lag_logged >= 60:
                    lag_logged = time.monotonic()
                    log.warning("workos_sync.lagging", extra={"event": "workos_sync.lagging", "lag_ms": int(lag * 1000)})
            stop.wait(interval)
    finally:
        lock.release()


def start(stop: threading.Event) -> threading.Thread | None:
    """Start the sync thread (workos mode, interval > 0); None otherwise."""
    s = settings()
    if not s.workos or s.workos_sync_interval_s <= 0:
        return None
    t = threading.Thread(target=run, args=(stop,), name="workos-sync", daemon=True)
    t.start()
    return t


def status() -> dict[str, Any]:
    with session_scope() as db:
        c = cursor(db)
        r = cursor(db, RECONCILE_CONSUMER)
        return {
            "cursor": c.last_event_id if c else None,
            "cursorUpdatedAt": c.updated_at.isoformat() if c else None,
            "reconciledAt": r.updated_at.isoformat() if r else None,
            "processed": db.query(WorkosEventProcessed).count(),
        }


def _main(argv: list[str]) -> int:
    import json

    cmd = argv[0] if argv else "status"
    if cmd == "reconcile":
        print(json.dumps(reconcile()))
    elif cmd == "once":
        print(json.dumps(tick()))
    elif cmd == "status":
        print(json.dumps(status()))
    else:
        print("usage: python -m studio_api.auth.sync [status|once|reconcile]")
        return 2
    return 0


if __name__ == "__main__":
    import sys

    from studio_observability import setup_service

    setup_service("api", "cli")
    raise SystemExit(_main(sys.argv[1:]))
