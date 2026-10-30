# @studio/agent

The Studio's AI agent service: one [pi](https://github.com/earendil-works/pi) `AgentSession` per chat, typed Inkling tools, [Daytona](https://www.daytona.io/docs/) sandboxes for code, and a replayable event feed for the Studio. Private: it listens on `127.0.0.1:8100` (`AGENT_HOST=0.0.0.0` in containers) and only the Vite proxy (dev) or `apps/api` (later) talks to it. Any number of replicas can run behind a plain Service; see [Scaling](#scaling-replicas). Design: [`docs/agent.md`](../../docs/agent.md); plan: [`todo/todo1.md`](../../todo/todo1.md).

## Run

```bash
pnpm install
pnpm agent                     # from the repo root: tsx watch src/main.ts
pnpm dev                       # the Studio; /api/agent/* is proxied here with the service token
pnpm --filter @studio/agent start:dev   # tsx src/main.ts once, no watch (tests/e2e uses this)
```

Production (what the image runs):

```bash
pnpm --filter @studio/agent build      # esbuild → dist/main.js, dist/scripts/{migrate,sweep}.js
pnpm --filter @studio/agent start      # node dist/main.js
```

The bundle contains this package and the `@studio/*` workspace packages (and inlines `schemas/naming.json`); third-party packages stay external and load from `node_modules`. Files the code reads at runtime are read from their source location, exactly as under tsx: `src/agent/prompts/*.md` and `sandbox-image/requirements.txt` (snapshot hash).

Node: the package pins `devEngines.runtime` Node `^24` (`onFail: download`), so pnpm fetches it. Check with `pnpm --filter @studio/agent exec node -v` (needs ≥ 22.19).

Keys come from the real environment or, outside production, `secrets/*.env` (see [`secrets/README.md`](../../secrets/README.md)):

| Key | Needed for |
|---|---|
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | the model in `AGENT_MODEL` (default `openai:gpt-6.1-sol`, must be in `AGENT_MODEL_ALLOWLIST`) |
| `DAYTONA_API_KEY`, `DAYTONA_API_URL`, `DAYTONA_TARGET` | the `coder` profile; without them sandboxes are off |
| `INTERNAL_AGENT_SERVICE_TOKEN` | bearer auth; generated into `secrets/agent.env` on first dev start |

Other settings are in [`.env.example`](.env.example). With no model key, set `AGENT_MODEL=scripted AGENT_SCRIPT=<fixture.json>` to replay a script offline.

## Test

```bash
pnpm agent:test                                # unit + in-process HTTP tests on the scripted model, no network
# also against real Postgres + Redis (store, bus and the two-replica test in test/unit/cluster.test.ts):
docker run -d --rm -p 55432:5432 -e POSTGRES_PASSWORD=test postgres:17
docker run -d --rm -p 56379:6379 redis:7
AGENT_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres AGENT_TEST_REDIS_URL=redis://127.0.0.1:56379 pnpm agent:test
pnpm --filter @studio/agent typecheck
pnpm agent:live                                # real Daytona: one labelled sandbox, always deleted
INKLING_SNAPSHOT_LIVE=1 pnpm agent:live        # also builds/checks the snapshot (slow, manual)
pnpm --filter @studio/agent smoke             # real model + Daytona end to end; prints tokens and cost
```

Studio e2e against this service (scripted model; the test starts the service itself on port 8299):

```bash
cd apps/web
INKLING_E2E=1 INKLING_AGENT_URL=http://127.0.0.1:8299 INTERNAL_AGENT_SERVICE_TOKEN=e2e-agent-token \
  pnpm exec vite --port 5299 --strictPort &
python3 ../../tests/e2e/agent_test.py --port 5299
```

## Sandboxes

