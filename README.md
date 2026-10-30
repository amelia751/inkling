# Inkling

A studio for viewing, annotating and exporting medical and scientific data: images, volumes, cine, video, time series, whole-slide images and text. It has an AI agent that can use the studio's tools and run code in sandboxes, and a plugin system so new data types, tools and models can be added without touching the core.

This is a monorepo. Everything (web app, backend services, agent, plugins, shared libraries, infrastructure) lives here and is built with one set of tools.

> The product name lives in exactly one place, the naming config (`packages/plugin-contracts/src/naming.ts`, exported as `schemas/naming.json`). Code and new files use brand-free names (`@studio/*`), so the product can be renamed by changing that config and running `tools/rename-namespace.mjs`.

---

## Layout

```text
.
├── apps/            deployable services, each with its own image and scaled independently
│   ├── web/         the Studio UI (React SPA)
│   ├── api/         kernel + plugin control plane (Python, FastAPI)
│   ├── agent/       AI agent runtime (Node, pi + Daytona sandboxes)
│   ├── worker/      runs plugin jobs (Python)
│   ├── versioning/  dataset versioning: branches, commits, reviews, merges (Go)
│   └── mcp/         MCP server exposing Studio tools to outside agents
├── plugins/         first-party plugins (UI + optional worker + manifest)
├── packages/        shared libraries, imported but never deployed alone
├── registry/        workspace presets and the plugin index
├── schemas/         JSON Schemas, the cross-language source of truth
├── infra/           Docker, docker-compose, Kubernetes (Kustomize)
├── tools/           repo-wide scripts (seeds, boundary checks, codegen, scaffolding)
├── tests/e2e/       end-to-end tests that span several services
├── docs/            product, UI, agent and plugin design docs, ADRs
├── todo/            implementation plans
├── secrets/         local dev secrets (git-ignored except templates)
├── seed-data/       local sample datasets (git-ignored, fetched by script)
└── .github/         CI/CD workflows
```

### Three import rules

`tools/check-boundaries.mjs` (TypeScript) and `import-linter` (Python) enforce these in CI:

1. **`apps/*` never import each other.** They talk over HTTP and events only, so each one can be deployed and scaled on its own.
2. **`packages/*` never import from `apps/*` or `plugins/*`.**
3. **Plugins use only the SDKs.** `plugins/*/ui` imports only `plugin-ui-sdk`, `plugin-contracts`, `studio-ui` and `studio-renderers`. `plugins/*/worker` imports only `plugin-sdk`.

---

## `apps/`: deployable services

Each app has a `Dockerfile` (built from the repo root), a `/healthz`, `/readyz` and `/version` endpoint, and a matching folder in `infra/k8s/base/`. Apps read config only from environment variables. Local `secrets/*.env` files are a dev convenience on top.

### `apps/web`: the Studio (`@studio/web`)
React + Vite single-page app. In production it's static files served by nginx. Runtime settings come from a mounted `/config.json`, so one image works in every stage (dev, staging, prod).

| Path | What it is |
|---|---|
| `src/studio/` | The shell: routes, layout, stores, top bar, panels frame, file browser. |
| `src/studio/core/` | Built-in Studio contributions every workspace has: files, labels, select/pan tools, AI panel. Not a plugin. |
| `src/extension-host/` | Loads plugins and turns them into a running Studio: registry (available vs active), resolver, runtime activate/deactivate, commands, `when` clauses, catalogue for the agent, command gateway client. |
| `src/extension-host/bundled.ts` | The composition root: the list of first-party plugins compiled into this build. The only file that imports plugins. |
| `src/extension-host/agent-panels/` | Hosts agent-generated UI: declarative panels (tier 2) and the sandboxed iframe (tier 3). |
| `e2e/` | Web-only Playwright tests (Python), with a harness and fixtures. |
| `dev/seed-server.ts` | Zero-infra dev mode that serves `seed-data/` straight from disk. |

### `apps/api`: kernel and control plane (`@studio/api`, Python package `studio_api`)
FastAPI + pydantic v2 + SQLAlchemy/Alembic on Postgres. Stateless: blobs go to object storage, jobs and events go to Redis.

| Path | What it is |
|---|---|
| `src/studio_api/kernel/` | The stable core every plugin builds on: assets, annotations, workspaces, the **command gateway** (one entry point for every tool call, with permission checks and audit), jobs, events, the **secrets broker** (plugins never see raw keys), audit log. |
| `src/studio_api/plugins/` | Control plane: plugin registry, dependency and compatibility resolver, installer state machine (`requested → resolved → reviewed → installed → active`), artifact builder for agent-authored plugins. |
| `src/studio_api/routes/` | HTTP routes. The OpenAPI spec generates `packages/api-client`. |
| `migrations/` | Alembic migrations, run by the `api-migrate` Kubernetes Job before each deploy. |

