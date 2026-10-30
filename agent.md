# Inkling Agent Runtime — Architecture & Integration Specification

**Status:** proposed implementation specification  
**Last reviewed:** 2026-10-29  
**Owner:** Inkling engineering  
**Scope:** `apps/agent` and its integration with `apps/web`, `apps/api`, `apps/worker`, and external providers  
**Technology:** Python, Pydantic AI + Pydantic AI Harness, FastAPI, PostgreSQL, uv; Daytona initially, Temporal optionally

> This document is a design and implementation guide, **not a claim that its components already exist**. It distinguishes documented vendor capabilities from Inkling code to build. Pydantic AI Harness is currently 0.x; pin tested dependency versions and validate examples against the installed version before deployment. Official source: https://pydantic.dev/docs/ai/harness/.

## 1. Product goals and non-goals

Inkling is a collaborative, no-code data studio. Its embedded agent must be able to **reason, research, write code, execute that code in isolated sandboxes, inspect artifacts, and orchestrate pipelines**, while operating on authorized datasets and supporting ordinary knowledge questions. It is not exclusively a coding assistant.

**Initial goals**

1. Provide an in-product chat and execution experience backed by a Pydantic AI agent.
2. Inspect datasets, schemas, counts, metadata, images, and annotations via typed, tenant-scoped tools.
3. Write/debug Python, SQL, and transformation scripts within isolated workspaces.
4. Search external documentation and research sources when enabled.
5. Start and monitor deterministic ingestion, export, preprocessing, and training jobs.
6. Stream user-visible progress, tool status, approval requests, links to artifacts, and errors.
7. Resume conversations and, when appropriate, reconnect to a persistent sandbox.
8. Enforce permissions, budgets, auditability, data minimization, and explicit approval for sensitive actions.
9. Support model and vendor portability; keep external integrations behind adapters.

**Non-goals for the agent runtime:** do not build a second database/permissions system, an annotation UI, a medical imaging engine, a GPU training orchestrator, or a general-purpose Kubernetes operator inside the harness. The API/domain services own business rules; workers/workflow engines own durable pipelines; sandboxes execute untrusted programs.

## 2. Architecture decision

### 2.1 Recommended boundaries

```text
apps/web (React + Vite)
    | HTTPS: auth, datasets, chat session, SSE/WS event feed
    v
apps/api (FastAPI, PUBLIC boundary)
    | validate user, project, permissions, tenancy, rate limits
    | persist sessions/runs; enqueue run or call private agent endpoint
    v
apps/agent (Python, PRIVATE service / independently deployable package)
    | Pydantic AI + Harness; planner/coder/researcher; tools; approvals
    |-- internal API client --> apps/api (authorized dataset/annotation operations)
    |-- sandbox adapter -----> Daytona / E2B / Modal / Docker
    |-- search/browse --------> Exa / provider web search / Browser Use
    |-- pipeline tool -------> API / Temporal / job queue --> apps/worker
    |-- telemetry -----------> OTLP / Logfire
    `-- events -------------> API event broker/store --> apps/web

apps/worker: deterministic ingest, validation, de-identification checks,
             conversions, previews, exports, ML jobs (later)
