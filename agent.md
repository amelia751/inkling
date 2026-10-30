# Inkling Agent Runtime — Architecture & Integration Specification

**Status:** implemented in part (see §15); `apps/agent` exists as a Node + pi service  
**Last reviewed:** 2026-10-30  
**Owner:** Inkling engineering  
**Scope:** `apps/agent` and its integration with `apps/web`, `apps/api`, `apps/worker`, and external providers  
**Technology:** `apps/agent` is TypeScript on Node ≥ 22.19 with **pi** (`@earendil-works/pi-coding-agent` 1.4.0), Hono and Daytona (`@daytona/sdk` 0.227.0); `apps/api` stays Python/FastAPI with PostgreSQL. Temporal optionally, later.

> This document began as a design guide for a Python agent on Pydantic AI Harness. `todo/todo1.md` replaced that framework choice with pi; §2–§7 and §8.3 describe the Node service as built, and everything else (boundaries, trust model, approval matrix, lifecycle rules, event contract) still applies. pi ships about three releases a week: dependencies are pinned exactly and upgraded deliberately (§17). Sources: pi's bundled docs (`node_modules/@earendil-works/pi-coding-agent/docs/`), https://www.daytona.io/docs/.

## 1. Product goals and non-goals

Inkling is a collaborative, no-code data studio. Its embedded agent must be able to **reason, research, write code, execute that code in isolated sandboxes, inspect artifacts, and orchestrate pipelines**, while operating on authorized datasets and supporting ordinary knowledge questions. It is not exclusively a coding assistant.

**Initial goals**

1. Provide an in-product chat and execution experience backed by the pi agent service (`apps/agent`).
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
apps/agent (Node + pi, PRIVATE service on 127.0.0.1:8100)
    | pi AgentSession per chat; profiles; server/client/sandbox tools; approvals
    |-- internal API client --> apps/api (authorized dataset/annotation operations)
    |-- sandbox adapter -----> Daytona / E2B / Modal / Docker
    |-- client tools --------> the Studio (browser) via the event feed, results POSTed back
    |-- search/browse --------> later: Exa / provider web search
    |-- pipeline tool -------> API / Temporal / job queue --> apps/worker
    |-- telemetry -----------> OTLP / Logfire
    `-- events -------------> API event broker/store --> apps/web

apps/worker: deterministic ingest, validation, de-identification checks,
             conversions, previews, exports, ML jobs (later)
PostgreSQL: tenant-scoped app records, agent sessions/runs, tool audit, job IDs
Object storage: immutable dataset versions, sandbox artifact exports
```

**Architectural rule:** the browser never holds the agent's credentials. In development the Vite dev server proxies `/api/agent/*` to the service and adds the service token; in production only `apps/api` talks to it. The public API is the authority for tenant and project access; until `apps/api` exists the service uses one local principal.

### 2.2 Ownership matrix

| Concern | Owner | Agent behavior |
|---|---|---|
| Login, accounts, organizations, project authorization | `apps/api` | Receives scoped identity; never accepts trusted tenant IDs from the model |
| Dataset metadata, versions, annotations, studies | `apps/api` domain modules | Calls typed, permission-checked internal endpoints |
| Multi-step reasoning and tool selection | `apps/agent` | Owns the pi agent loop (one `AgentSession` per chat session) |
| Temporary code/files/process execution | Sandbox provider | Agent controls it via limited workspace adapter |
| Ingest, transforms, export, training, retries | `apps/worker` + queue/Temporal | Agent submits a job; does not own its lifecycle |
| Search/browser external actions | Agent adapters | Controlled by feature flags, policies and budgets |
| Session/run/event persistence | API/Postgres plus event channel | Agent emits canonical events, API persists/exposes them |
| Artifact publishing | API/object storage | Explicit validated publish operation, not direct sandbox write |
| Observability | Shared OTLP/Logfire | Consistent trace IDs through every service |

## 3. Monorepo layout

`apps/agent` is a pnpm workspace package (`@studio/agent`), not a Python package. The wire types live in `packages/agent-protocol`, imported by both the service and the web app (apps never import each other).