### `apps/agent`: AI agent runtime (`@studio/agent`)
Node 24 service built on the pi coding agent (`@earendil-works/pi-coding-agent`). Code it runs goes into Daytona sandboxes, never into our own pods.

| Path | What it is |
|---|---|
| `src/agent/` | Model registry, agent **profiles** (Studio task agent, coder, plugin builder), session factory, system prompts. |
| `src/tools/` | Tools grouped by where they run. **Sandbox** tools (bash, read/write/edit, find/grep in Daytona). **Kernel** tools (Studio and plugin commands through the `apps/api` gateway). **Client** tools (run in the user's browser). **Policy** (which calls need user approval). |
| `src/sandbox/` | Daytona integration: client, defaults (resources, auto-stop, labels), snapshot builder, lifecycle manager, exec, ripgrep search, sweeper for leaked sandboxes. |
| `src/runtime/` | Sessions, runs, approvals and the event stream. State is in Postgres and Redis Streams, so any replica can stream or resume a run (`Last-Event-ID`). |
| `src/main.ts` | Hono HTTP API with SSE run streams, authenticated by a service token. |
| `sandbox-image/` | Python requirements baked into the Daytona snapshot. |
| `scripts/` | `smoke` (live end-to-end check), `sweep` (delete orphaned sandboxes, also a CronJob), `snapshot` (build or refresh the sandbox snapshot). |
| `test/unit`, `test/live` | Offline unit tests, and live Daytona tests that are skipped without a key. |
| `NOTICE` | Apache-2.0 attribution for code adapted from `@daytona/pi`. Keep it. |

### `apps/worker`: plugin job runner (`@studio/worker`)
Python process that pulls jobs from the queue and runs plugin tools (for example segmentation inference) through `plugin-sdk`. It acks and retries jobs and enforces resource budgets. All first-party `plugins/*/worker` packages are installed in one image. Kubernetes scales it on queue depth with KEDA, down to zero when idle.

### `apps/mcp`: MCP server (`@studio/mcp`)
Exposes the Studio environment tools (catalogue, get/validate/patch an environment) over the Model Context Protocol (stdio), so outside agents (Claude Desktop, Cursor and so on) can drive the Studio. It calls a running Studio over HTTP and never imports another app. The catalogue and validation routes still live in the web dev server (they run the TypeScript registry); see `apps/mcp/README.md`.

### `apps/versioning`: dataset versioning (`@studio/versioning`)
Go service that turns datasets into Git-like repositories: branches, commits, review requests, semantic diffs, three-way merges and releases. Postgres for metadata, object storage for content. Design: `docs/versioning.md`; API: `schemas/versioning/openapi.yaml`. Only `apps/api` (and its workers) call it.

---

## `plugins/`: first-party plugins

Each folder is one plugin. Plugins are extensions, not deployables, which is why they're not under `apps/`. Their UI is compiled into `apps/web` and their Python code runs inside `apps/worker`.

```text
plugins/<name>/
├── plugin.yaml       manifest: id, version, compatibility, capabilities, runtime, providers,
│                     UI contributions, skills, permissions, resources, event subscriptions
├── ui/               viewers, tools, panels, commands (TypeScript/React, trusted first-party code)
│   └── contributions.json  declarative UI rendered by trusted renderers (what third-party/generated plugins ship)
├── package.json      the plugin's pnpm package (exports ./ui/*)
├── pyproject.toml    optional Python worker: src/<package>/ tool implementations and providers,
├── uv.lock           with its own lock (each plugin version gets its own locked environment)
├── skills/           instructions the agent loads when the plugin is active
└── tests/
```

| Plugin | What it adds |
|---|---|
| `_template/` | Starting point for new plugins. `node tools/new-plugin.mjs <name>` copies it, and so does the agent's plugin builder. |
| `image2d/` | 2-D images and DICOM (X-ray, CT slices): window/level, measurements, 2-D annotations. |
| `volume/` | 3-D volumes (MRI/CT): MPR views, 3-D rendering, segmentation masks. |
| `cine/` | 4-D / cine loops (for example cardiac MRI) with frame playback. |
| `cardiac-metrics/` | Cardiac measurements on top of `cine` (volumes, ejection fraction). |
| `timeseries/` | Waveforms and signals (ECG), with interval and event annotations. |
| `video/` | Video (for example endoscopy), with frame-accurate segments and labels. |
| `wsi/` | Whole-slide pathology images (OpenSeadragon), with region annotations. |
| `text-spans/` | Text documents with span labelling. |
| `dicom-export/` | DICOM export of annotations and masks (SEG/SR). |
| `segmentation/` | Reference worker plugin: mask proposals from SAM-style providers (mock, Meta SAM, local SAM), reviewed in the `mask-review` renderer. |

---

## `packages/`: shared libraries

| Package | Language | What it is |
|---|---|---|
| `plugin-contracts/` | TS | Canonical types and zod schemas: environment spec, annotations, geometries, `plugin.yaml`, UI contributions, and the **naming config**. Emits `schemas/`. |
| `plugin-ui-sdk/` | TS | All a plugin's UI may import: `defineModule`, contribution types, `when` clause types, host API hooks (`useHost`, `assetUrl`, selection, annotations). |
| `studio-ui/` | TS | Presentational building blocks: shadcn/ui components, icons, `cn` and other utils. No app state. |
| `studio-renderers/` | TS | Heavy shared viewer engines plugins build on: cornerstone, 2-D overlay, timeline, viewport chrome, file IO, plus the trusted renderers declarative contributions map to (for example `mask-review`). |
| `api-client/` | TS | Typed client for `apps/api`, generated from its OpenAPI spec. Used by `web`, `agent` and `mcp`. |
| `plugin-sdk/` | Python | Worker-side SDK (`studio_plugin_sdk`): tool decorators, provider base classes, kernel client, job context, budgets. |
| `observability-ts/`, `observability-py/` | TS, Python | Structured JSON logging and OpenTelemetry setup, so a trace follows one user action from web through api, agent and worker. |

---

## Other root folders

| Folder | What it is |
|---|---|
| `registry/` | `presets/*.json`: workspace templates (radiology, pathology, cardiology, …) that pick plugins and layouts. `index.json`: the catalogue of installable plugins and versions the control plane resolves against. |
| `schemas/` | JSON Schemas emitted from `plugin-contracts`: environment, annotations, `plugin.yaml`, contributions, `naming.json`. Python pydantic models are generated from these, so TS and Python can't drift. |
| `infra/docker/` | Shared base images and `compose.yaml`. Profile `deps` runs Postgres, Redis and MinIO for local dev. Profile `full` runs every app image behind a router, like production. |
| `infra/k8s/` | Kustomize. `base/<app>/` holds the Deployment, Service, HPA/KEDA, PDB and ConfigMap for each app. `base/jobs/` holds DB migrations and the sandbox sweeper CronJob. `overlays/{dev,staging,prod}/` holds replicas, image digests, managed endpoints and NetworkPolicies. |
| `infra/terraform/` | Cloud resources (cluster, buckets, database), when there is a cloud. |
| `tools/` | `fetch-seeds.py` (download sample data, `--upload` to object storage), `check-boundaries.mjs` (import rules + no brand in code), `build-registry.mjs`, `rename-namespace.mjs`, `new-plugin.mjs`. (`apps/web/scripts/emit-schemas.mjs` writes `schemas/` because it runs the TS registry.) |
| `tests/e2e/` | Cross-service tests against the `full` compose stack: agent runs, plugin install/activate, segmentation jobs, and the `plugins.md` acceptance tests. |
| `docs/` | `product.md` (what the product is), `ui.md`, `agent.md`, `plugins.md`, `modules.md`, `running.md`, `adr/` (architecture decisions, starting with the monorepo layout). |
| `todo/` | The implementation plans: `todo1.md` (agent runtime), `todo2.md` (plugins), `todo3.md` (monorepo and scaling), `todo4.md` (dataset versioning). |
| `secrets/` | Local `.env` files per service (`daytona.env`, `models.env`, `agent.env`, …), mode 0600 and git-ignored. Only `README.md` and `*.example` are committed. In Kubernetes these become Secrets. |
| `seed-data/` | Sample datasets (X-ray, brain MRI, cardiac 4-D, ECG, pathology WSI, endoscopy video), fetched per their licences. Only `README.md` is committed. |
| `.github/workflows/` | `ci.yml` (affected typecheck/lint/test, boundaries, kubeconform, secret scan). `images.yml` (build and push only changed app images, with SBOM). `e2e.yml`. |
| `.worktrees/` | Git-ignored. Parallel branches checked out here (`git worktree add .worktrees/<branch>`), never as sibling folders. |

Root files:
- `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json` and `.nvmrc` set up the JS workspace (Node 24).
- `pyproject.toml`, `uv.lock` and `.python-version` set up the Python workspace (3.12).
- `AGENTS.md` holds the rules for AI coding agents working in this repo.

---

## Running it

```sh
pnpm install && uv sync                 # JS + Python dependencies
pnpm seeds                              # fetch sample data into seed-data/
cp secrets/*.example …                  # see secrets/README.md, fill in keys

pnpm infra:up                           # Postgres, Redis, MinIO in Docker
pnpm dev                                # web, api, agent, worker with hot reload

pnpm stack:up                           # whole product from images (prod-like)
kubectl apply -k infra/k8s/overlays/dev # on a local kind/k3d cluster
```

Checks:

```sh
pnpm affected        # typecheck, lint, test only what changed vs origin/main
pnpm test            # everything
pnpm agent:live      # live Daytona tests (needs secrets/daytona.env)
```

See `docs/running.md` for details, and `docs/plugins.md` to write a plugin.
