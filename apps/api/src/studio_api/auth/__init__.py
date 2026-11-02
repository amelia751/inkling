"""Accounts on WorkOS (todo9): sign-in, the session cookie, permissions and the org audit log.

    client.py      the AsyncWorkOSClient, built from settings; JWKS and readiness
    cookie.py      the sealed session cookie and the signed sign-in state
    session.py     verify / refresh the session, the `/api/*` middleware, token revocation
    sync.py        the WorkOS Events API sync into the mirror, nightly reconciliation
    bootstrap.py   mirror upserts at sign-in, personal organizations, the org switcher list
    routes.py      /api/auth/{login,callback,session,switch-org,logout,verify}
    permissions.py permission names and `require_permission(perm)` (a FastAPI dependency)
    audit.py       `audit(db, ctx, action, target)`: rows in `audit_events`
    api_keys.py    organization API keys: create/list/revoke, Bearer resolution (`apikey:<id>`)

Later phases plug in here: org routes use `require_permission`, `current_org` and `audit`;
`context._resolve_api_key` calls `api_keys.resolve`; the event sync (`sync.py`) calls `session.revoke_sessions_for`.
"""

from .audit import audit
from .bootstrap import current_org
from .permissions import PERMISSIONS, require_permission

__all__ = ["PERMISSIONS", "audit", "current_org", "require_permission"]
