# Studio

A studio for viewing, annotating and exporting medical and scientific data: 2-D images and DICOM,
3-D volumes, cardiac cine, video, ECG and other signals, whole-slide pathology and text.

- **One Studio, many data types.** Each data type is a plugin. A JSON **environment** picks which
  plugins a Studio shows and how they're laid out, so a cardiology Studio and a pathology Studio
  are two environments, not two apps.
- **An AI assistant that proposes, never edits silently.** The agent can read the dataset, run the
  Studio's tools and run code in Daytona sandboxes. Everything it suggests arrives as a preview
  you approve or reject.
- **Plugins without touching the core.** New data types, tools, exporters and models are added as
  plugins: a `plugin.yaml`, a UI module and an optional Python worker. The agent can author them too.
- **Datasets as repositories.** Branches, commits, reviews and merges for annotations.

The product name lives in one file, `packages/contracts/src/naming.ts` (exported as
`schemas/naming.json`). Code uses the brand-free scope `@studio/*`, so renaming the product means
changing that file and running `tools/rename-namespace.mjs`.

## Quick start

You need Node 24 (`.nvmrc`), pnpm, uv and, for the backing services, Docker.

```sh
pnpm install && uv sync     # JS and Python dependencies
pnpm seeds                  # sample datasets into seed-data/ (git-ignored)
pnpm dev                    # web :5173, api :8000, agent :8100, worker, with hot reload
```

Open http://localhost:5173. The web app serves `seed-data/` straight from disk, and the API
falls back to SQLite and local files, so none of this needs Docker or a key.

To use the agent with a real model and sandboxes, add keys to `secrets/*.env` (start from the
`*.example` files; see [`secrets/README.md`](secrets/README.md)). Without keys the agent runs
scripted, with sandboxes off.

| Command | What it does |
|---|---|
| `pnpm infra:up` / `infra:down` | Postgres, Redis and S3 in Docker, for running `pnpm dev` against real backing services |
| `pnpm stack:up` / `stack:down` | the whole product from its images behind one router on :8080, like production |
| `pnpm agent`, `pnpm api`, `pnpm mcp` | one service on its own |
| `pnpm seeds:upload` | copy the sample data into object storage |

[`docs/running.md`](docs/running.md) covers all three ways to run it, including a local
Kubernetes cluster.

## What's in the repo

A pnpm + uv monorepo built with Turborepo.

```text
apps/        deployables: one Dockerfile and one Kubernetes Deployment each
plugins/     first-party plugins (UI module, plugin.yaml, optional Python worker)
packages/    shared libraries, never deployed alone
registry/    presets (ready-made environments) and the plugin index
schemas/     generated JSON Schemas, the source of truth across TS, Python and Go
infra/       Docker Compose and Kubernetes (Kustomize base + dev/staging/prod overlays)
tools/       repo-wide scripts: seeds, checks, codegen, renames, scaffolding
tests/e2e/   end-to-end tests that span several services
docs/        design docs, the glossary and architecture decisions
todo/        the current plan and BACKLOG.md; finished plans are in todo/done/
```

### Services (`apps/`)

| App | Stack | What it does |
|---|---|---|
| `web` | React 19, Vite, zustand, Tailwind + shadcn | The Studio and the **extension host**, which loads plugins and turns an environment into a running Studio |
| `api` | Python, FastAPI, Postgres | The kernel (assets, annotations, workspaces, the command gateway, jobs, audit) and the plugin control plane |
| `agent` | Node, pi agent, Daytona | AI agent runtime: profiles, tools, approvals, resumable SSE run streams |
| `worker` | Python | Runs plugin jobs, such as segmentation inference, from the queue; scales on queue depth |
| `versioning` | Go, Postgres | Dataset versioning: branches, commits, review requests, semantic diffs, merges |
| `mcp` | Node | MCP server, so outside agents (Claude Desktop, Cursor) can drive the Studio |

Every service is stateless, reads its config only from `STUDIO_<ROLE>_*` env vars, and serves
`/healthz`, `/readyz` and `/version`.

### Plugins (`plugins/`)

