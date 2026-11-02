"""Local mirror upserts at sign-in, and a new person's personal organization (todo9 Phase 3, D4).

The callback writes what it learns right away (the user, the organization, the membership) so
the Studio works before the event sync (Phase 7) catches up; events reconcile later with the
same `workos_updated_at` rule (`dbutil.upsert_newer`).

A personal organization is empty: no Samples membership (todo14 D2), so a new person lands on
the empty Home. Its WorkOS `external_id` is our org id.
"""

from __future__ import annotations

import hashlib
import logging
import time
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..dbutil import insert_ignore, upsert_newer
from ..models import Organization, OrganizationMember, User, now
from . import client as wclient

log = logging.getLogger(__name__)

PERSONAL_ORG_NAME = "Personal"
ADMIN_ROLE = "admin"


def _dt(v: Any) -> datetime | None:
    if v is None or isinstance(v, datetime):
        return v
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None


def principal_of(workos_user_id: str) -> str:
    return f"user:{workos_user_id}"


def _stub_org_id(workos_org_id: str) -> str:
    return "org-" + hashlib.sha256(f"workos:{workos_org_id}".encode()).hexdigest()[:16]


def org_for_workos_id(db: Session, workos_org_id: str, name: str | None = None) -> str:
    """Our org id for a WorkOS organization; a stub row (team, named later by events) when we
    haven't seen it yet. Safe against concurrent first requests."""
    found = db.scalar(select(Organization.id).where(Organization.workos_org_id == workos_org_id))
    if found is not None:
        return found
    oid = _stub_org_id(workos_org_id)
    insert_ignore(db, Organization, [{"id": oid, "name": name or "", "kind": "team", "created_at": now(), "workos_org_id": workos_org_id}])
    return db.scalar(select(Organization.id).where(Organization.workos_org_id == workos_org_id)) or oid


def current_org(db: Session, ctx: Any) -> str | None:
    """The organization a request acts in: the signed-in one, else (dev identity) the person's
    personal organization. For org routes (members, invitations, keys, audit) in both modes."""
    if ctx.org_id:
        return ctx.org_id
    from ..kernel.projects import ensure_principal, person

    return ensure_principal(db, person(ctx))


def upsert_user(db: Session, user: dict[str, Any]) -> str:
    """The `users` row for a WorkOS user dict (as sealed in the cookie); returns the principal."""
    principal = principal_of(user["id"])
    upsert_newer(db, User, {
        "id": principal,
        "workos_user_id": user["id"],
        "email": str(user.get("email") or "").strip().lower(),
        "first_name": user.get("first_name"),
        "last_name": user.get("last_name"),
        "avatar_url": user.get("profile_picture_url"),
        "email_verified": bool(user.get("email_verified")),
        "last_sign_in_at": _dt(user.get("last_sign_in_at")),
        "workos_updated_at": _dt(user.get("updated_at")),
        "created_at": now(),
    }, ["id"])
    return principal


def ensure_membership(db: Session, org_id: str, principal: str, role: str | None, *, workos_membership_id: str | None = None) -> None:
    """Mirror an active membership (role from the token or WorkOS)."""
    m = db.get(OrganizationMember, (org_id, principal))
    if m is None:
        insert_ignore(db, OrganizationMember, [{"org_id": org_id, "principal": principal, "role": role or "member", "status": "active", "role_slugs": [role] if role else None, "workos_membership_id": workos_membership_id, "created_at": now()}])
        return
    m.status = "active"
    if role:
        m.role, m.role_slugs = role, [role]
    if workos_membership_id and not m.workos_membership_id:
        m.workos_membership_id = workos_membership_id
    db.flush()


async def personal_org(db: Session, workos_user_id: str) -> str:
    """Create (or find) the person's personal organization in WorkOS and here, with them as
    Admin. Returns the WorkOS organization id; the caller refreshes the session into it."""
    from workos._errors import APIError, NotFoundError
    from workos.organization_membership._resource import RoleSingle

    from ..kernel.projects import personal_org_id

    principal = principal_of(workos_user_id)
    our_id = personal_org_id(principal)
    w = wclient.client()
    row = db.get(Organization, our_id)
    workos_org_id = row.workos_org_id if row is not None else None
    if workos_org_id is None:
        try:
            workos_org_id = (await w.organizations.get_organization_by_external_id(our_id)).id
        except NotFoundError:
            workos_org_id = (await w.organizations.create_organization(name=PERSONAL_ORG_NAME, external_id=our_id)).id
    membership_id = None
    try:
        membership_id = (await w.organization_membership.create_organization_membership(user_id=workos_user_id, organization_id=workos_org_id, role=RoleSingle(role_slug=ADMIN_ROLE))).id
    except APIError as e:
        if (e.status_code or 500) >= 500:
            raise
        log.info("personal org membership exists already (%s)", e.status_code)  # a retried sign-in
    if row is None:
        insert_ignore(db, Organization, [{"id": our_id, "name": PERSONAL_ORG_NAME, "kind": "personal", "created_at": now(), "workos_org_id": workos_org_id}])
    elif row.workos_org_id is None:
        row.workos_org_id = workos_org_id
        db.flush()
    ensure_membership(db, our_id, principal, ADMIN_ROLE, workos_membership_id=membership_id)
    return workos_org_id


# ---- The organization switcher: a person's active memberships (cached 60 s per process) --------

_MEMBERSHIPS_TTL_S = 60.0
_memberships: dict[str, tuple[float, list[tuple[str, str]]]] = {}


async def memberships(db: Session, workos_user_id: str) -> list[dict[str, Any]]:
    """`[{id, workosOrgId, name}]` for every active membership, from WorkOS (cached 60 s),
    mirrored locally; the local mirror alone when WorkOS can't be reached."""
    principal = principal_of(workos_user_id)
    hit = _memberships.get(workos_user_id)
    rows: list[tuple[str, str]] | None = hit[1] if hit and time.monotonic() - hit[0] < _MEMBERSHIPS_TTL_S else None
    if rows is None:
        try:
            page = await wclient.client().organization_membership.list_organization_memberships(user_id=workos_user_id, statuses=["active"], limit=100)
            rows = [(m.organization_id, m.organization_name or "") async for m in page.auto_paging_iter()]
            _memberships[workos_user_id] = (time.monotonic(), rows)
        except Exception:  # noqa: BLE001 — the switcher degrades to what we know
            log.warning("listing WorkOS memberships failed; using the local mirror", exc_info=True)
    out: list[dict[str, Any]] = []
    if rows is not None:
        for workos_org_id, name in rows:
            oid = org_for_workos_id(db, workos_org_id, name)
            org = db.get(Organization, oid)
            if org is not None and name and not org.name:
                org.name = name
            out.append({"id": oid, "workosOrgId": workos_org_id, "name": (org.name if org else name) or name})
        return out
    q = select(Organization).join(OrganizationMember, OrganizationMember.org_id == Organization.id).where(OrganizationMember.principal == principal, OrganizationMember.status == "active", Organization.workos_org_id.is_not(None))
    return [{"id": o.id, "workosOrgId": o.workos_org_id, "name": o.name} for o in db.scalars(q)]


def forget_memberships(workos_user_id: str | None = None) -> None:
    """Drop the switcher cache (after a membership change, and in tests)."""
    if workos_user_id is None:
        _memberships.clear()
    else:
        _memberships.pop(workos_user_id, None)
