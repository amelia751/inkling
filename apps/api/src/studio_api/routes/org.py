"""Organization settings, members, invitations and project members (todo9 Phase 6).

    GET    /api/v1/org                               OrgSettings (any member)
    PATCH  /api/v1/org {name?, zeroRetention?, aiAssist?}            org:manage
    GET    /api/v1/org/members                       {members} (any member; with project counts)
    PATCH  /api/v1/org/members/{membershipId} {role} members:manage
    DELETE /api/v1/org/members/{membershipId}        members:manage (deactivates; revokes agent tokens)
    GET    /api/v1/org/invitations                   members:manage
    POST   /api/v1/org/invitations {emails, role, projects}           members:manage
    POST   /api/v1/org/invitations/{id}/resend       members:manage
    DELETE /api/v1/org/invitations/{id}              members:manage
    GET    /api/v1/projects/{id}/members             anyone who sees the project
    POST   /api/v1/projects/{id}/members {userId, role}               project owner (org Admins are owners)
    PATCH  /api/v1/projects/{id}/members/{userId} {role}
    DELETE /api/v1/projects/{id}/members/{userId}

workos mode calls WorkOS first and updates the local mirror right away (the event sync
reconciles later); WorkOS's error text comes back in `detail`. dev mode works on the local
database only (invitation ids `inv_…`). Guards: nobody changes their own role or removes
themselves; an organization keeps at least one active Admin; a pending membership can only be
revoked. Every change writes an `audit_events` row. Another organization's members,
invitations and projects answer 404.
"""

from __future__ import annotations

import hashlib
import re
import secrets
import time
from collections.abc import Awaitable
from datetime import UTC, datetime, timedelta
from typing import Any, TypeVar

from fastapi import APIRouter, Body, Depends, HTTPException, Response
from fastapi.responses import JSONResponse
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..auth import audit, current_org, require_permission
from ..auth import bootstrap
from ..auth import client as wclient
from ..auth.invitations import apply_accepted_invitation
from ..auth.permissions import MEMBERS_MANAGE, ORG_MANAGE
from ..auth.session import revoke_sessions_for
from ..config import settings
from ..context import AUTH_COOKIE, RequestContext, get_context
from ..db import get_session
from ..kernel import projects
from ..models import Organization, OrganizationMember, OrgInvitation, PendingProjectGrant, ProjectMember, ProjectRow, User, now

router = APIRouter(prefix="/api/v1", tags=["org"])

ORG_ROLES = ("admin", "member", "billing")
PROJECT_ROLES = ("owner", "reviewer", "annotator", "viewer")
ROLE_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")
EMAIL_RE = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
INVITE_DAYS = 7
MAX_INVITES = 50
STATUS = {"active": "active", "pending": "invited", "inactive": "deactivated"}

T = TypeVar("T")

# ---- Helpers --------------------------------------------------------------------------------------


def _workos() -> bool:
    return settings().workos


def http_error(e: Exception) -> HTTPException:
    """A WorkOS failure as an HTTP error; WorkOS's own text is the `detail`."""
    from workos._errors import APIError, WorkOSConnectionError, WorkOSTimeoutError

    if isinstance(e, HTTPException):
        return e
    if isinstance(e, (WorkOSConnectionError, WorkOSTimeoutError)):
        return HTTPException(503, "WorkOS is unreachable; try again")
    if isinstance(e, APIError):
        status = e.status_code or 500
        text = str(e.error_description or e.message or type(e).__name__)
        if status in (408, 429) or status >= 500:
            return HTTPException(503, f"WorkOS is unavailable; try again ({text})")
        return HTTPException(status if status in (400, 404, 409, 422) else 400, text)
    return HTTPException(502, f"WorkOS call failed: {type(e).__name__}")


async def _call(aw: Awaitable[T]) -> T:
    """A WorkOS call; its error text becomes the response's `detail`."""
    try:
        return await aw
    except Exception as e:  # noqa: BLE001 — classified by http_error
        raise http_error(e) from None


def _workos_user(principal: str) -> str | None:
    return principal.split(":", 1)[1] if principal.startswith("user:") else None


def _org(db: Session, ctx: RequestContext) -> Organization:
    oid = current_org(db, ctx)
    org = db.get(Organization, oid) if oid else None
    if org is None:
        raise HTTPException(404, "no organization")
    return org


def _require_workos_org(org: Organization) -> str:
    if not org.workos_org_id:
        raise HTTPException(409, "this organization isn't linked to WorkOS yet")
    return org.workos_org_id