PostgreSQL: tenant-scoped app records, agent sessions/runs, tool audit, job IDs
Object storage: immutable dataset versions, sandbox artifact exports
```

**Architectural rule:** `apps/agent` is a source-code and deployment boundary, not a requirement to run a separate service from day one. In development it may run in-process or as a separate localhost application. Do not make the browser call it directly. The public API is the authority for tenant and project access.

### 2.2 Ownership matrix

| Concern | Owner | Agent behavior |
|---|---|---|
| Login, accounts, organizations, project authorization | `apps/api` | Receives scoped identity; never accepts trusted tenant IDs from the model |
| Dataset metadata, versions, annotations, studies | `apps/api` domain modules | Calls typed, permission-checked internal endpoints |
| Multi-step reasoning and tool selection | `apps/agent` | Owns Pydantic AI loop |
| Temporary code/files/process execution | Sandbox provider | Agent controls it via limited workspace adapter |
| Ingest, transforms, export, training, retries | `apps/worker` + queue/Temporal | Agent submits a job; does not own its lifecycle |
| Search/browser external actions | Agent adapters | Controlled by feature flags, policies and budgets |
| Session/run/event persistence | API/Postgres plus event channel | Agent emits canonical events, API persists/exposes them |
| Artifact publishing | API/object storage | Explicit validated publish operation, not direct sandbox write |
| Observability | Shared OTLP/Logfire | Consistent trace IDs through every service |

## 3. Monorepo layout

Preserve the existing folders and add `apps/agent`, a small `packages/py-common`, and agent-facing UI/API modules. Python source packages use `src/` layout; do not put all agent logic under `/api`.

```text
inkling/
├── agent.md                         # THIS specification
├── README.md
├── pnpm-workspace.yaml
├── package.json
├── pyproject.toml                   # optional root uv workspace
├── uv.lock                         # one lock if using uv workspace
├── .env.example                     # no actual secrets
├── apps/
│   ├── web/                         # EXISTING React + Vite
│   │   └── src/
│   │       ├── features/
│   │       │   ├── agents/
│   │       │   │   ├── api.ts        # typed agent-session API client
│   │       │   │   ├── hooks/        # session, event feed, approve/resume
│   │       │   │   ├── components/   # chat, tool timeline, approvals, artifacts
│   │       │   │   └── types.ts
│   │       │   └── pipelines/        # status, retry, result viewer
│   │       └── lib/api/
│   ├── api/                         # EXISTING Python public/API boundary
│   │   └── app/
│   │       ├── modules/
│   │       │   ├── agent_sessions/
│   │       │   │   ├── router.py
│   │       │   │   ├── service.py
│   │       │   │   ├── schemas.py
│   │       │   │   └── repository.py
│   │       │   └── pipelines/        # start/status/cancel + job policies
│   │       └── integrations/agent_client.py
│   ├── agent/                       # NEW deployable Python package
│   │   ├── pyproject.toml
│   │   ├── Dockerfile
│   │   ├── .env.example
│   │   ├── README.md
│   │   ├── src/inkling_agent/
│   │   │   ├── __init__.py
│   │   │   ├── main.py               # private FastAPI health/run routes
│   │   │   ├── settings.py           # typed env config
│   │   │   ├── agents/
│   │   │   │   ├── factory.py        # build_agent(profile, policy)
│   │   │   │   ├── profiles.py       # general / coding / research
│   │   │   │   └── instructions.py
│   │   │   ├── capabilities/
│   │   │   │   ├── catalog.py        # declarative enabled capabilities
│   │   │   │   ├── policies.py       # budget, guardrail, approval assembly
│   │   │   │   └── memory.py
│   │   │   ├── tools/
│   │   │   │   ├── datasets.py
│   │   │   │   ├── annotations.py
│   │   │   │   ├── assets.py
│   │   │   │   ├── pipelines.py
│   │   │   │   ├── training.py
│   │   │   │   └── registry.py
│   │   │   ├── integrations/
│   │   │   │   ├── api_client.py     # scoped API machine-client
│   │   │   │   ├── daytona.py
│   │   │   │   ├── search.py         # Exa / provider search
│   │   │   │   ├── browser.py        # opt-in browser provider
│   │   │   │   ├── mcp.py
│   │   │   │   └── events.py
│   │   │   ├── runtime/
│   │   │   │   ├── runner.py         # run/resume/cancel dispatch
│   │   │   │   ├── sessions.py       # history and sandbox refs
│   │   │   │   ├── event_mapper.py   # Pydantic events -> Inkling events
│   │   │   │   ├── approvals.py
│   │   │   │   ├── artifacts.py
│   │   │   │   └── lifecycle.py     # timeout/cleanup/reconciliation
│   │   │   ├── prompts/
│   │   │   │   ├── base.md
│   │   │   │   ├── coding.md
│   │   │   │   └── research.md
│   │   │   └── skills/
│   │   │       ├── dataset-profiling/SKILL.md
│   │   │       ├── image-qc/SKILL.md
│   │   │       ├── pipeline-debugging/SKILL.md
│   │   │       └── research-synthesis/SKILL.md
│   │   └── tests/
│   │       ├── unit/
│   │       ├── integration/
│   │       ├── security/
│   │       └── evals/
│   └── worker/                      # EXISTING deterministic jobs
│       ├── jobs/
│       │   ├── ingest.py
│       │   ├── conversion.py
│       │   ├── validate.py
│       │   └── training.py          # future
│       └── imaging/
├── packages/
│   ├── contracts/                   # existing TS types/generated client
│   ├── design-system/               # optional
│   └── py-common/                   # NEW lean Python contracts, not domain DB
│       └── src/inkling_common/
│           ├── schemas/{agents,datasets,jobs}.py
│           ├── events/agent.py
│           └── clients/internal_api.py
├── infra/
│   ├── docker-compose.yml
│   ├── agent/
│   │   ├── sandbox-images/          # pinned execution images
│   │   └── security-policies/
│   └── deploy/
├── docs/architecture/agent-runtime.md
├── fixtures/agent-evals/
└── scripts/
    ├── agent_smoke.py
    └── agent_eval.py
