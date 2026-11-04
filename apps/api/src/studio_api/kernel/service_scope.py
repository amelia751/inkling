"""Service principals: backend callers other than the worker (todo12 §4 M0 item 5).

`service:pipeline` (apps/pipeline) authenticates with `Authorization: Bearer <token>`, the
token being `<envPrefix>API_PIPELINE_TOKEN` (in dev, `dev-only-pipeline-token` when unset; in
production, unset means the principal doesn't exist). It may call only the routes below:
enqueue a job, read a job it enqueued, read the cross-workspace service event feed, publish
pipeline events, and stage blobs under `pipeline/` (kernel/service_blobs.py). A global dependency (`guard`, installed in app.py) answers 403 for
that token on every other route, as `agent_scope.py` does for agent sessions.

`service:agent` (apps/agent, the service itself, not a run's delegated session token) presents
`<envPrefix>API_AGENT_SERVICE_TOKEN` (dev: `dev-only-agent-service-token` when unset; production:
unset = off). It may only tell the kernel a conversation's title changed (todo21 D7), and claim
and ack the drop milestones as subscriber `agent-drops` (todo28 D7).
"""

from __future__ import annotations

import hmac

from fastapi import HTTPException, Request

from ..config import settings

P = "/api/v1/service"
PIPELINE = "service:pipeline"
DEV_PIPELINE_TOKEN = "dev-only-pipeline-token"
AGENT = "service:agent"
DEV_AGENT_TOKEN = "dev-only-agent-service-token"

SERVICE_ROUTES: dict[str, frozenset[tuple[str, str]]] = {
    PIPELINE: frozenset(
        {
            ("POST", f"{P}/jobs"),
            ("GET", f"{P}/jobs/{{job_id}}"),
            ("GET", f"{P}/events"),
            ("POST", f"{P}/events"),
            ("PUT", f"{P}/blobs/{{key:path}}"),
            ("GET", f"{P}/blobs/{{key:path}}"),
        }
    ),
    AGENT: frozenset(
        {
            ("POST", "/api/v1/projects/{project_id}/conversations/{conversation_id}/title"),
            # todo28 D7: the drop milestones, as subscriber `agent-drops` only (routes/worker.py).
            ("POST", "/api/v1/worker/subscriptions/claim"),
            ("POST", "/api/v1/worker/subscriptions/ack"),
        }
    ),
}


def pipeline_token() -> str | None:
    s = settings()
    return s.pipeline_token or (None if s.production else DEV_PIPELINE_TOKEN)


def agent_token() -> str | None:
    s = settings()
    return s.agent_service_token or (None if s.production else DEV_AGENT_TOKEN)


def principal_of(request: Request) -> str | None:
    """The service principal a request authenticates as, or None."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    given = auth[7:].strip().encode()
    for principal, token in ((PIPELINE, pipeline_token()), (AGENT, agent_token())):
        if token and hmac.compare_digest(given, token.encode()):
            return principal
    return None


def guard(request: Request) -> None:
    """App-wide: a service token reaches only its allowlisted routes."""
    principal = principal_of(request)
    if principal is None:
        return
    route = request.scope.get("route")
    if (request.method.upper(), getattr(route, "path", None)) not in SERVICE_ROUTES.get(principal, frozenset()):
        raise HTTPException(403, f"{principal} can't call this route")


def require(request: Request) -> str:
    """Dependency of the service routes: service principals only."""
    principal = principal_of(request)
    if principal is None:
        raise HTTPException(403 if request.headers.get("Authorization") else 401, "service routes are for service principals only")
    return principal


def require_agent(request: Request) -> str:
    """Dependency of the agent service's kernel routes: `service:agent` only."""
    principal = principal_of(request)
    if principal != AGENT:
        raise HTTPException(403 if request.headers.get("Authorization") else 401, "only the agent service calls this route")
    return principal
