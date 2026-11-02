"""Invitation acceptance (todo9 Phase 6): project roles promised in an invitation become real.

An invitation may carry project grants (`pending_project_grants`, keyed by the invitation id:
the WorkOS id in workos mode, `inv_…` in dev). When the invitation is accepted, each grant turns
into a `project_members` row for the person who accepted it. Called from:

- the sign-in callback, when a person signs in to an organization that holds a pending
  invitation for their email (`accept_for_email`): hosted AuthKit accepts the invitation and
  the first session in that organization arrives at our callback;
- `GET /v1/org/invitations`, when WorkOS reports an invitation accepted (`accepted_user_id`);
- the event sync (Phase 7) on `invitation.accepted`: `apply_accepted_invitation(db, id, principal)`.

Idempotent: grants are deleted once applied, and an existing project role is never downgraded
by a replay.
"""

from __future__ import annotations

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..models import OrgInvitation, PendingProjectGrant, ProjectMember, ProjectRow, now
from .audit import record_event

INVITATION_ACCEPTED = "invitation.accepted"
PROJECT_MEMBER_ADDED = "project_member.added"


def find_invitation(db: Session, invitation_id: str) -> OrgInvitation | None:
    """By our id or the WorkOS id (they're the same in workos mode, but events only know WorkOS's)."""
    return db.get(OrgInvitation, invitation_id) or db.scalar(select(OrgInvitation).where(OrgInvitation.workos_invitation_id == invitation_id))


def apply_accepted_invitation(db: Session, invitation_id: str, principal: str) -> int:
    """Mark the invitation accepted and turn its pending project grants into `project_members`
    rows for `principal`. Returns how many project roles were added. Unknown ids do nothing."""
    inv = find_invitation(db, invitation_id)
    grant_key = inv.id if inv is not None else invitation_id
    grants = list(db.scalars(select(PendingProjectGrant).where(PendingProjectGrant.invitation_id == grant_key)))
    org_id = inv.org_id if inv is not None else None
    if inv is not None and inv.state != "accepted":
        inv.state = "accepted"
        record_event(db, org_id=org_id, actor=principal, action=INVITATION_ACCEPTED, target=inv.id)
    added = 0
    for g in grants:
        p = db.get(ProjectRow, g.project_id)
        if p is None or (org_id is not None and p.org_id != org_id):
            continue  # the project is gone, or moved: the promise lapses
        if db.get(ProjectMember, (g.project_id, principal)) is None:
            db.add(ProjectMember(project_id=g.project_id, principal=principal, role=g.role, added_by=g.added_by, added_at=now()))
            record_event(db, org_id=p.org_id, actor=g.added_by or principal, action=PROJECT_MEMBER_ADDED, target=principal, detail={"projectId": g.project_id, "role": g.role, "invitationId": grant_key})
            added += 1
    if grants:
        db.execute(delete(PendingProjectGrant).where(PendingProjectGrant.invitation_id == grant_key))
    db.flush()
    return added


def accept_for_email(db: Session, org_id: str, principal: str, email: str) -> int:
    """A person is now an active member of `org_id`: every pending invitation there for their
    email counts as accepted. Returns how many project roles were added."""
    email = (email or "").strip().lower()
    if not email:
        return 0
    ids = list(db.scalars(select(OrgInvitation.id).where(OrgInvitation.org_id == org_id, OrgInvitation.email == email, OrgInvitation.state == "pending")))
    return sum(apply_accepted_invitation(db, i, principal) for i in ids)