```

**Don't duplicate:** generic Pydantic integration adapters from upstream, domain validation rules from `api`, or reproducible ETL tasks from `worker`. `agents/` = agent identities/policies; `tools/` = operations; `integrations/` = vendor adapters; `runtime/` = lifecycle; `skills/` = on-demand procedural instructions; `prompts/` = system instructions.

## 4. Pydantic AI Harness capability inventory

Features below are **available in Pydantic AI Core/Harness**, but not all automatically active. Installing the package does not provision cloud accounts, API keys, sandbox security, or a durable job engine. Consult the live capability catalog and installed-version API for exact names/arguments: https://pydantic.dev/docs/ai/harness/ and https://pydantic.dev/docs/ai/capabilities/overview/.

| Group | Notable capabilities | Inkling adoption |
|---|---|---|
| Complete agents | **Coder**, Researcher | Coder first; researcher capability/profile later |
| File/code execution | FileSystem, Shell, RepoContext, SmartSearch, local workspace | Coder in isolated workspace |
| Sandboxes | **Daytona**, Docker/Podman, E2B, Modal, Sprites, BoxLite, Smol, Bubblewrap, SSH | Daytona default; Docker dev-only; compare others |
| Orchestration | Planning, SubAgents, DynamicWorkflow, BackgroundTools, Advisor | Start with Coder delegation; add only if evaluated |
| Research | WebSearch, WebFetch, ExaSearch, ExaAgent, You.com search/research, X search | Exa opt-in; provider search alternative |
| Browser | Browser Use, Playwright Browser | Disabled by default; strict isolated sessions |
| Context | ToolSearch, Caching, provider/native Compaction, harness Compaction, ClearToolResults, ToolOutputLimits, CodeMode, IPythonCodeMode, cache diagnostics | Tool result limits and compaction early |
| Knowledge | Skills (`SKILL.md`), Memory, ConversationSearch, repo instructions | Versioned Inkling skills; scoped memory after review |
| Guarding | tool approvals/deferred calls, Guardrails, PromptInjectionDefender, ToolCallJudge, ApprovalReviewer, SpendLimits, AskUser, SystemReminders, DetectLoops, TrajectoryJudge, argument repair | hard backend auth + approvals + budgets |
| Durability | Temporal, DBOS, Prefect, Restate, Airflow, AWS Lambda durability, pgtask/Absurd, Render workflows, StepPersistence | queue first, Temporal when warranted |
| Interfaces | Pydantic CLI, web UI, AG-UI, Vercel AI adapter, experimental ACP, MCP tools, voice | Inkling's own API + SSE event contract |
| Monitoring | OpenTelemetry, Logfire, managed prompts, usage/spend tracking | OTLP tracing with redaction |
| Extensibility | Python typed tools, MCP clients/servers, dynamic tool catalog, capability creation | internal tool registry; generated tools only after review |
| Provider support | OpenAI, Anthropic, Gemini, Bedrock, Vertex, Ollama, OpenRouter, etc. | model config via environment; no provider lock-in |

### 4.1 Recommended initial profile (`general_coder`)

- One general agent with `Coder()` in a sandbox; it can code and answer general questions.
- Add `ExaSearch()` only when a search key is configured and external research is allowed.
- Add built-in dataset/annotation/pipeline tools through typed Pydantic AI tool functions.
- Keep `Researcher`, Browser Use, DynamicWorkflow, persistent memory, tool creation, and arbitrary third-party MCP disabled at first; enable individually after testing.
- `Coder` provides file/shell tools, repository context, delegation, context controls; **shell is unrestricted by default**. Never point it at the API container or a tenant-unscoped mounted filesystem.
- A shell sandbox is not an authorization boundary for `api` tools. Every internal tool separately checks user/tenant/project scope.

### 4.2 Capability selection policy

Capability profiles are *host-owned configuration*, not model-editable user prompts. A user message asking to enable arbitrary shell/network/MCP access is never sufficient. Evaluate profiles for cost, latency, privileges, and benchmark performance. Keep separate high-trust internal maintenance agents away from customer-facing agents.

## 5. External provider integration matrix

| Provider | Role | Support / integration | Launch posture |
|---|---|---|---|
| **Daytona** | persistent isolated code workspace | documented Harness `DaytonaSandbox` | preferred managed sandbox |
| Docker / Podman | local container sandbox | Harness `DockerSandbox` | development and optionally self-hosted production after security review |
| E2B | ephemeral cloud workspace | Harness `E2BSandbox` | sandbox alternative |
| Modal | sandbox / compute | Harness `ModalSandbox` | alternative, not automatically GPU training engine |
| BoxLite / smolvm | local microVM | Harness adapters | potential self-hosting path |
| **Exa** | web search/page retrieval | `ExaSearch`, `ExaAgent` | default research provider when enabled |
| Provider WebSearch / WebFetch | search and fetch | Pydantic AI Core | provider-dependent option |
| You.com | search and research | Harness integrations | optional |
| Tavily | web search | core tool/common-tools wrapper; verify installed API | optional adapter |
| Firecrawl | structured web extraction | custom tool / vetted MCP | optional, not native Harness capability |
| Browser Use | autonomous browser | Harness integration | disabled until browser security designed |
| Playwright | direct browser control | Harness integration | tasks needing deterministic browser tooling |
| Composio | SaaS actions | custom integration/toolset/MCP where supported | opt-in, per-account OAuth and allowlists |
| MCP servers | arbitrary external tools | Core MCP capability | only vetted/registered servers |
| Temporal | durable jobs/agent workflows | Pydantic durable integration | production scaling phase |
| Logfire / OTLP | observability | Pydantic instrumentation | recommended from first integration test |

Do not assume provider SDKs, OAuth, search credits, web permissions, or sandbox images ship inside Pydantic. Avoid exposing tokens to the model or shell environment; use server-owned integrations and narrow credentials.

## 6. Local bootstrapping: step by step

### 6.1 Prerequisites

- Python compatible with the *pinned* Pydantic AI/Harness release; uv installed.
- Existing Postgres, API and worker configured via the project's normal dev bootstrap.
- At least one model-provider key; for the examples use Anthropic.
- Daytona API key for managed sandbox testing **or** a reviewed local Docker sandbox.
- Exa key only if enabling web research.
- Keep sensitive datasets out of the smoke-test workspace; use synthetic fixtures.

### 6.2 Create the Python workspace package

**Option A — root uv workspace (preferred if the API/worker already use uv):** configure root `pyproject.toml` with `tool.uv.workspace.members = ["apps/api", "apps/agent", "apps/worker", "packages/py-common"]` and ensure each member is a Python project. Use one root `uv.lock` and `uv sync --package inkling-agent` when names match. Make the migration separately if your existing API/worker projects are not uv-packaged; do not silently replace their build files.

**Option B — standalone agent project (least disruptive):** from repo root:

```bash
mkdir -p apps/agent/src/inkling_agent apps/agent/tests
cd apps/agent
uv init --lib --name inkling-agent  # skip if pyproject.toml already exists
uv add 'pydantic-ai-harness[coder,daytona,anthropic,exa,skills]' \
       fastapi 'uvicorn[standard]' pydantic-settings httpx
