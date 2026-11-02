"""Organization permissions (todo9 D5) and the route guard.

Code checks permissions, never role slugs: custom per-org roles get unpredictable slugs. A
signed-in person's permissions come from the WorkOS access token; an agent token's are its
minter's AND its own scopes; a dev identity has them all (`RequestContext.can`).
"""

from __future__ import annotations

from collections.abc import Callable

from fastapi import Depends, HTTPException

from ..context import RequestContext, get_context

ORG_MANAGE = "org:manage"
MEMBERS_MANAGE = "members:manage"
BILLING_MANAGE = "billing:manage"
APIKEYS_MANAGE = "apikeys:manage"
AUDIT_READ = "audit:read"
PROJECT_CREATE = "project:create"

# Every permission a dev identity holds (`GET /api/auth/session` in dev mode lists these).
PERMISSIONS: tuple[str, ...] = (ORG_MANAGE, MEMBERS_MANAGE, BILLING_MANAGE, APIKEYS_MANAGE, AUDIT_READ, PROJECT_CREATE)


def require_permission(permission: str) -> Callable[..., RequestContext]:
    """A FastAPI dependency: the request context, or 403 without `permission`.

        @router.patch("/v1/org", dependencies=[Depends(require_permission(ORG_MANAGE))])
        def patch_org(ctx: RequestContext = Depends(require_permission(ORG_MANAGE))): ...
    """

    def dependency(ctx: RequestContext = Depends(get_context)) -> RequestContext:
        if not ctx.can(permission):
            raise HTTPException(403, f"you need the {permission} permission for this")
        return ctx

    dependency.__name__ = f"require_{permission.replace(':', '_')}"
    return dependency