def _local_membership_id(org_id: str, principal: str) -> str:
    return "mem_" + hashlib.sha256(f"{org_id}:{principal}".encode()).hexdigest()[:20]


def membership_id(m: OrganizationMember) -> str:
    return m.workos_membership_id or _local_membership_id(m.org_id, m.principal)


def _membership(db: Session, org_id: str, mid: str) -> OrganizationMember:
    m = db.scalar(select(OrganizationMember).where(OrganizationMember.workos_membership_id == mid))
    if m is None and mid.startswith("mem_"):
        m = next((x for x in db.scalars(select(OrganizationMember).where(OrganizationMember.org_id == org_id)) if _local_membership_id(x.org_id, x.principal) == mid), None)
    if m is None or m.org_id != org_id:
        raise HTTPException(404, "no such member")
    return m


def _person(db: Session, principal: str) -> tuple[str, str, User | None]:
    """(name, email, users row) for a principal; dev principals have no row."""
    u = db.get(User, principal)
    if u is not None:
        name = " ".join(p for p in (u.first_name, u.last_name) if p) or u.email
        return name, u.email, u
    local = principal.split(":", 1)[-1]
    return " ".join(w.capitalize() for w in local.replace("_", "-").split("-")) or local, f"{local}@localhost", None


def _project_counts(db: Session, org_id: str) -> dict[str, int]:
    q = select(ProjectMember.principal, func.count()).join(ProjectRow, ProjectRow.id == ProjectMember.project_id).where(ProjectRow.org_id == org_id).group_by(ProjectMember.principal)
    return {p: n for p, n in db.execute(q)}


def member_dict(db: Session, m: OrganizationMember, counts: dict[str, int] | None = None) -> dict[str, Any]:
    name, email, u = _person(db, m.principal)
    counts = counts if counts is not None else _project_counts(db, m.org_id)
    return {
        "id": membership_id(m),
        "userId": m.principal,
        "name": name,
        "email": email,
        "role": m.role,
        "status": STATUS.get(m.status or "active", "active"),
        "projects": counts.get(m.principal, 0),
        "lastActive": projects.iso(u.last_sign_in_at) if u else None,
        "sso": False,
    }


def _is_admin_role(role: str | None) -> bool:
    return role in projects.ORG_ADMIN_ROLES


def _other_admins(db: Session, org_id: str, principal: str) -> int:
    q = select(func.count()).select_from(OrganizationMember).where(OrganizationMember.org_id == org_id, OrganizationMember.principal != principal, OrganizationMember.status == "active", OrganizationMember.role.in_(projects.ORG_ADMIN_ROLES))
    return int(db.scalar(q) or 0)


def _dt(v: Any) -> datetime | None:
    if v is None or isinstance(v, datetime):
        return v
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None


def _aware(d: datetime | None) -> datetime | None:
    return d if d is None or d.tzinfo else d.replace(tzinfo=UTC)


def _new_invitation_id() -> str:
    """`inv_` + a ULID-ish id: millisecond time, then randomness (sorts by creation)."""
    return f"inv_{int(time.time() * 1000):012x}{secrets.token_hex(8)}"


def _grants(db: Session, invitation_id: str) -> list[dict[str, str]]:
    q = select(PendingProjectGrant).where(PendingProjectGrant.invitation_id == invitation_id).order_by(PendingProjectGrant.project_id)
    return [{"projectId": g.project_id, "role": g.role} for g in db.scalars(q)]


def invitation_dict(db: Session, inv: OrgInvitation) -> dict[str, Any]:
    state = inv.state
    exp = _aware(inv.expires_at)
    if state == "pending" and exp is not None and exp < datetime.now(UTC):
        state = "expired"
    return {"id": inv.id, "email": inv.email, "role": inv.role, "state": state, "invitedAt": projects.iso(inv.created_at), "expiresAt": projects.iso(inv.expires_at), "projects": _grants(db, inv.id)}


def _invitation(db: Session, org_id: str, invitation_id: str) -> OrgInvitation:
    inv = db.get(OrgInvitation, invitation_id)
    if inv is None or inv.org_id != org_id:
        raise HTTPException(404, "no such invitation")
    return inv