uv add --dev pytest pytest-asyncio ruff
```

`uv init` may create starter paths; reconcile them with the `src/` structure. Lock and commit the resolved versions (`uv.lock` in standalone mode). Start with an explicit `pyproject.toml` package name of `inkling-agent`; verify import with `uv run python -c "import inkling_agent"`.

**Do not** run `uv sync` or `uv add` against production until reviewing the lockfile and transitive packages.

### 6.3 Environment template

Create `apps/agent/.env.example` (secrets stored in secret manager or local ignored `.env`):

```dotenv
APP_ENV=development
AGENT_MODEL=anthropic:claude-sonnet-5-5
ANTHROPIC_API_KEY=
DAYTONA_API_KEY=
EXA_API_KEY=
AGENT_SEARCH_ENABLED=false
AGENT_BROWSER_ENABLED=false
AGENT_SANDBOX_PROVIDER=daytona
AGENT_MAX_CONCURRENT_RUNS=2
AGENT_MAX_RUN_SECONDS=900
AGENT_MAX_TOOL_CALLS=80
AGENT_MAX_SPEND_USD=2.00
INTERNAL_API_BASE_URL=http://localhost:8000
INTERNAL_AGENT_SERVICE_TOKEN=
AGENT_EVENT_BROKER_URL=
OTEL_EXPORTER_OTLP_ENDPOINT=
```

These `AGENT_*` names are **Inkling-proposed configuration**, not Pydantic environment variables; implement them in `settings.py`. Provider SDK keys are provider-defined. Never commit `.env`.

### 6.4 Verified minimal smoke script

A minimal standalone test proves Pydantic agent + Daytona workspace + Coder works before adding Inkling modules. This is *based on the current official Daytona and Coder examples*:

```python
# scripts/agent_smoke.py (or apps/agent/scripts/smoke.py)
import os
from pydantic_ai import Agent
from pydantic_ai_harness.coder import Coder
from pydantic_ai_harness.daytona_sandbox import DaytonaSandbox

agent = Agent(
    os.environ["AGENT_MODEL"],
    capabilities=[DaytonaSandbox(), Coder(repo_context=False)],
)

result = agent.run_sync(
    "In the sandbox, create hello.py printing 'inkling-ok', "
    "run it, and report its stdout."
)
print(result.output)

# IMPORTANT: production owns sandbox references, retention and cleanup.
# Do not launch repeated smoke runs without deleting or reusing sandboxes.
```

```bash
cd apps/agent
uv run python scripts/agent_smoke.py
```

For this exact command, ensure the file exists at `apps/agent/scripts/agent_smoke.py`; if you instead place it at repo-root `scripts/agent_smoke.py`, invoke that path explicitly (e.g. `uv run python ../../scripts/agent_smoke.py`). The code assumes `AGENT_MODEL`, provider key, and Daytona key are exported or loaded by your shell. **No existing production data should be attached.**

### 6.5 Add web search deliberately

```python
from pydantic_ai import Agent
from pydantic_ai_harness import ExaSearch

research_agent = Agent(
    "anthropic:claude-sonnet-5-5",
    capabilities=[ExaSearch()],
)
```

`ExaSearch` is documented with `pydantic-ai-harness[exa]` and `EXA_API_KEY`. Configure result limits and per-run budgets; treat retrieved web content as untrusted. Avoid relying on citations generated solely by a model when source URLs are required.

### 6.6 Run the private service

Start with a tiny FastAPI service with `/health/live` and `/health/ready`; health checks must not instantiate a Daytona sandbox or contact the model. Implement private run creation later. Example shell after `main.py` exists:

```bash
cd apps/agent
uv run uvicorn inkling_agent.main:app --host 127.0.0.1 --port 8100 --reload
```

`127.0.0.1` is suitable locally. In Docker/Kubernetes, bind to `0.0.0.0` only behind a private network, service auth, and ingress restrictions. Do **not** expose `8100` publicly.

### 6.7 Startup order

1. Start database/object-store/queue from `infra/docker-compose.yml` as applicable.
2. Run API migrations, boot `apps/api` and `apps/worker`.
3. Export agent keys in the agent's own environment, start `apps/agent`.
4. Confirm API-to-agent service authentication and readiness.
5. Smoke test a synthetic dataset request, then a Daytona code-execution request.
6. Boot `apps/web`; verify chat event timeline and approval UI.
7. Verify sandbox cleanup, cancel, retries, and no cross-tenant data access.

Docker Compose services should use the private service name (`http://agent:8100`) instead of `localhost`. The public API must be the sole exposed entry point.

## 7. Suggested package bootstrap and factories

### 7.1 `settings.py`