```text
inkling/
├── agent.md                         # THIS specification
├── todo/todo1.md                    # the pi + Daytona plan this section implements
├── secrets/                         # git-ignored except README.md and *.example (dev only)
├── apps/
│   ├── web/                         # React + Vite Studio
│   │   ├── vite.config.ts           # proxies /api/agent → agent /v1, adds the service token
│   │   └── src/
│   │       ├── lib/agent/           # protocol re-export, HTTP/SSE client, card tools, snapshot
│   │       ├── stores/agent.ts      # threads, sessions, active run (reattach after reload)
│   │       └── modules/core/panels/ai.tsx   # the Inkling AI panel; runs client tools
│   ├── agent/                       # Node service (@studio/agent)
│   │   ├── src/
│   │   │   ├── main.ts / app.ts     # boot; Hono routes (§9)
│   │   │   ├── config.ts secrets.ts log.ts protocol.ts
│   │   │   ├── agent/               # factory, profiles, models (ModelRuntime, scripted model), prompts/
│   │   │   ├── tools/               # dataset (server), client (browser bridge), sandbox, policy
│   │   │   ├── sandbox/             # Daytona client, manager, ops, exec, search, snapshot, sweeper, egress
│   │   │   └── runtime/             # sessions (JSONL), runs, events (projection + replay), approvals
│   │   ├── sandbox-image/requirements.txt
│   │   ├── test/unit · test/live · scripts/{smoke,sweep,snapshot}.ts
│   │   └── NOTICE                   # Apache-2.0 attribution for code adapted from @daytona/pi
│   ├── api/                         # later: FastAPI, the public and authorization boundary
│   └── worker/                      # later: deterministic ingest/export jobs
└── seed-data/                       # public, de-identified sample datasets (fetched locally)
```

**Don't duplicate:** domain validation from `api`, reproducible ETL from `worker`, or the Studio's environment logic (the service receives the module catalogue from the browser and never imports web code). `agent/` = profiles and session construction; `tools/` = operations; `sandbox/` = vendor adapter; `runtime/` = lifecycle and events; `prompts/` = system instructions.

## 4. Capability inventory (pi)

pi is a TypeScript agent harness with a mature loop: steering and follow-up queues, compaction, JSONL session trees, per-message cost, retries, and `tool_call` hooks that can block a call. Its built-in tools take pluggable `operations`, which is how they are pointed at Daytona. What the Pydantic AI Harness plan expected maps as follows:

| Pydantic AI Harness | pi equivalent in Inkling |
|---|---|
| Coder | pi's bash/read/write/edit/ls tool definitions with Daytona `operations`, plus remote find/grep, `run_python`, `preview_url`, `export_artifact`, `upload_dataset_sample` (`tools/sandbox.ts`) |
| Skills | pi skills (not enabled; host discovery is off) |
| Compaction | pi compaction (`SettingsManager.inMemory({ compaction: { enabled: true } })`) |
| SpendLimits | budgets in `tools/policy.ts` (tool calls, wall clock, `usage.cost.total` per run) |
| tool approvals | the `tool_call` extension hook → `ApprovalBroker` → approval card in the Studio |
| Temporal | later: a queue or pi's durable-execution work |

### 4.1 Profiles (host-owned)

The client picks a profile by **name**; it never grants capabilities. Client-declared tools are checked against the profile's allowlist when the session is created.

| Profile | Tools | Sandbox |
|---|---|---|
| `assistant` | dataset server tools + card client tools | none |
| `environment-designer` (Studio default) | above + environment client tools (`list_modules`, `describe_contribution`, `get_environment`, `validate_environment`, `preview_environment`, `patch_environment`, `run_command`) | none |
| `coder` | above + sandbox tools | Daytona, created lazily on the first sandbox tool call |

pi's own built-in tools would run on the host, so sessions are created with `noTools: "builtin"` and only Inkling's tools are registered. Nothing is discovered from disk: no `AGENTS.md`, skills, prompt templates, themes or extensions from the host or `~/.pi`.

### 4.2 Capability selection policy

Capability profiles are *host-owned configuration*, not model-editable user prompts. A user message asking to enable arbitrary shell/network/MCP access is never sufficient. Evaluate profiles for cost, latency, privileges, and benchmark performance. Keep separate high-trust internal maintenance agents away from customer-facing agents.

## 5. External provider integration matrix

| Provider | Role | Support / integration | Launch posture |
|---|---|---|---|
| **Daytona** | persistent isolated code workspace | `@daytona/sdk` 0.227.0 + tool layer adapted from `@daytona/pi` | **in use** for the `coder` profile |
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