def _mirror_invitation(db: Session, org_id: str, w: Any, *, role: str | None = None, inviter: str | None = None) -> OrgInvitation:
    """Upsert a WorkOS invitation into `org_invitations` (our id = the WorkOS id)."""
    inv = db.get(OrgInvitation, w.id)
    updated = _dt(getattr(w, "updated_at", None))
    if inv is None:
        inv = OrgInvitation(id=w.id, org_id=org_id, email=str(w.email).strip().lower(), role=getattr(w, "role_slug", None) or role or "member", inviter=inviter, workos_invitation_id=w.id, created_at=_dt(getattr(w, "created_at", None)) or now())
        db.add(inv)
    elif updated is not None and inv.workos_updated_at is not None and _aware(inv.workos_updated_at) > updated:
        return inv  # what we hold is newer
    inv.state = str(getattr(w, "state", None) or inv.state or "pending")
    inv.expires_at = _dt(getattr(w, "expires_at", None)) or inv.expires_at
    inv.role = getattr(w, "role_slug", None) or inv.role
    inv.workos_updated_at = updated
    db.flush()
    return inv


def _check_project_grants(db: Session, org_id: str, raw: Any) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for g in raw or []:
        if not isinstance(g, dict):
            raise HTTPException(422, "projects must be {projectId, role} objects")
        pid, role = str(g.get("projectId") or ""), str(g.get("role") or "")
        if role not in PROJECT_ROLES:
            raise HTTPException(422, f"unknown project role {role!r}")
        p = db.get(ProjectRow, pid) if projects.ID_RE.fullmatch(pid) else None
        if p is None or p.org_id != org_id:
            raise HTTPException(404, f"no such project {pid!r} in this organization")
        out.append((pid, role))
    return out


def _check_org_role(role: Any) -> str:
    role = str(role or "")
    if _workos():
        if not ROLE_RE.fullmatch(role):
            raise HTTPException(422, "role must be a role slug")
    elif role not in ORG_ROLES:
        raise HTTPException(422, f"role must be one of {', '.join(ORG_ROLES)}")
    return role


# ---- Organization settings -------------------------------------------------------------------------


async def _domains(org: Organization) -> list[dict[str, str]]:
    if not _workos() or not org.workos_org_id:
        return []
    try:
        w = await wclient.client().organizations.get_organization(org.workos_org_id)
    except Exception:  # noqa: BLE001 — settings still load without the domain list
        return []
    return [{"domain": d.domain, "state": "verified" if getattr(d, "state", "") == "verified" else "pending"} for d in (getattr(w, "domains", None) or [])]


def _org_dict(org: Organization, domains: list[dict[str, str]]) -> dict[str, Any]:
    return {"id": org.id, "workosOrgId": org.workos_org_id, "name": org.name, "createdAt": projects.iso(org.created_at), "zeroRetention": bool(org.zero_retention), "aiAssist": bool(org.ai_assist), "research": bool(org.research), "domains": domains}