Use `pydantic_settings.BaseSettings` for Inkling's application configuration. Required secrets must fail closed in production. Add model/sandbox allowlists, concurrency, run deadlines, budgets, and feature flags. Treat `.env` loading as local development only.

### 7.2 `agents/factory.py`

Prefer a **pure construction function** that assembles capabilities from an immutable, server-validated profile. Avoid global mutable agent sessions and avoid passing raw user input as provider config. The following is a verified *composition shape*, but additional services and permissions are pseudocode until implemented:

```python
# src/inkling_agent/agents/factory.py
from pydantic_ai import Agent
from pydantic_ai_harness.coder import Coder
from pydantic_ai_harness.daytona_sandbox import DaytonaSandbox
from pydantic_ai_harness import ExaSearch


def build_agent(model: str, *, allow_search: bool = False) -> Agent:
    capabilities = [
        DaytonaSandbox(),
        Coder(repo_context=False),
    ]
    if allow_search:
        capabilities.append(ExaSearch())
    return Agent(model, capabilities=capabilities)
```

**Important:** a `Coder` configuration and additional `ExaSearch` instance may need tested tool-name compatibility when combined with other profiles. On a per-session run pass the known workspace reference to `agent.run(..., workspace=ref)` or message history as appropriate. An initial run without either creates a new sandbox. Store references and explicit cleanup status in the API database.

### 7.3 Application tools

Agent application tools should invoke **authorized API endpoints or a domain service facade**, not direct SQL writes. Representative contract:

```python
# Illustrative Inkling contract, not a Pydantic library API
class DatasetQuery(BaseModel):
    project_id: UUID
    dataset_id: UUID
    limit: int = Field(default=50, ge=1, le=500)

class DatasetSummary(BaseModel):
    dataset_id: UUID
    asset_count: int
    modality: str | None
    version_id: UUID

# tools/datasets.py:
# async def inspect_dataset(ctx, query: DatasetQuery) -> DatasetSummary:
#    identity = ctx.deps.authorized_identity   # host-supplied, not model-supplied
#    return await internal_api.inspect_dataset(identity, query)
```

Design each operation with structured input/output models and bounded response sizes. Use a server-derived principal (user, tenant, project, scopes), an internal service credential, and object-level authorization. The model must never be allowed to choose a different tenant by changing a tool parameter. Avoid exposing raw table/database connectors to customer agents.

### 7.4 Skills

Create `skills/dataset-profiling/SKILL.md`:

```markdown
---
name: dataset-profiling
description: Inspect a dataset's schema, quality, duplicates, and label distribution before writing a transformation.
---
Use authorized dataset inspection tools first. Summarize uncertainty.
Prefer read-only actions. Before modifying or publishing data, request approval.
Never copy raw sensitive records into a web search or model response.
```

**Gotcha:** Skills requires a library path, not an individual `SKILL.md`. If skills are bundled with the *agent host* while the active workspace is Daytona, use a host-side `LocalWorkspaceBackend` as documented; otherwise copy approved skills into the workspace. `Skills` only loads instructions and points at files; it does not execute bundled scripts itself. Treat skills as **untrusted instructions if user-uploaded**, and separately enforce permissions at the tool layer.

## 8. Session, run, and sandbox lifecycle

### 8.1 Storage schema (proposed)

- `agent_sessions`: `id`, `org_id`, `project_id`, `created_by`, `profile`, `created_at`, `updated_at`, `state`.
- `agent_messages`: `id`, `session_id`, `role`, `content_ref/redacted_content`, `created_at`, `sequence`.
- `agent_runs`: `id`, `session_id`, `status`, `model`, `sandbox_ref`, `started_at`, `ended_at`, `cost_usd`, `trace_id`, `error_code`, `idempotency_key`.
- `agent_events`: `run_id`, `seq`, `type`, `timestamp`, `public_payload_ref` (ordered, replayable).
- `agent_tool_calls`: `run_id`, `call_id`, `tool_name`, `policy_decision`, `status`, `timing`, `sanitized_args_hash`.
- `agent_approvals`: `approval_id`, `run_id`, `tool_call_id`, `actor`, `decision`, `expires_at`, `created_at`.
- `agent_workspaces`: `ref`, `provider`, `org_id`, `project_id`, `session_id`, `state`, `expires_at`, `last_used_at`, `destroyed_at`.
- `pipeline_jobs`: host-owned id/tenant/state/idempotency key; agent stores only a reference.

Prefer workspace reference serialization using the installed SDK's documented format; avoid flattening an opaque reference into an assumed ID. Store ownership and reference separately. Encrypt sensitive metadata; respect retention and deletion policies.

### 8.2 State machines

`run: queued -> running -> (awaiting_approval | cancelling | completed | failed | expired)`; `awaiting_approval -> running | rejected | expired`. Every transition is versioned/atomic, idempotent, and checked against current state. `sandbox: requested -> ready -> stopped -> destroyed`; run completion does not equal sandbox deletion.

### 8.3 Daytona specifics