```bash
pnpm --filter @studio/agent snapshot                       # build inkling-agent-<hash> if missing (minutes)
pnpm --filter @studio/agent sweep                          # dry run: list app=inkling sandboxes and the plan
pnpm --filter @studio/agent sweep -- --stop                # stop idle ones
pnpm --filter @studio/agent sweep -- --delete              # also delete orphans / past retention (max 5)
pnpm --filter @studio/agent sweep -- --env test --label test=live --all --delete   # clear leftovers from live tests
```

The running service sweeps every 10 minutes too (`SWEEPER_ENABLED=false` turns that off; with several replicas run `node apps/agent/dist/scripts/sweep.js --stop` as the `agent-sweeper` CronJob instead). Known and active sessions come from the configured store, so a sweep never stops a sandbox whose run is in flight on any replica. Only sandboxes labelled `app=inkling` in the current env are ever touched.

## HTTP API

All `/v1/*` routes need `Authorization: Bearer <INTERNAL_AGENT_SERVICE_TOKEN>`; bodies are validated with zod. Every response carries `X-Request-Id` (the caller's, if it sent a sane one); a W3C `traceparent` is continued. Both appear as `request_id` / `trace_id` in every log line of that request and of the run it starts.

```
GET  /healthz                             process up (k8s liveness)
GET  /readyz                              store and Redis reachable, not draining (k8s readiness); 503 otherwise
GET  /version                             { service, version, gitSha }  (GIT_SHA build arg)
GET  /health/live                         process up (no Daytona or model calls)
GET  /health/ready                        config, model key, Daytona reachable (cached 60 s), egress tier
GET  /v1/status                           { configured, provider, model, sandbox, profiles }
POST /v1/sessions                         { projectId, profile?, clientTools?, catalogPrompt?, restricted? } → 201 { sessionId }
GET  /v1/sessions/:id                     meta, active run, sandbox, artifacts
DELETE /v1/sessions/:id                   cancel, delete the sandbox and the record
POST /v1/sessions/:id/messages            { text, context?, snapshot? } → 202 { runId, steered }; 503 while draining
GET  /v1/runs/:runId/events?after=seq     SSE; resumable with Last-Event-ID; ends after `done`
POST /v1/runs/:runId/cancel
POST /v1/runs/:runId/client-tools/:callId { ok, output }        409 if not pending
POST /v1/approvals/:approvalId            { decision: approve|reject, note? }
GET  /v1/sessions/:id/artifacts
GET  /v1/artifacts/:artifactId            download (dev only)
```

Types: [`packages/agent-protocol`](../../packages/agent-protocol/src/index.ts), which both this service and the web app import.

## Scaling (replicas)

Any replica can serve any request, so the Deployment needs no sticky sessions. Run more than one replica only with `AGENT_STORE=postgres` and `AGENT_EVENT_BUS=redis`; the defaults (`file`, `memory`) are for one dev process.

| What | Where | Notes |
|---|---|---|
| Sessions, pi transcripts, run records, pending approvals and client-tool calls | `SessionStore` (`src/store/`): `.data/` files, or Postgres tables `agent_sessions`, `agent_transcript`, `agent_runs`, `agent_run_inputs` | schema via `pnpm --filter @studio/agent migrate` (pre-deploy Job) or `AGENT_AUTO_MIGRATE=1` (dev/compose); startup fails if the schema is behind |
| Run events (SSE) | `RunEventBus` (`src/bus/`): in-process, or one Redis Stream per run `<resourcePrefix>:run:<runId>` | entry id `<seq>-0`, so any replica replays from `Last-Event-ID`; capped by `AGENT_RUN_STREAM_MAXLEN`, expires `AGENT_RUN_STREAM_TTL_S` after the last event |
| Approval / client-tool answers, steer, cancel | stored as run inputs; the replica running the loop is woken over Redis pub/sub (`<resourcePrefix>:agent:signals`) and also polls every `AGENT_INBOX_POLL_MS` | the POST may hit any replica; a second answer is a 409/404 everywhere |

**The agent loop lives on one replica.** The replica that accepted the message runs the run to the end and heartbeats its record every `AGENT_RUN_HEARTBEAT_S`. Messages sent to another replica meanwhile are steered into it; one active run per session is enforced in Postgres. If the pod dies, nobody resumes the loop: the next read of that run on any replica (its event stream, the session, a new message) sees the heartbeat older than `AGENT_RUN_LEASE_S`, marks the run `interrupted`, and appends an `error` ("Interrupted: …") and a `done` event (wire status `failed`, until `interrupted` is added to `@studio/agent-protocol`). The user resumes by sending the message again: the session is rebuilt from the stored transcript (everything up to the last completed message) on whichever replica gets it. A replica notices when another one changed a session it has cached (a revision counter) and rebuilds it.

**Shutdown (SIGTERM).** `/readyz` fails at once, new runs get 503 (everything else is still served), in-flight runs get `AGENT_SHUTDOWN_GRACE_S` (default 100, under the pod's 120 s) to finish; the rest are ended as interrupted, this pod's Daytona sandboxes are stopped (disk kept), and the process exits. SSE readers on this pod reconnect to another replica with `Last-Event-ID`.

Not shared across replicas yet: artifact files (`/v1/artifacts/:id` is dev-only; production uses object-store URLs later) and the dataset snapshot, which the Studio sends with every message anyway.

## Settings for deployment

| Env | Default | Meaning |
|---|---|---|
| `AGENT_HOST` / `AGENT_PORT` | `127.0.0.1` / `8100` | listen address; `0.0.0.0` in containers |
| `AGENT_STORE` | `file` | `file` (dev, `.data/`) or `postgres` |
| `AGENT_DATABASE_URL` | – | Postgres URL; required with `AGENT_STORE=postgres` |
| `AGENT_DATABASE_SCHEMA` | `public` | Postgres schema for the agent tables |
| `AGENT_AUTO_MIGRATE` | `false` | apply the schema at startup (dev/compose) |
| `AGENT_EVENT_BUS` | `memory` | `memory` (one process) or `redis` |
| `AGENT_REDIS_URL` | – | Redis URL; required with `AGENT_EVENT_BUS=redis` |
| `AGENT_RUN_STREAM_MAXLEN` | `5000` | approximate events kept per run stream |
| `AGENT_RUN_STREAM_TTL_S` | `86400` | run stream lifetime after its last event |
| `AGENT_RUN_LEASE_S` | `30` | heartbeat age after which a run counts as interrupted |
| `AGENT_RUN_HEARTBEAT_S` | `10` | heartbeat interval (capped at half the lease) |
| `AGENT_INBOX_POLL_MS` | `1000` | fallback poll for answers stored by other replicas (Redis bus only) |
| `AGENT_REPLICA_ID` | `$HOSTNAME-<random>` | this process's id in run records (unique per process) |
| `AGENT_SHUTDOWN_GRACE_S` | `100` | SIGTERM drain time for in-flight runs |
| `SWEEPER_ENABLED` | `true` | in-process Daytona sweeper (turn off when the CronJob runs) |
| `AGENT_DATA_DIR` | `apps/agent/.data` | file store, pi auth/agent dir, artifacts; in a read-only container use a path under `/tmp` |
| `AGENT_API_URL` | – | apps/api base URL; outgoing calls there (and to `AGENT_STUDIO_URL`) carry `traceparent` and `x-request-id` |
| `GIT_SHA` | – | build arg, served by `/version` and logged as `git_sha` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | – | export traces if the OpenTelemetry SDK packages are installed (see `packages/observability-ts/src/otel.ts`) |

Config is validated at startup; on error the process exits listing the key names (never values). Logs are JSON on stdout with `service`, `version`, `request_id` and `trace_id`; probes and `/version` are not access-logged.

## Profiles

The client picks a profile by name; the service decides its tools (`src/agent/profiles.ts`).

| Profile | Tools | Kernel token scopes |
|---|---|---|
| `assistant` | dataset reads, cards | none |
| `environment-designer` | + environment client tools | none |
| `coder` | + Daytona sandbox (needs Daytona) | none |
| `builder` | builder tools (`inspect_workspace`, `list_capabilities`, `search_plugins`, `inspect_plugin`, `plan_plugin_change`, `stage_plugin`, `request_install_approval`, `activate_plugin`, `configure_plugin`, `disable_plugin`, `rollback_plugin`) + environment client tools (no `run_command`); with Daytona, also `create_plugin_sandbox`, `run_plugin_checks`, `build_plugin_artifact` and file tools confined to `/home/daytona/plugin` | `plugins.read`, `plugins.manage`, `plugins.author` |
| `task` | `list_assets`, `invoke_capability`, `create_job`, `get_job_status`, `list_annotations`, `export_dataset`; dataset versioning: `dataset_branch`, `dataset_commit`, `dataset_diff`, `dataset_open_review` (own `work/agent-*` branch only; no approve or merge) | `assets.read`, `assets.write`, `annotations.read`, `commands.invoke`, `versioning.read`, `versioning.write`, `versioning.review`, `versioning.checkout` |

Builder and task tools call `apps/api` (`AGENT_KERNEL_URL`) with a token the Studio mints for the
session's workspace and sends as `kernelToken` with each message. The workspace and principal come
from that token, never from tool arguments. No agent token carries `plugins.approve`: installs are
approved by the user in the Studio's install review, which `request_install_approval` opens through
the approval broker (`approval.detail.kind = "plugin-install"`).

Policy (`src/tools/policy.ts`): `stage_plugin`, `create_plugin_sandbox` and `build_plugin_artifact`
are refused unless the user's own message in this run asks for a plugin change. Plugin skills and
READMEs arrive in `<untrusted_plugin_content>` and can't authorise anything (docs/plugins.md §14 #4).
Activating, configuring, disabling, rolling back and gateway runs ask first.

Runtime names (sandbox labels and name prefix, env vars, log service name, the display name in
prompts) come from `schemas/naming.json` (`src/naming.ts`).

## Layout

| Path | What |
|---|---|
| `src/agent/` | session factory (no host discovery, no pi built-ins), profiles, `ModelRuntime` + scripted model, prompts |
| `src/tools/` | `dataset` (server), `client` (browser bridge), `sandbox` (Daytona), `kernel` (builder, task and plugin-build tools over apps/api), `policy` (approval matrix + budgets) |
| `src/sandbox/` | Daytona client and errors, per-session manager, ops, exec, search, snapshot, sweeper, egress probe |
| `src/runtime/` | sessions (registry, persistence through the store), runs, event projection + replay buffer, approvals |
| `src/store/`, `src/bus/`, `src/cluster/` | `SessionStore` (file, Postgres + migrations), `RunEventBus` (memory, Redis Streams), `RunCoordinator` (run leases, inputs across replicas, event forwarding) |
| `src/http/` | service routes and conventions (`/healthz`, `/readyz`, `/version`, request ids, access log), the SSE route |
| `scripts/` | `build`, `migrate`, `sweep`, `snapshot`, `smoke` |
| `test/unit`, `test/live` | vitest; `test/unit/fixtures/pi-events.jsonl` is a recorded pi event stream |

## Rotating secrets

- **Daytona:** create a new key in the Daytona dashboard (Keys), update `secrets/daytona.env`, restart, then revoke the old key. The current key is shared with another project (see `secrets/README.md`).
- **Model keys:** update `secrets/models.env` (or the real env) and restart.
- **Service token:** delete `secrets/agent.env` and restart the service and the Vite dev server; a new one is generated.

## Upgrading pi or the Daytona SDK

Versions are pinned exactly. Follow the checklist in [`docs/agent.md` §17](../../docs/agent.md): read the changelogs, diff `createAgentSession` / `AgentSessionEvent` / `*Operations` / `ToolCallEvent`, re-record the event fixture if the stream changed, rerun unit, live, smoke and e2e, and check `@daytona/pi` for fixes worth porting (keep [`NOTICE`](NOTICE)).