| Plugin | Adds |
|---|---|
| `image2d` | 2-D images and DICOM: window/level, measurements, boxes and polygons |
| `volume` | MRI and CT volumes: MPR views, 3-D rendering, segmentation masks |
| `cine` | cine loops such as cardiac MRI, with frame playback |
| `cardiac-metrics` | volumes and ejection fraction on top of `cine` |
| `timeseries` | ECG and other signals, with interval and event labels |
| `video` | video such as endoscopy, with frame-accurate segments |
| `wsi` | whole-slide pathology images, with region annotations and GeoJSON import/export |
| `text-spans` | span labelling in text documents |
| `dicom-export` | DICOM SEG/SR export of annotations and masks |
| `segmentation` | reference worker plugin: SAM-style mask proposals you review in the Studio |
| `_template` | the starting point for a new plugin (`node tools/new-plugin.mjs <name>`) |

### Libraries (`packages/`)

| Package | What it is |
|---|---|
| `contracts` | canonical types and zod schemas: environments, annotations, geometries, `plugin.yaml`, naming |
| `plugin-ui-sdk` | everything a plugin's UI may import: `defineModule`, contribution types, `useHost` |
| `ui` | shadcn components, icons and utilities, with no app state |
| `renderers` | shared viewer engines: Cornerstone, 2-D overlay, timeline, viewport chrome, file IO |
| `agent-protocol` | the agent's request and event types, shared by `web` and `agent` |
| `api-client` | typed client for `apps/api`, generated from its OpenAPI spec |
| `plugin-sdk` | the Python SDK for plugin workers (`studio_plugin_sdk`) |
| `observability-ts`, `observability-py` | structured logging and OpenTelemetry for every service |

## Rules worth knowing first

- **Apps never import each other.** They talk over HTTP and events. Shared code goes in
  `packages/`, which never imports `apps/` or `plugins/`.
- **Plugins only import the SDKs**: `@studio/plugin-ui-sdk`, `@studio/contracts`, `@studio/ui` and
  `@studio/renderers` in the UI, and `studio_plugin_sdk` in Python.
- **Names follow the folder.** `apps/<x>` and `packages/<x>` are `@studio/<x>` (`studio_<x>` in
  Python), `plugins/<x>` is `@studio/plugin-<x>`, images are `studio-<x>`.
- **Generated files aren't edited by hand**: `schemas/`, `docs/modules-reference.md` and the API
  client. Regenerate them with `pnpm emit:schemas`.

`pnpm check:boundaries`, `pnpm check:names` and `uv run lint-imports` enforce these in CI.
Words like Studio, module, kernel, environment and workspace have exactly one meaning each: see the
[glossary](docs/README.md#glossary).

## Checks

```sh
pnpm affected               # typecheck, lint and test only what changed vs origin/main
pnpm typecheck && pnpm test && pnpm lint
pnpm check:boundaries && pnpm check:names && pnpm check:python-imports
pnpm emit:schemas --check   # fails if generated schemas are stale
pnpm test:api               # API tests (pytest)
pnpm agent:live             # live Daytona tests (needs secrets/daytona.env)
```

The web app's Playwright e2e tests are in `apps/web/e2e`, and the cross-service ones are in
`tests/e2e`. [`AGENTS.md`](AGENTS.md) has the full list of checks to run before handing work back,
and the rules for AI coding agents working in this repo.

## Docs

| Doc | Covers |
|---|---|
| [`docs/README.md`](docs/README.md) | repo map, glossary, import rules |
| [`docs/product.md`](docs/product.md) | what the product is and who it's for |
| [`docs/ui.md`](docs/ui.md) | UI rules: layout, AI provenance colours, saving states, keyboard |
| [`docs/modules.md`](docs/modules.md) | environments, modules, contributions and presets |
| [`docs/plugins.md`](docs/plugins.md) | plugin manifests, the kernel, the control plane, workers and security |
| [`docs/agent.md`](docs/agent.md) | the agent runtime, sandboxes, tools and approvals |
| [`docs/versioning.md`](docs/versioning.md) | dataset versioning |
| [`docs/running.md`](docs/running.md) | dev servers, the compose stack and local Kubernetes |
| [`docs/adr/`](docs/adr/) | architecture decisions |