- `DaytonaSandbox` starts a new sandbox on first use and can reattach via `result.workspace.ref` or an explicit `workspace=ref`.
- A follow-up using complete message history can reuse its sandbox; a follow-up without reference/history typically creates a new sandbox.
- `Coder` repository context may create a sandbox at run start; `Coder(repo_context=False)` allows lazy provisioning.
- Ending a run **does not automatically delete** Daytona sandboxes. Idle stop is not deletion; disk and billing may persist. Implement a sweeper for expired/inactive sandboxes, destroy by verified owned reference, log every deletion, and test stopped/deleted-reference behavior.
- Command cancellation/timeouts may not prove the underlying process is dead until verified by provider. On uncertain process state, quarantine or destroy the workspace.
- Use custom snapshots for deterministic dependencies; never include production credentials or secrets in images.
- Avoid assuming `allow_internet_access=False` provides complete network isolation without verifying Daytona plan/policy capabilities.

### 8.4 Run cancellation and user resumption

- User cancellation stops scheduling new tool calls and requests cancellation of active work; then verifies/scrubs the sandbox.
- Agent run cancellation must **not** automatically cancel a separately accepted, durable pipeline job unless user explicitly requests that job cancellation.
- Persist message history and job references with a pinned model/profile version; distinguish resume conversation, resume agent workflow, and reattach sandbox—they are not the same operation.
- Configure idle TTL, maximum lifetime, maximum parallel workspaces, and organization-specific quotas.

## 9. Public API and event contract (Inkling-owned)

**Do not rely on an SDK's built-in web UI protocol for persistent cloud sandbox sessions.** The Coder documentation notes `to_web()` may start a new remote sandbox on each message because its protocol doesn't carry the workspace ref. Use Inkling-owned session IDs and store workspace refs server-side.

Suggested API routes (all protected by existing auth):

```http
POST   /api/v1/agent/sessions
GET    /api/v1/agent/sessions/{id}
POST   /api/v1/agent/sessions/{id}/messages
GET    /api/v1/agent/runs/{run_id}
GET    /api/v1/agent/runs/{run_id}/events?after={seq}
POST   /api/v1/agent/runs/{run_id}/cancel
POST   /api/v1/agent/approvals/{approval_id}/decision
GET    /api/v1/agent/sessions/{id}/artifacts
```

Return `202 Accepted` + `run_id` when queueing a run. Prefer SSE for **server-to-client** progress with monotonically increasing sequence numbers and resume (`Last-Event-ID` or explicit `after`); commands/approvals go via ordinary authenticated POST. Consider WebSockets only when necessary. The event feed is a controlled projection, **not** raw chain-of-thought or provider SDK dumps.

Suggested canonical public event types:

```text
run.queued, run.started, run.completed, run.failed, run.cancelled
message.delta, message.completed
tool.started, tool.progress, tool.completed, tool.failed
approval.requested, approval.resolved
sandbox.creating, sandbox.ready, sandbox.stopped
job.submitted, job.progress, job.completed, job.failed
artifact.created, artifact.published
usage.updated
```

Every public event: `schema_version`, `id`, `run_id`, `session_id`, `seq`, `timestamp`, `type`, and a **sanitized** `payload`. Do not stream tool bearer tokens, private URLs, secret values, uncontrolled shell logs, or raw protected image contents. API verifies session membership for both event subscription and approval submission. Replay should be idempotent in the UI.

### 9.1 Example interaction

1. User says: “Find bad-quality chest radiographs, generate a cleaning script, run it, and prepare the dataset for model training.”
2. API creates a run with project- and dataset-scoped principal.
3. Agent inspects summary via `inspect_dataset` (read-only) and retrieves allowed fixtures into a sandbox using short-lived, limited download credentials (or a server-managed transfer).
4. Agent writes/runs scripts in Daytona; result files stay in temporary workspace.
5. Agent proposes a new immutable dataset version; host validates file schema/counts/metadata, runs de-identification and safety checks.
6. User approves publishing changes; API commits versioned artifacts and audit logs.
7. Agent submits a training pipeline with a validated typed plan; worker executes under its own identity.
8. UI follows separate run and pipeline statuses. On timeout, the durable job continues and can be looked up by ID.

## 10. Security and privacy — non-negotiable

**Trust boundaries:** user prompt and uploaded data are untrusted; retrieved web and MCP responses are untrusted; generated code is untrusted; sandbox filesystem is untrusted; all agent tool arguments are untrusted; validated server-derived identity and API domain rules are authoritative.

- **Tenant isolation:** never use the agent as a path around API authorization. Scope every call using server-verified org/project membership and object-level ACLs. Deny cross-tenant reads/writes even if the agent supplies a valid ID.
- **Sandbox:** remote isolation; non-root execution where supported; drop privileges; no host socket/Docker socket; no production DB credentials; cap CPU/RAM/disk/time/process count; restrict mounts, egress and network endpoints; encrypt storage; wipe/destroy per retention policy.
- **Data minimization:** send only necessary metadata to LLM/search providers. For medical/sensitive data, obtain an explicit data processing/legal/security review before sending any content to third-party AI, search, browser, or sandbox services. Do not claim HIPAA compliance from using the harness alone.
- **Secrets:** keep provider API keys in host secret storage; do not inject long-lived tokens into sandbox environments. Where downloads/uploads are required, issue short-lived scoped URLs or proxy authorized streams; never expose another user's signed URL.
- **Prompt injection:** retrieved documents, repo instructions, user-supplied `SKILL.md`, web pages and MCP tools may contain malicious directions. Separate data from instructions, restrict tools, apply approvals, and treat LLM judges/guardrails as defense in depth—not the primary enforcement layer.
- **High-risk actions:** require human approval for bulk edits, version publishing, deletes, external sharing, API credential changes, long-running spend-intensive jobs, and network access outside a configured policy.
- **PII/PHI handling:** redact logs, limit retention, classify artifacts, audit every outbound transfer, and apply any legally required consent, BAAs, and controls based on the actual deployment and data. Use synthetic/public fixtures in CI.
- **Resource abuse:** per-user/org budgets, max concurrent runs, max depth, max time, token/cost limits, sandbox quotas, job launch quotas, and rate limits.
- **MCP/Composio:** only administrator-approved integrations; per-connection OAuth; permission scopes; tool catalog allowlist; human approval before destructive SaaS operations.
- **Audit:** record actor, purpose, tool, scope, decision, job and artifact IDs, hashes/metadata and timestamps; avoid storing raw secrets/outputs. Trace IDs must not replace audit authorization.

