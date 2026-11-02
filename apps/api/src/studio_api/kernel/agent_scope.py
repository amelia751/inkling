"""Which kernel routes an agent session may call (todo10 §6.3, docs/deployment-gcp.md).

An agent token (principal `agent:*`, minted by `POST /api/v1/sessions`) reaches only the routes
below, whatever scopes it carries: the data-boundary routes (fingerprints, fixtures, verify,
probes, builds, job summaries, filtered annotations), environment and plugin control-plane
routes, and project reads that never return item bytes or free text from files. Everything
else (asset bytes, signed URLs, the raw annotation document, raw job results, file downloads)
answers 403. Adding a route here means updating the list in docs/deployment-gcp.md.

Every JSON answer an agent gets carries screened file and folder names only (todo13 D13): the
app's `agent_names` middleware runs it through `kernel/agent_view.py`.
"""

from __future__ import annotations

from fastapi import HTTPException, Request

P = "/api/v1"
AGENT_ROUTES: frozenset[tuple[str, str]] = frozenset(
    {
        # Data boundary (routes/boundary.py)
        ("POST", f"{P}/boundary/fingerprints"),
        ("POST", f"{P}/boundary/fixtures"),
        ("GET", f"{P}/boundary/fixtures/{{fixture_set_id}}/{{name}}"),
        ("POST", f"{P}/boundary/verify"),
        ("POST", f"{P}/boundary/probes"),
        ("POST", f"{P}/boundary/builds"),
        ("GET", f"{P}/boundary/jobs/{{job_id}}"),
        ("GET", f"{P}/boundary/annotations"),
        ("POST", f"{P}/boundary/annotations/export"),
        # Job start: capabilities through the gateway (responses are summarised for agents)
        ("POST", f"{P}/commands"),
        # Dataset versioning: the kernel confines agents to work/agent-* branches and refuses
        # approve/merge/release for them; contents (document, checkouts, artifacts) stay out.
        ("GET", f"{P}/datasets/{{dataset_id}}"),
        ("GET", f"{P}/datasets/{{dataset_id}}/branches"),
        ("POST", f"{P}/datasets/{{dataset_id}}/branches"),
        ("GET", f"{P}/datasets/{{dataset_id}}/commits"),
        ("POST", f"{P}/datasets/{{dataset_id}}/commits"),
        ("GET", f"{P}/datasets/{{dataset_id}}/commits/{{oid}}"),
        ("GET", f"{P}/datasets/{{dataset_id}}/diff"),
        ("GET", f"{P}/datasets/{{dataset_id}}/reviews"),
        ("POST", f"{P}/datasets/{{dataset_id}}/reviews"),
        ("GET", f"{P}/datasets/{{dataset_id}}/reviews/{{review_id}}"),
        ("POST", f"{P}/datasets/{{dataset_id}}/reviews/{{review_id}}/approve"),
        ("POST", f"{P}/datasets/{{dataset_id}}/reviews/{{review_id}}/merge"),
        ("POST", f"{P}/datasets/{{dataset_id}}/reviews/{{review_id}}/resolutions"),
        ("POST", f"{P}/datasets/{{dataset_id}}/releases"),
        # Environment control plane
        ("GET", "/api/environments/{project_id}"),
        ("PATCH", "/api/environments/{project_id}"),
        ("GET", "/api/environments/{project_id}/history"),
        ("POST", "/api/environments/validate"),
        # Studio definitions (todo10 Phases 1, 2, 4): reads and notes. Moving last-known-good,
        # boot checks and rollback stay person-only; studio commits only onto work/agent-*.
        ("GET", "/api/environments/{project_id}/lockfile"),
        ("GET", "/api/environments/{project_id}/last-known-good"),
        ("GET", "/api/environments/{project_id}/audit"),
        ("PUT", "/api/environments/{project_id}/readme"),
        ("GET", f"{P}/datasets/{{dataset_id}}/studio"),
        ("POST", f"{P}/datasets/{{dataset_id}}/studio/commits"),
        ("GET", "/api/catalog"),
        ("GET", "/api/catalog/schema"),
        ("GET", "/api/catalog/{rest:path}"),
        # Server-side boots (todo11 D1/D2): drafts only, on behalf of a person; publishing a
        # task stays a person's (POST /tasks/{id}/publish is not here, so agents get 403).
        ("POST", f"{P}/projects/{{project_id}}/boots"),
        ("GET", f"{P}/boots/{{boot_id}}"),
        ("GET", f"{P}/tasks/{{task_id}}"),
        # Plugin control plane
        ("GET", f"{P}/plugins"),
        ("GET", f"{P}/plugins/{{plugin_id}}"),
        ("GET", f"{P}/plugins/{{plugin_id}}/docs"),
        ("POST", f"{P}/plugins/artifacts"),  # dry runs only for agents (routes/plugins.py)
        ("GET", f"{P}/workspaces/{{workspace_id}}/state"),
        ("GET", f"{P}/workspaces/{{workspace_id}}/capabilities"),
        ("GET", f"{P}/workspaces/{{workspace_id}}/plugins"),
        ("GET", f"{P}/workspaces/{{workspace_id}}/plugins/requests/{{request_id}}"),
        ("POST", f"{P}/workspaces/{{workspace_id}}/plugins/plan"),
        ("POST", f"{P}/workspaces/{{workspace_id}}/plugins/stage"),
        ("POST", f"{P}/workspaces/{{workspace_id}}/plugins/activate"),
        ("POST", f"{P}/workspaces/{{workspace_id}}/plugins/configure"),
        ("POST", f"{P}/workspaces/{{workspace_id}}/plugins/disable"),
        ("POST", f"{P}/workspaces/{{workspace_id}}/plugins/rollback"),
        # Asset metadata (ids, paths, media types, sizes; never bytes)
        ("GET", f"{P}/assets"),
        # Project reads and proposals (names, kinds, counts, inspection facts; no contents)
        ("GET", f"{P}/projects/{{project_id}}"),
        ("GET", f"{P}/projects/{{project_id}}/overview"),
        # Org settings (todo15 D2): the agent refuses runs when `aiAssist` is off.
        ("GET", f"{P}/org"),
        ("GET", f"{P}/projects/{{project_id}}/sources"),
        ("GET", f"{P}/projects/{{project_id}}/proposals"),
        ("POST", f"{P}/projects/{{project_id}}/proposals"),
        ("GET", f"{P}/projects/{{project_id}}/review"),
        ("GET", f"{P}/projects/{{project_id}}/search"),
        ("GET", f"{P}/projects/{{project_id}}/fs"),
        ("GET", f"{P}/projects/{{project_id}}/fs/children"),
        ("GET", f"{P}/projects/{{project_id}}/imports"),
        ("GET", f"{P}/sources/{{source_id}}/children"),
        ("GET", f"{P}/source-nodes/{{node_id}}"),
        ("GET", f"{P}/source-nodes/{{node_id}}/activity"),  # agent view: no original names
        ("GET", f"{P}/proposals/{{proposal_id}}"),
        ("POST", f"{P}/proposals/{{proposal_id}}/confirm"),  # the kernel refuses agents (403) itself
        # Drops (todo13 D3): the agent's view is a DropSummary (ids, screened names, kinds, facts)
        ("GET", f"{P}/drops/{{drop_id}}"),
        # todo13 M2: drop plans (apply only D6-safe ones, never undo), dataset structure (writes
        # go to the agent's own work/agent-* branch), a dataset's collections. Kinds, counts,
        # node ids and generic collection names; never file names.
        ("GET", f"{P}/drops/{{drop_id}}/plan"),
        ("PUT", f"{P}/drops/{{drop_id}}/plan"),
        ("POST", f"{P}/drops/{{drop_id}}/apply"),
        ("GET", f"{P}/datasets/{{dataset_id}}/structure"),
        ("PUT", f"{P}/datasets/{{dataset_id}}/structure"),
        ("GET", f"{P}/projects/{{project_id}}/datasets/{{dataset_id}}/collections"),
    }
)


def is_agent(principal: str) -> bool:
    return principal.startswith("agent:")


def check(request: Request, principal: str) -> None:
    if not is_agent(principal):
        return
    route = request.scope.get("route")
    path = getattr(route, "path", None)
    if (request.method.upper(), path) not in AGENT_ROUTES:
        raise HTTPException(403, "agent sessions can't call this route (the data boundary: docs/deployment-gcp.md)")