@router.get("/org")
async def get_org(ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    org = _org(db, ctx)
    return _org_dict(org, await _domains(org))


@router.patch("/org")
async def patch_org(body: dict = Body(...), ctx: RequestContext = Depends(require_permission(ORG_MANAGE)), db: Session = Depends(get_session)):
    org = _org(db, ctx)
    changed: dict[str, Any] = {}
    if "name" in body:
        name = str(body.get("name") or "").strip()
        if not name or len(name) > 256:
            raise HTTPException(422, "name must be 1–256 characters")
        if name != org.name:
            if _workos():
                await _call(wclient.client().organizations.update_organization(_require_workos_org(org), name=name))
            org.name = name
            changed["name"] = name
    for key, col in (("zeroRetention", "zero_retention"), ("aiAssist", "ai_assist"), ("research", "research")):
        if key in body:
            if not isinstance(body[key], bool):
                raise HTTPException(422, f"{key} must be true or false")
            if getattr(org, col) != body[key]:
                setattr(org, col, body[key])
                changed[key] = body[key]
    if changed:
        audit(db, ctx, "org.updated", target=org.id, org_id=org.id, detail=changed)
    db.flush()
    return _org_dict(org, await _domains(org))


# ---- Members ---------------------------------------------------------------------------------------


@router.get("/org/members")
def list_members(ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    org = _org(db, ctx)
    counts = _project_counts(db, org.id)
    rows = [member_dict(db, m, counts) for m in db.scalars(select(OrganizationMember).where(OrganizationMember.org_id == org.id))]
    order = {"active": 0, "invited": 1, "deactivated": 2}
    rows.sort(key=lambda r: (order.get(r["status"], 3), r["name"].lower(), r["email"]))
    return {"members": rows}


@router.patch("/org/members/{mid}")
async def patch_member(mid: str, body: dict = Body(...), ctx: RequestContext = Depends(require_permission(MEMBERS_MANAGE)), db: Session = Depends(get_session)):
    org = _org(db, ctx)
    m = _membership(db, org.id, mid)
    role = _check_org_role(body.get("role"))
    if m.principal == projects.person(ctx):
        raise HTTPException(409, "you can't change your own role")
    if m.status == "pending":
        raise HTTPException(409, "this person hasn't joined yet: revoke the invitation instead")
    if m.status != "active":
        raise HTTPException(409, "this membership is deactivated")
    if role == m.role:
        return member_dict(db, m)
    if _is_admin_role(m.role) and not _is_admin_role(role) and _other_admins(db, org.id, m.principal) == 0:
        raise HTTPException(409, "the organization needs at least one Admin")
    if _workos():
        if not m.workos_membership_id:
            raise HTTPException(409, "this membership isn't linked to WorkOS yet")
        from workos.organization_membership._resource import RoleSingle

        await _call(wclient.client().organization_membership.update_organization_membership(m.workos_membership_id, role=RoleSingle(role_slug=role)))
    before = m.role
    m.role, m.role_slugs = role, [role]
    audit(db, ctx, "member.role_changed", target=m.principal, org_id=org.id, detail={"membershipId": membership_id(m), "from": before, "to": role})
    db.flush()
    # The person's next token refresh (≤ 5 min, D10) carries the new role and permissions.
    return member_dict(db, m)


def _drop_project_roles(db: Session, org_id: str, principal: str) -> None:
    pids = select(ProjectRow.id).where(ProjectRow.org_id == org_id)
    db.execute(delete(ProjectMember).where(ProjectMember.principal == principal, ProjectMember.project_id.in_(pids)))


async def _revoke_pending_membership(db: Session, ctx: RequestContext, org: Organization, m: OrganizationMember) -> None:
    """A membership that's still an invitation: revoke the invitation(s), drop the membership."""
    _, email, _ = _person(db, m.principal)
    invs = list(db.scalars(select(OrgInvitation).where(OrgInvitation.org_id == org.id, OrgInvitation.email == email.lower(), OrgInvitation.state == "pending")))
    if _workos():
        for inv in invs:
            await _call(wclient.client().user_management.revoke_invitation(inv.workos_invitation_id or inv.id))
        if m.workos_membership_id:
            try:
                await _call(wclient.client().organization_membership.delete_organization_membership(m.workos_membership_id))
            except HTTPException as e:
                if e.status_code != 404:
                    raise
    for inv in invs:
        inv.state = "revoked"
        db.execute(delete(PendingProjectGrant).where(PendingProjectGrant.invitation_id == inv.id))
        audit(db, ctx, "invitation.revoked", target=inv.id, org_id=org.id, detail={"email": inv.email})
    audit(db, ctx, "member.removed", target=m.principal, org_id=org.id, detail={"membershipId": membership_id(m), "pending": True})
    db.delete(m)


@router.delete("/org/members/{mid}", status_code=204)
async def delete_member(mid: str, ctx: RequestContext = Depends(require_permission(MEMBERS_MANAGE)), db: Session = Depends(get_session)):
    org = _org(db, ctx)
    m = _membership(db, org.id, mid)
    if m.principal == projects.person(ctx):
        raise HTTPException(409, "you can't remove yourself")
    if m.status == "pending":
        await _revoke_pending_membership(db, ctx, org, m)
        db.flush()
        return Response(status_code=204)
    if m.status != "active":
        return Response(status_code=204)  # already deactivated
    if _is_admin_role(m.role) and _other_admins(db, org.id, m.principal) == 0:
        raise HTTPException(409, "the organization needs at least one Admin")
    principal, mem_id = m.principal, membership_id(m)
    if _workos():
        if m.workos_membership_id:
            # Deactivation keeps the history in WorkOS and ends the person's sessions in this org.
            await _call(wclient.client().organization_membership.deactivate_organization_membership(m.workos_membership_id))
        m.status = "inactive"
        bootstrap.forget_memberships(_workos_user(principal))
    else:
        db.delete(m)
    _drop_project_roles(db, org.id, principal)
    revoked = revoke_sessions_for(db, principal, org.id)
    audit(db, ctx, "member.removed", target=principal, org_id=org.id, detail={"membershipId": mem_id, "revokedTokens": revoked})
    db.flush()
    return Response(status_code=204)


# ---- Invitations -----------------------------------------------------------------------------------


@router.get("/org/invitations")
async def list_invitations(ctx: RequestContext = Depends(require_permission(MEMBERS_MANAGE)), db: Session = Depends(get_session)):
    org = _org(db, ctx)
    if _workos() and org.workos_org_id:
        page = await _call(wclient.client().user_management.list_invitations(organization_id=org.workos_org_id, limit=100))
        try:
            async for w in page.auto_paging_iter():
                inv = _mirror_invitation(db, org.id, w)
                accepted_by = getattr(w, "accepted_user_id", None)
                if inv.state == "accepted" and accepted_by and _grants(db, inv.id):
                    apply_accepted_invitation(db, inv.id, bootstrap.principal_of(accepted_by))
        except Exception as e:  # noqa: BLE001 — a later page failing: classified like any call
            raise http_error(e) from None
    q = select(OrgInvitation).where(OrgInvitation.org_id == org.id).order_by(OrgInvitation.created_at.desc())
    return {"invitations": [invitation_dict(db, i) for i in db.scalars(q)]}


@router.post("/org/invitations")
async def create_invitations(body: dict = Body(...), ctx: RequestContext = Depends(require_permission(MEMBERS_MANAGE)), db: Session = Depends(get_session)):
    org = _org(db, ctx)
    raw = body.get("emails")
    if not isinstance(raw, list) or not raw:
        raise HTTPException(422, "emails must be a non-empty list")
    emails: list[str] = []
    for e in raw:
        addr = str(e or "").strip().lower()
        if not EMAIL_RE.fullmatch(addr):
            raise HTTPException(422, f"{e!r} isn't an email address")
        if addr not in emails:
            emails.append(addr)
    if len(emails) > MAX_INVITES:
        raise HTTPException(422, f"at most {MAX_INVITES} invitations at a time")
    role = _check_org_role(body.get("role") or "member")
    grants = _check_project_grants(db, org.id, body.get("projects"))
    inviter = projects.person(ctx)
    workos_org = _require_workos_org(org) if _workos() else None
    inviter_workos = _workos_user(inviter) if ctx.auth == AUTH_COOKIE else None
    out: list[OrgInvitation] = []
    failed: HTTPException | None = None
    for addr in emails:
        if _workos():
            try:
                w = await _call(wclient.client().user_management.send_invitation(email=addr, organization_id=workos_org, role_slug=role, expires_in_days=INVITE_DAYS, inviter_user_id=inviter_workos))
            except HTTPException as e:
                failed = HTTPException(e.status_code, f"{addr}: {e.detail}")
                break
            inv = _mirror_invitation(db, org.id, w, role=role, inviter=inviter)
            inv.inviter = inviter
        else:
            if db.scalar(select(OrgInvitation.id).where(OrgInvitation.org_id == org.id, OrgInvitation.email == addr, OrgInvitation.state == "pending")):
                failed = HTTPException(409, f"{addr}: an invitation is already pending for this address")
                break
            inv = OrgInvitation(id=_new_invitation_id(), org_id=org.id, email=addr, role=role, state="pending", inviter=inviter, expires_at=now() + timedelta(days=INVITE_DAYS), created_at=now())
            db.add(inv)
        for pid, prole in grants:
            db.merge(PendingProjectGrant(invitation_id=inv.id, project_id=pid, role=prole, added_by=inviter, created_at=now()))
        audit(db, ctx, "invitation.sent", target=inv.id, org_id=org.id, detail={"email": addr, "role": role, "projects": [{"projectId": p, "role": r} for p, r in grants]})
        db.flush()
        out.append(inv)
    if failed is not None:
        # Invitations already sent stay sent (and listed); the error names the address that failed.
        db.commit()
        return JSONResponse({"detail": failed.detail, "invitations": [invitation_dict(db, i) for i in out]}, status_code=failed.status_code)
    return {"invitations": [invitation_dict(db, i) for i in out]}


@router.post("/org/invitations/{invitation_id}/resend")
async def resend_invitation(invitation_id: str, ctx: RequestContext = Depends(require_permission(MEMBERS_MANAGE)), db: Session = Depends(get_session)):
    org = _org(db, ctx)
    inv = _invitation(db, org.id, invitation_id)
    if inv.state in ("accepted", "revoked"):
        raise HTTPException(409, f"this invitation was {inv.state}")
    if _workos():
        w = await _call(wclient.client().user_management.resend_invitation(inv.workos_invitation_id or inv.id))
        _mirror_invitation(db, org.id, w)
    else:
        inv.state, inv.expires_at = "pending", now() + timedelta(days=INVITE_DAYS)
    audit(db, ctx, "invitation.resent", target=inv.id, org_id=org.id, detail={"email": inv.email})
    db.flush()
    return invitation_dict(db, inv)


@router.delete("/org/invitations/{invitation_id}", status_code=204)
async def revoke_invitation(invitation_id: str, ctx: RequestContext = Depends(require_permission(MEMBERS_MANAGE)), db: Session = Depends(get_session)):
    org = _org(db, ctx)
    inv = _invitation(db, org.id, invitation_id)
    if inv.state == "accepted":
        raise HTTPException(409, "this invitation was accepted: remove the member instead")
    if inv.state != "revoked":
        if _workos():
            w = await _call(wclient.client().user_management.revoke_invitation(inv.workos_invitation_id or inv.id))
            _mirror_invitation(db, org.id, w)
        inv.state = "revoked"
        db.execute(delete(PendingProjectGrant).where(PendingProjectGrant.invitation_id == inv.id))
        audit(db, ctx, "invitation.revoked", target=inv.id, org_id=org.id, detail={"email": inv.email})
        db.flush()
    return Response(status_code=204)


# ---- Project members -------------------------------------------------------------------------------


def project_member_dict(db: Session, pm: ProjectMember) -> dict[str, Any]:
    name, email, _ = _person(db, pm.principal)
    return {"projectId": pm.project_id, "userId": pm.principal, "name": name, "email": email, "role": pm.role, "addedBy": pm.added_by, "addedAt": projects.iso(pm.added_at)}


def _manageable(db: Session, ctx: RequestContext, project_id: str) -> ProjectRow:
    """The project, if the caller administers it: its owner, or an org Admin (an owner everywhere)."""
    p = projects.require_project(db, ctx, project_id)
    if ctx.scopes or projects.project_role(db, ctx, p) != "owner":
        raise HTTPException(403, "only a project admin or an organization Admin changes project members")
    return p


def _project_role(raw: Any) -> str:
    role = str(raw or "")
    if role not in PROJECT_ROLES:
        raise HTTPException(422, f"role must be one of {', '.join(PROJECT_ROLES)}")
    return role


def _project_member(db: Session, project_id: str, user_id: str) -> ProjectMember:
    pm = db.get(ProjectMember, (project_id, user_id))
    if pm is None:
        raise HTTPException(404, "no such project member")
    return pm


@router.get("/projects/{project_id}/members")
def list_project_members(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = projects.require_project(db, ctx, project_id)
    rows = [project_member_dict(db, pm) for pm in db.scalars(select(ProjectMember).where(ProjectMember.project_id == p.id))]
    rows.sort(key=lambda r: (PROJECT_ROLES.index(r["role"]) if r["role"] in PROJECT_ROLES else 9, r["name"].lower()))
    return {"members": rows}


@router.post("/projects/{project_id}/members")
def add_project_member(project_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = _manageable(db, ctx, project_id)
    user_id, role = str(body.get("userId") or ""), _project_role(body.get("role"))
    m = db.get(OrganizationMember, (p.org_id, user_id))
    if m is None or m.status != "active":
        raise HTTPException(404, "that person isn't an active member of this organization")
    if db.get(ProjectMember, (p.id, user_id)) is not None:
        raise HTTPException(409, "already a member of this project")
    pm = ProjectMember(project_id=p.id, principal=user_id, role=role, added_by=projects.person(ctx), added_at=now())
    db.add(pm)
    audit(db, ctx, "project_member.added", target=user_id, org_id=p.org_id, detail={"projectId": p.id, "role": role})
    db.flush()
    return project_member_dict(db, pm)


@router.patch("/projects/{project_id}/members/{user_id}")
def patch_project_member(project_id: str, user_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = _manageable(db, ctx, project_id)
    pm = _project_member(db, p.id, user_id)
    role = _project_role(body.get("role"))
    if role != pm.role:
        before, pm.role = pm.role, role
        audit(db, ctx, "project_member.role_changed", target=user_id, org_id=p.org_id, detail={"projectId": p.id, "from": before, "to": role})
        db.flush()
    return project_member_dict(db, pm)


@router.delete("/projects/{project_id}/members/{user_id}", status_code=204)
def delete_project_member(project_id: str, user_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = _manageable(db, ctx, project_id)
    pm = _project_member(db, p.id, user_id)
    db.delete(pm)
    audit(db, ctx, "project_member.removed", target=user_id, org_id=p.org_id, detail={"projectId": p.id, "role": pm.role})
    db.flush()
    return Response(status_code=204)