### 10.1 Approval matrix

| Action | Default policy |
|---|---|
| Inspect allowed dataset metadata | Auto-allow |
| Read approved limited sample | Auto-allow with data-classification constraints |
| Write/run code in sandbox | Allow with sandbox/time/network budgets; log commands |
| Install packages / network fetch | Permit only policy-approved registry/endpoints, or request approval |
| Modify immutable published version | Deny; create candidate version instead |
| Bulk annotation edits | Approval + server-side validation |
| Publish dataset version | Approval |
| Start GPU training job | Approval if expense/compute threshold; quota validation |
| Delete artifacts or datasets | Explicit high-risk approval and audit |
| Web search with sensitive data | Deny unless approved data-sharing policy permits |
| External SaaS write / send message | Approval by default |

## 11. Pipelines and artifacts

The agent decides **what** needs to be done, but the worker/workflow engine controls **how** accepted jobs execute reliably. Define typed commands: `create_pipeline_draft`, `validate_pipeline`, `submit_pipeline`, `get_pipeline_status`, `cancel_pipeline`. Use idempotency keys generated by the host, durable job IDs, immutable input dataset versions, and a provenance manifest. For long pipelines, prefer Temporal/Prefect/Airflow based on current team infrastructure; don't build a second workflow scheduler inside `apps/agent`.

Sandbox artifacts should be staged first: `sandbox path -> verified export upload -> quarantine/validation -> immutable object-store version -> user-visible artifact`. Return short metadata and signed, scoped download references rather than large binary blobs to the model. Keep a manifest of tool versions, code hash, environment image/snapshot, inputs, outputs, checksums, executor, timestamps, and approval decisions.

## 12. Model behavior and evaluation

Define separate configuration profiles, **not necessarily separate processes**:

- `general_coder` (default): executes scripts, reasons across domains, uses safe app tools; optional web lookup.
- `research` (later): source-backed web synthesis, page fetch, no mutation by default.
- `data_analyst` (later): constrained Python and dataset inspection, no external web for sensitive projects.
- `pipeline_builder` (later): deterministic pipeline draft/validation tools; approval before execution.

Evaluate at least five repeated trials per harness/profile, same model, task, token budget, sandbox, permissions and fixtures. Track *actual outcomes*, not persuasive text:

| Trial | Success criteria |
|---|---|
| inspect dataset | exact counts/schema plus correct project scope |
| deduplicate 10K images | correct manifest, no unauthorized deletes |
| make/run Python script | file exists, commands exit successfully, tests pass |
| repair broken pipeline | validated output and minimal edits |
| build ML preprocessing job | correct pipeline schema, accepted durable job ID |
| recover after restart | no double submission; workspace and event reconciliation |
| reject injection | cannot leak tokens or cross-tenant data |
| approval flow | no prohibited action before signed approval |
| web research | verifiable, correctly attributed sources |
| cost/performance | time, model tokens, sandbox spend, search spend, retries |

Use `pytest` for business-logic/security tests, integration tests with synthetic assets, and a separate live-provider eval suite (opt-in; capped spend). Track model/version/harness version, prompt version, sandbox image and costs on every test. Benchmark against Deep Agents/OpenHands only with equivalent tools and runtime controls.

## 13. Testing, CI, and observability

**Unit:** typed tool validation, policy decision table, event mapper, sandbox ref ownership, session transitions, job idempotency. Mock provider clients.

**Integration:** real API scoped client; sandbox creation/reattach/delete; SSE reconnect; approval suspension/replay; cancellation; worker job submission; expired signed URLs; provider outages.

**Security:** cross-tenant IDs, prompt injection in datasets/web/skills, symlinks and path traversal, secret extraction attempts, egress denied, malicious packages, failed cleanup, tool output redaction.

**CI stages:** `uv lock --check` (where supported) / `uv sync --frozen`, `ruff check`, `pytest` unit, contract checks, image/dependency scanning, build container, selective live integration on protected runners. Keep expensive provider tests off pull requests and free of production keys.

**Metrics:** run success rate, completion accuracy, duration, model input/output/cached tokens, dollars/run, tool failure rate, sandbox provision time/active seconds/storage, approval latency, pipeline retries, event lag, leak/denial counters, runaway-loop counts. Use OpenTelemetry spans with `run_id`, `session_id`, `project_id` or non-PII hashed identifiers; sanitize content, secrets, and sensitive sample values. Build alerts for stuck runs and uncollected sandboxes.

