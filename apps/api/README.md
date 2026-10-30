# Kernel and control plane (`apps/api`)

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

Then run the web app against it: `INKLING_KERNEL=1 pnpm dev` (the env-var prefix comes from
`schemas/naming.json`). Vite proxies `/api/*` here, except `/api/catalog`,
`/api/environments` and `/api/agent`, which need the TypeScript registry.

| Area | Module | Routes |
|---|---|---|
| Request context (workspace, principal, correlation id, idempotency key; never from bodies) | `context.py` | header `X-Workspace-Id` (dev) or `Authorization: Bearer <session token>` |
| Assets: metadata, HMAC-signed URLs, derived artifacts | `kernel/assets.py` | `/api/v1/assets…`, `/api/v1/artifacts` |
| Annotations: canonical document, idempotent commits, review state, v1→v2 migration | `kernel/annotations.py` | `/api/annotations/:id` (the Studio's), `/api/v1/annotations…` |
| Command gateway | `kernel/gateway.py` | `POST /api/v1/commands` |
| Jobs (DB queue for `apps/worker`) | `kernel/jobs.py` | `/api/v1/jobs…`, `/api/v1/worker/…` |
| Events (outbox, rate limit, depth guard) | `kernel/events.py` | `POST /api/v1/events` |
| Secrets broker (encrypted at rest, proxied use) | `kernel/secrets.py` | `/api/v1/secrets…` |
| Workspace and audit | `plugins/installer.py`, `kernel/audit.py` | `/api/v1/workspaces/:id/state`, `/api/v1/audit` |
| Registry, resolver, installer, policy | `plugins/` | `/api/v1/plugins…`, `/api/v1/workspaces/:id/plugins/…` |
| Dataset versioning (todo4 Phase 6): apps/versioning behind the kernel, 60 s Ed25519 service JWTs, agent policy, audit | `kernel/versioning/`, `routes/versioning.py` | `/api/v1/versioning/status`, `/api/v1/datasets…`; commands `<ns>.versioning.*` |
| Built-in subscriptions (the worker's de-identification check) | `kernel/events.py`, `routes/worker.py` | `/api/v1/worker/subscriptions/{claim,ack}`, `/api/v1/worker/versioning/run` |

Contracts (`kernel/contracts/_generated/`) are generated from `schemas/*.json`, which
`pnpm emit:schemas` writes from `packages/plugin-contracts` (zod). Settings come from
`<envPrefix>API_*` env vars and `secrets/api.env` (`API_SECRET_KEY`).

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
