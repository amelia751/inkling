# API service (`apps/api`): kernel and plugin control plane

FastAPI + SQLAlchemy 2 + Alembic, Python 3.12, managed with `uv`. Implements the stable
kernel of `docs/plugins.md` §6 and the plugin control plane of §7 and §11.

```bash
cd apps/api
uv sync
uv run alembic upgrade head            # or let the app create tables on first start (dev)
uv run uvicorn studio_api.app:app --port 8000
uv run pytest
uv run python scripts/gen_contracts.py --check   # pydantic contracts match schemas/
```

Then run the web app against it: `INKLING_API_URL=http://127.0.0.1:8000 pnpm dev` (the env-var prefix comes from
`schemas/naming.json`). Vite proxies `/api/*` here, except `/api/catalog`,
`/api/environments` and `/api/agent`, which need the TypeScript registry.

| Area | Module | Routes |
|---|---|---|
| Request context (workspace, principal, correlation id, idempotency key; never from bodies) | `context.py` | header `X-Workspace-Id` (dev) or `Authorization: Bearer <session token>` |
| Assets: metadata, HMAC-signed URLs, derived artifacts | `kernel/assets.py` | `/api/v1/assets…`, `/api/v1/artifacts` |
| Annotations: canonical document, idempotent commits, review state, v1→v2 migration | `kernel/annotations.py` | `/api/annotations/:id` (the Studio's), `/api/v1/annotations…` |
| Command gateway | `kernel/gateway.py` | `POST /api/v1/commands` |
| Jobs (claimed by `apps/worker` through the JobQueue) | `kernel/jobs.py`, `kernel/queue.py` | `/api/v1/jobs…`, `/api/v1/worker/…` (claim, progress, complete, fail, release) |
| Events (outbox, rate limit, depth guard, EventBus) | `kernel/events.py`, `kernel/eventbus.py` | `POST /api/v1/events` |
| Secrets broker (encrypted at rest, proxied use) | `kernel/secrets.py` | `/api/v1/secrets…` |
| Workspace and audit | `plugins/installer.py`, `kernel/audit.py` | `/api/v1/workspaces/:id/state`, `/api/v1/audit` |
| Registry, resolver, installer, policy | `plugins/` | `/api/v1/plugins…`, `/api/v1/workspaces/:id/plugins/…`, `/api/v1/workspaces/:id/capabilities`, `/api/v1/plugins/:id/docs` |
| Artifact builder for agent-authored plugins (checks, digest, Ed25519 dev signature, private store, `trustTier: generated`, workspace-only) | `plugins/artifacts.py` | `POST /api/v1/plugins/artifacts[?dryRun=true&base=…]` (tarball body) |
| Dataset versioning (todo4 Phase 6): apps/versioning behind the kernel, 60 s Ed25519 service JWTs, agent policy, audit | `kernel/versioning/`, `routes/versioning.py` | `/api/v1/versioning/status`, `/api/v1/datasets…`; commands `<ns>.versioning.*` |
| Built-in subscriptions (the worker's de-identification check) | `kernel/events.py`, `routes/worker.py` | `/api/v1/worker/subscriptions/{claim,ack}`, `/api/v1/worker/versioning/run` |

| Service conventions: liveness, readiness (DB, Redis, BlobStore), version | `routes/ops.py` | `/healthz`, `/readyz`, `/version` (no auth, no access log) |
| Seed files and saved environments for the SPA (in production, and in dev whenever the kernel runs; shapes of `apps/web/dev/seed-server.ts`) | `routes/environments.py` | `/seed/*`, `/api/environments/:id[/history]`; todo10: `…/lockfile`, `…/readme`, `…/last-known-good`, `…/checks`, `…/rollback`, `…/audit` (`kernel/studio_defs.py`, docs/versioning.md §21); `POST /api/environments/validate` and `/api/catalog*` answer 501 (dev server only: they need the TypeScript registry, so the kernel stores environments without server-side validation) |

## Stateless deployment (todo/done/todo3.md E.2)

Every replica is interchangeable: state in the database, bytes in the BlobStore, job and
event hand-off behind interfaces. Dev needs none of it (SQLite, `seed-data/`, DB queue).

| Concern | Dev default | Cluster | Module |
|---|---|---|---|
| State | SQLite in `.data/` | `API_DATABASE_URL=postgresql+psycopg://…`, `API_CREATE_TABLES=0`, `alembic upgrade head` as a Job | `db.py`, `migrations/` |
| Blobs (seed assets, artifacts) | `BLOB_STORE=local`: `seed-data/`, `.data/` | `BLOB_STORE=s3` + `S3_ENDPOINT`/`S3_BUCKET` (keys = seed-data paths; derived data under `.data/`) | `blobstore.py` |
| Job queue | `JOB_QUEUE=sql`: DB scan, `FOR UPDATE SKIP LOCKED` on Postgres, conditional-UPDATE leases | `JOB_QUEUE=redis`: `<resourcePrefix>:jobs:ready` list (KEDA scales workers on its length), lease set + reaper | `kernel/queue.py` |
| Events | `EVENT_BUS=sql`: outbox scan | `EVENT_BUS=redis`: stream `<resourcePrefix>:events`, consumer group `kernel` | `kernel/eventbus.py` |
| Logs and traces | JSON on stdout (`INKLING_LOG_FORMAT=text` for humans) | + OpenTelemetry when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (`--extra otel`) | `packages/observability-py` |

Every setting and its default is in the docstring of `config.py`; a bad configuration
stops the process naming the missing or invalid keys (never their values). Seed data gets
into the bucket with `uv run tools/fetch-seeds.py --upload-only`. Tests for the Postgres,
Redis and S3 paths run when `<envPrefix>TEST_DATABASE_URL`, `<envPrefix>TEST_REDIS_URL`
and `<envPrefix>TEST_S3_ENDPOINT` (+ `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`) are set.

Contracts (`kernel/contracts/_generated/`) are generated from `schemas/*.json`, which
`pnpm emit:schemas` writes from `packages/contracts` (zod). Settings come from
`<envPrefix>API_*` env vars and `secrets/api.env` (`API_SECRET_KEY`).

Session-token scopes for the plugin routes: `plugins.read` (search, inspect, docs, workspace
plugins and capabilities), `plugins.manage` (plan, stage, low-risk activate, configure, disable,
rollback, reject), `plugins.author` (artifact builds) and `plugins.approve` (approve, grant). The
Studio mints agent tokens without `plugins.approve` (apps/agent README, Profiles), so an agent can
stage an install but only the user can approve it. Dev header identities have no scopes and may do
everything.

Generated artifacts live in `<data dir>/plugin-artifacts/<id>/<version>/` and are listed in
`<data dir>/registry-generated.json`; the dev signing key is `<data dir>/plugin-signing.key`.
`stage` re-digests the stored tree and verifies the signature; the install plan carries the code
diff against the template, the forked plugin or the previous version.

Dataset versioning is off until `<envPrefix>API_VERSIONING_URL` points at apps/versioning
(or is `memory:` for an in-process stand-in without Go). The API signs a 60 s JWT per call
with `.data/versioning-jwt.key` and writes the public half to `.data/versioning-jwks.json`
(generated on first use; override with `<envPrefix>API_VERSIONING_JWT_KEY_FILE` /
`_JWKS_FILE`); point the service's `<envPrefix>VERSIONING_JWT_PUBLIC_KEY_FILE` at the JWKS.
Tenant is `<envPrefix>API_VERSIONING_TENANT` (`default`), project the workspace. In dev,
`X-Dev-Principal: user:<name>` acts as another user. Run the e2e flows with
`tests/e2e/versioning/run.py`.

Set `<envPrefix>API_BUILTIN_MOCK_SEGMENT=1` to enable the kernel's built-in mock
`image.segment` provider (the Phase 4 exit path, without installing a plugin).