The other rows are options from the original Harness survey; none is wired up. Do not assume provider SDKs, OAuth, search credits, web permissions, or sandbox images ship inside pi. Avoid exposing tokens to the model or shell environment; use server-owned integrations and narrow credentials.

## 6. Local bootstrapping: step by step

### 6.1 Prerequisites

- pnpm (the repo's package manager). `apps/agent` declares `engines.node >=22.19` and `devEngines.runtime` Node `^24` with `onFail: download`, so pnpm fetches a matching Node just for this package: check with `pnpm --filter @studio/agent exec node -v`.
- A model key: `OPENAI_API_KEY` (dev default `openai:gpt-6.1-sol`) or `ANTHROPIC_API_KEY`, in the real environment or `secrets/models.env`.
- `DAYTONA_API_KEY` (+ `DAYTONA_API_URL`, `DAYTONA_TARGET`) in `secrets/daytona.env` for the `coder` profile; without it the service runs with sandboxes off.
- Synthetic or public de-identified data only (seed-data).

### 6.2 Install

```bash
pnpm install                                   # apps/agent is a workspace package
pnpm --filter @studio/agent snapshot          # optional: build the content-hashed sandbox snapshot (minutes, once)
```

Dependencies are pinned exactly (`@earendil-works/pi-coding-agent` and `pi-ai` 1.4.0, `@daytona/sdk` 0.227.0). The workspace's `minimumReleaseAgeExclude` lists the Daytona packages that were newer than pnpm's release-age policy when pinned.

### 6.3 Configuration

Non-secret settings are documented in `apps/agent/.env.example` (`AGENT_*`); secrets come from the real environment or, outside production, from `secrets/*.env` (never overriding real env). In production missing keys fail startup; in development they only disable the feature. `AGENT_MODEL` must be in `AGENT_MODEL_ALLOWLIST`; `AGENT_MODEL=scripted` (dev/test only) replays a fixture instead of calling a provider.

### 6.4 Smoke test

```bash
pnpm --filter @studio/agent smoke     # real model + real Daytona: write hello.py, run it, report stdout; deletes the sandbox
pnpm agent:live                        # Daytona live tests (one labelled sandbox, always deleted)
pnpm agent:test                        # unit tests, no network
```

### 6.5 Web search

Not enabled. When added, it is a server tool behind policy and budgets; retrieved content is untrusted.

### 6.6 Run the private service

```bash
pnpm agent        # tsx watch src/main.ts → http://127.0.0.1:8100
pnpm dev          # Vite; /api/agent/* is proxied to the service with the service token
```

`/health/live` makes no Daytona or model calls; `/health/ready` reports config, model key, Daytona reachability (cached 60 s) and the egress tier. On first start in development the service writes `secrets/agent.env` with a random `INTERNAL_AGENT_SERVICE_TOKEN` that the Vite proxy reads. Do **not** expose port 8100.

### 6.7 Startup order

1. Start database/object-store/queue from `infra/docker-compose.yml` as applicable.
2. Run API migrations, boot `apps/api` and `apps/worker`.
3. Export agent keys in the agent's own environment, start `apps/agent`.
4. Confirm API-to-agent service authentication and readiness.
5. Smoke test a synthetic dataset request, then a Daytona code-execution request.
6. Boot `apps/web`; verify chat event timeline and approval UI.
7. Verify sandbox cleanup, cancel, retries, and no cross-tenant data access.

Docker Compose services should use the private service name (`http://agent:8100`) instead of `localhost`. The public API must be the sole exposed entry point.

## 7. Package structure and factories

### 7.1 `config.ts`

zod-validated settings; fails closed in production. Model allowlist, budgets, concurrency, sandbox lifecycle, client-tool and approval timeouts. `secrets.ts` loads `secrets/*.env` only outside production and logs key names and last three characters, never values.

### 7.2 `agent/factory.ts`

`createInklingSession()` builds one pi `AgentSession` from a server-chosen profile: `DefaultResourceLoader` with only the policy extension (`extensionFactories`), host discovery off, the system prompt passed as an override; `SettingsManager.inMemory` with compaction and retries; the session's `SessionManager` (restored from JSONL when resuming); `customTools` from the profile; `noTools: "builtin"`. Everything per session (bridge, approvals, dataset snapshot, sandbox handle) lives in a `SessionContext` captured by tool closures; there is no module-level mutable state.

### 7.3 Application tools (three execution sites)

- **Server tools** (`tools/dataset.ts`): `dataset_overview`, `list_items`, `get_item_annotations`, `run_validation` over the snapshot the Studio shares with each message (seed API fallback). The project comes from the session record; a `projectId` argument naming another project is an error.
- **Client tools** (`tools/client.ts`): declared by the browser at session creation, validated against the profile allowlist. `execute` emits `client-tool { callId, name, input }` and awaits `POST /v1/runs/:runId/client-tools/:callId` (timeout `AGENT_CLIENT_TOOL_TIMEOUT_S`). Environment tools run against the live registry and store, so each edit stays one undoable `setEnv` step; card tools return `{ shown: true }` at once and only act on the expert's click.
- **Sandbox tools** (`tools/sandbox.ts`): resolve the session's sandbox lazily and throw if there is none; they never fall back to the host.

### 7.4 Skills

Not enabled. If added, they are versioned with the service, loaded from an explicit path (never discovered from the host), and treated as instructions only: permissions stay in the tool layer.

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

### 8.3 Daytona specifics (SDK 0.227)

- One sandbox per chat session, created lazily, named `inkling-<env>-<sessionId>` so `daytona.get(name)` reattaches after a restart; the id is also recorded in the session (`daytona-sandbox` custom entry and `meta.json`). Labels `{ app, env, session, project, owner, profile }` are the only basis for sweeping and never contain PHI.
- Lifecycle: `autoStopInterval` 15 min, `autoArchiveInterval` 1 day, `autoDeleteInterval` 7 days (dev), `ttlMinutes` 24 h; `public: false`. While a run is active the manager calls `refreshActivity()` every 5 minutes (background processes don't count as activity).
- Recovery (`withRecovery`): on failure inspect the real state; stopped/archived → start and retry once; 404 → `SandboxUnavailableError`. Never run on the host.
- Exec: short commands use `executeCommand` with a background-safe wrapper; `bash` streams through a session command (`getSessionCommandLogs`), and abort/timeout delete the session (Daytona has no per-command kill). `cd` goes on its own line: `cd X && cmd &` would background the whole list with the log pipe open and hang the stream.
- Snapshot `inkling-agent-<sha256(recipe + requirements)[:12]>` (Debian slim, Python 3.12, pinned scientific stack, ripgrep). If it isn't active, sandboxes use Daytona's default image with a warning; a chat never waits for a build.
- Egress: per-sandbox `domainAllowList` / `networkBlockAll` only on Tier 3+ orgs (Tier 1–2 get an API error); a cached probe at startup decides. Without it, network-ish commands need approval. Never put credentials in `envVars`; use Daytona Secrets if sandbox code ever needs one. Daytona does inject its own metadata variables (`DAYTONA_SANDBOX_ID`, `DAYTONA_ORGANIZATION_ID`, …); host keys never reach the sandbox (live-tested).
- Signed preview URLs (`getSignedPreviewUrl(port, ttl)`) only open one port; the standard preview token is never handed out.
- Ending a run does not delete the sandbox. The sweeper (every 10 minutes and at startup) stops idle `started` sandboxes and deletes orphans/expired ones, at most 5 per pass; quota errors stop the oldest idle sandboxes first. Deleting a chat session deletes its sandbox. Every deletion is logged with its labels.

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

**CI stages:** `pnpm install --frozen-lockfile`, `pnpm --filter @studio/agent typecheck`, `pnpm agent:test` (unit, scripted model, no network), web `tsc -b` + vitest, `apps/web/e2e/agent_test.py` against the scripted service, then `pnpm agent:live` / `smoke` on protected runners only. Keep expensive provider tests off pull requests and free of production keys.

**Metrics:** run success rate, completion accuracy, duration, model input/output/cached tokens, dollars/run, tool failure rate, sandbox provision time/active seconds/storage, approval latency, pipeline retries, event lag, leak/denial counters, runaway-loop counts. Use OpenTelemetry spans with `run_id`, `session_id`, `project_id` or non-PII hashed identifiers; sanitize content, secrets, and sensitive sample values. Build alerts for stuck runs and uncollected sandboxes.

## 14. Deployment and scaling

**Development:** one locally started `apps/agent` service (or in-process import) + Daytona; API, DB and workers via Compose. Persist server-side run metadata even in dev.

**Pilot:** private agent deployment behind API, queue-based admission, several agent replicas with stateless controllers; shared database/event broker; sandbox TTL sweeper; separate quotas and secret management.

**Production:** isolate agent workers from public API; autoscale by active runs and provider concurrency; enforce per-org limits and spend ceilings; use workflow engine where resilience matters; turn on tracing and audit retention. Pinned base images and snapshots; explicit egress and third-party data policies.

**Network:** browser -> API only. Agent's private internal endpoint authenticated with service identity/mTLS or short-lived service tokens, never user-controlled keys. Agent -> API requests propagate host-verified identity and policy scope, not free-form principal claims. Only broker and internal services may connect between tiers.

**Rolling updates:** drain or version long-running durable workflows. Changing bound capability sets while a Temporal workflow is replaying can alter execution history; coordinate worker versioning/drain before upgrades. pi releases about three times a week: pin exact versions and follow the upgrade checklist in §17.

## 15. Implementation milestones

### Phase 0 — Basic boot

- [x] `apps/agent` package, settings, private health endpoints (Node + pi; no Dockerfile yet).
- [x] pi + Daytona dependencies pinned in the pnpm lockfile.
- [x] Session factory with Daytona-backed tools; no real data attached.
- [x] Live smoke test (`pnpm --filter @studio/agent smoke`); spend-capped; sandbox always deleted.
- [x] Unit tests and typecheck.

### Phase 1 — App wiring

- [ ] API agent sessions/runs/messages endpoints and DB migrations.
- [x] Service-token auth on every agent route (dev: Vite proxy; later: `apps/api`); single local principal for now.
- [x] Dataset read-only tools (overview/list/annotations/validation) with tests.
- [x] UI chat and run timeline on the event protocol (SSE, resumable).
- [x] Persistent conversation history (JSONL) + sandbox reference + TTL.

### Phase 2 — Real execution

- [ ] Scoped dataset staging and quarantine artifact publishing.
- [ ] Typed pipeline draft/validate/submit/status tools + idempotency.
- [x] Approval workflow and cancel; reattach to a run after reload.
- [x] Sandbox snapshots with pinned scientific Python dependencies.
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

1. pi docs, bundled with the installed version: `apps/agent/node_modules/@earendil-works/pi-coding-agent/docs/` (`sdk.md`, `extensions.md`, `session-format.md`, `custom-provider.md`, `compaction.md`) and `examples/sdk/`.
2. pi source: https://github.com/earendil-works/pi
3. `@daytona/pi` (the official pi integration the sandbox tool layer is adapted from).
4. Daytona TypeScript SDK reference: https://www.daytona.io/docs/en/typescript-sdk/sandbox
5. Daytona network limits (tiers, allow lists): https://www.daytona.io/docs/en/network-limits
6. Daytona documentation: https://www.daytona.io/docs/

**Upgrade checklist** (pi ships about three releases a week):

1. Read the pi changelog (`node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md`) and the Daytona SDK release notes between the pinned and target versions.
2. Bump the exact versions in `apps/agent/package.json` (`pi-coding-agent` and `pi-ai` together).
3. Diff the `createAgentSession` options, `AgentSessionEvent`, `*Operations` and `ToolCallEvent` declarations; the projection (`runtime/events.ts`) and ops (`sandbox/ops.ts`) depend on them.
4. Re-record `test/unit/fixtures/pi-events.jsonl` if the event stream changed, then run `pnpm agent:test`, `pnpm agent:live`, `pnpm --filter @studio/agent smoke` and `apps/web/e2e/agent_test.py`.
5. Check `@daytona/pi` for fixes worth porting into `apps/agent/src/sandbox/` (keep the NOTICE).
6. Review cost deltas and the default model list (`AGENT_MODEL_ALLOWLIST`).

---

**Executive decision:** Keep `apps/web` for UI, `apps/api` for the public and authorization boundary, `apps/agent` for the pi harness and runtime, and `apps/worker` for deterministic execution. Start with host-owned profiles (assistant, environment designer, coder with Daytona) and authorized Inkling tools, and add research, skills, memory, subagents and workflow integration deliberately. Prefer boring explicit interfaces and hard backend authorization over exposing every capability by default.