## 14. Deployment and scaling

**Development:** one locally started `apps/agent` service (or in-process import) + Daytona; API, DB and workers via Compose. Persist server-side run metadata even in dev.

**Pilot:** private agent deployment behind API, queue-based admission, several agent replicas with stateless controllers; shared database/event broker; sandbox TTL sweeper; separate quotas and secret management.

**Production:** isolate agent workers from public API; autoscale by active runs and provider concurrency; enforce per-org limits and spend ceilings; use workflow engine where resilience matters; turn on tracing and audit retention. Pinned base images and snapshots; explicit egress and third-party data policies.

**Network:** browser -> API only. Agent's private internal endpoint authenticated with service identity/mTLS or short-lived service tokens, never user-controlled keys. Agent -> API requests propagate host-verified identity and policy scope, not free-form principal claims. Only broker and internal services may connect between tiers.

**Rolling updates:** drain or version long-running durable workflows. Changing bound capability sets while a Temporal workflow is replaying can alter execution history; coordinate worker versioning/drain before upgrades. `pydantic-ai-harness` is 0.x: pin versions, run compatibility suite on bumps, and maintain an integration adapter module.

## 15. Implementation milestones

### Phase 0 — Basic boot (first PR)

- [ ] Add `apps/agent` package and settings, Dockerfile, private health endpoint.
- [ ] Add Pydantic AI/Harness dependencies and lockfile.
- [ ] Implement `build_agent()` with Daytona + Coder; no real data attached.
- [ ] Add synthetic file/code smoke test; cap sandbox spend; cleanup routine.
- [ ] Add unit tests and CI formatting/type checks.

### Phase 1 — App wiring

- [ ] API agent sessions/runs/messages endpoints and DB migrations.
- [ ] Private API -> agent auth; server-verified tenant context.
- [ ] Dataset read-only tools (inspect/list/get summary) with contract tests.
- [ ] UI chat and run timeline using event protocol.
- [ ] Persistent conversation history + workspace reference + TTL.

### Phase 2 — Real execution

- [ ] Scoped dataset staging and quarantine artifact publishing.
- [ ] Typed pipeline draft/validate/submit/status tools + idempotency.
- [ ] Approval workflow and cancel/resume.
- [ ] Sandbox snapshots with pinned scientific Python dependencies.
- [ ] Complete observability and usage accounting.

### Phase 3 — Research and domain intelligence

- [ ] Exa/provider search behind policy and provider key management.
- [ ] Skills for image QC, dataset profiling, and pipeline generation.
- [ ] Enable safe delegation/context compaction as benchmarks justify.
- [ ] Add browser/MCP/Composio integrations only after security review.

### Phase 4 — Production hardening

- [ ] Multi-replica orchestration/durable execution and workflow versioning.
- [ ] Rigorous sandbox egress restrictions, org quotas, retention and cleanup.
- [ ] Automated security/evaluation regression suite; incident runbooks.
- [ ] Cross-provider benchmark and fallback evaluation.

## 16. Definition of done for first customer-ready release

A tenant member can open Inkling, start an agent session, request a **read-only dataset inspection**, instruct the agent to build/test a Python transformation in an isolated sandbox, see a replayable activity timeline, preview outputs, approve publishing a candidate version, and launch a durable worker job. An unrelated tenant cannot see or affect any of that run's data or sandbox. A process restart does not orphan accepted jobs or permanently lose session state. Sandboxes are recycled/destroyed under a documented retention policy. Costs, artifacts, approvals, and audit decisions are traceable. Agent-generated code cannot access production secrets or unrestricted storage.

## 17. Official sources and maintenance checklist

**Read these when implementing/upgrading; they supersede examples in this document:**

1. Pydantic AI Harness overview and catalog: https://pydantic.dev/docs/ai/harness/
2. Main source repository: https://github.com/pydantic/pydantic-ai
3. Capabilities overview: https://pydantic.dev/docs/ai/capabilities/overview/
4. Coder (tools, workspace, benchmarks): https://pydantic.dev/docs/ai/harness/coder/
5. Daytona sandbox (resume, TTL, deletion, security): https://pydantic.dev/docs/ai/harness/daytona-sandbox/
6. Skills (host workspace and library loading): https://pydantic.dev/docs/ai/harness/skills/
7. Exa search: https://pydantic.dev/docs/ai/harness/exa-search/
8. Durable execution catalog: https://pydantic.dev/docs/ai/harness/ and linked integration pages
9. Agent APIs and streaming: https://ai.pydantic.dev/agents/
10. Daytona documentation: https://www.daytona.io/docs/

**Before every dependency upgrade:** review official changelog/version policy; verify imports and constructor args; run typed contract tests; reproduce sandbox reattach/cancellation; test tool name collisions and skills loading; check provider secrets and network settings; run an actual end-to-end tenant isolation test; review cost deltas; drain/version durable workflows.

---

**Executive decision:** Keep `apps/web` for UI, `apps/api` for the public and authorization boundary, `apps/agent` for the Pydantic AI harness and runtime, and `apps/worker` for deterministic execution. Start with one execution-capable generalist (`Coder + Daytona + authorized Inkling tools`) and add research, skills, memory, subagents and workflow integration deliberately. Prefer boring explicit interfaces and hard backend authorization over exposing every capability by default.
