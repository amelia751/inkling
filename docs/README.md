# Docs

| Doc | What it covers |
|---|---|
| [`product.md`](product.md) | What the product is: users, data types, the Studio, the backend split (was `inkling.md` at the root). |
| [`ux.md`](ux.md) | The product's information architecture: projects, their sections (Overview, Data (the Files drive), Explore, Datasets, Studio, Review, Activity) and the assistant. |
| [`ui.md`](ui.md) | Studio rules: layout, provenance colours, saving states, keyboard. |
| [`modules.md`](modules.md) | The modular Studio: environments, modules (a plugin's UI half), contributions, presets. |
| [`modules-reference.md`](modules-reference.md) | Generated reference of every contribution (`pnpm emit:schemas`). Don't edit by hand. |
| [`plugins.md`](plugins.md) | Plugin infrastructure: manifests, kernel, control plane, workers, agent authoring, security. |
| [`agent.md`](agent.md) | The agent runtime (`apps/agent`): pi, Daytona sandboxes, tools, approvals, events. |
| [`versioning.md`](versioning.md) | Dataset versioning (`apps/versioning`): branches, commits, reviews, merges. |
| [`running.md`](running.md) | Three ways to run the product: dev servers, the compose stack, a local Kubernetes cluster. |
| [`deployment-gcp.md`](deployment-gcp.md) | Google Cloud: the three projects, the customer-data boundary, what the agent may see, setup order. |
| [`adr/`](adr/) | Architecture decisions. [`0001`](adr/0001-monorepo-layout.md): the monorepo layout. |

## Glossary

One meaning per word, in docs, comments and code. When a doc needs the other sense, it uses
the word in the right-hand column.

| Term | Means | Not (say this instead) |
|---|---|---|
| **Studio** | the annotation editor for one task (`/projects/:projectId/studio/:taskId`). Its code is in `apps/web/src/studio/`, which also holds the rest of the web shell | the whole product (say the product name), the other project sections, or the code scope `@studio` |
| **Plugin** | an installable unit: `plugin.yaml` + optional `ui/` + optional worker code | — |
| **Module** | a plugin's UI half (`ModuleManifest`, `ui/manifest.ts`) | a plugin |
| **Extension host** | the registry, resolver, commands and catalogue in the web app (`apps/web/src/extension-host/`) | the API's plugin control plane |
| **API** (service) | `apps/api`, configured and deployed as `api` | the kernel |
| **Kernel** | the stable core inside the API (`studio_api/kernel/`, `plugins.md` §6) | the API service |
| **Environment** | a JSON spec of what one Studio shows (`environment.v1.json`) | a deployment target: dev, staging and prod are **stages** (`infra/k8s/overlays/<stage>`) |
| **Preset** | an environment shipped in `registry/presets/` | — |
| **Organization** | the account level: a person's or a team's projects and members (`organizations`, `org_id`). UI copy may call it "Workspace" | the kernel's workspace |
| **Project** | a durable research goal, the container for sources, datasets and tasks (`projects`) | a dataset, or a seed entry in `manifest.json` (each seed is one project, dataset and task with the same id) |
| **Workspace** | the kernel's per-project plugin activation and settings (`workspace.v1.json`). The kernel `Workspace` row is 1:1 with a project: `workspace_id` is the project id | the organization, even where UI copy says "Workspace"; a pnpm or uv workspace: say **repo workspace** |
| **Files** | the project's drive (todo7): one tree of folders and files per project (`DriveInfo.rootNodeId`, `source_nodes`), shown in the **Data** section. Bytes never change; names and folders do, through journaled, undoable `fs/ops` batches (`docs/files-api.md`) | a source (where a file came from); the Studio's Files tab (a task's items) |
| **Source** | an import's provenance: who brought which files in, when and from where (an upload or a seed, `sources`). Shown in the inspector and the Imports list; no longer a tree root since todo7 (each source became a top-level folder in Files) | the drive (say **Files**), or a dataset |
| **Trash** | where deleted files and folders wait 30 days before the `files.empty_trash` job purges them (`trashed_at`); Restore puts them back. Bytes are deleted only when nothing else uses them | a purge (Delete forever), or removing an import |
| **Import session** | one upload into a project: its files, the rights attestation and its state (`uploading → inspecting → needs_review` or `ready → imported`, or `failed`, `cancelled`) | an upload of a single file (that's an upload file) |
| **Dataset** | a logical set of items built from one or more sources: which source nodes, how they group, a preset | a source, a project or a version |
| **Collection** | a coherent group within a dataset (MRI studies, echo recordings). Not stored on its own yet: a dataset's definition says how items group | a folder in Files |
| **Task** | work on a dataset (classification, segmentation, event marking). It owns one environment and one annotation document, both keyed by `task_id` | a plugin job |
| **Proposal** | something the inspection worker or the assistant suggests (a group, relationship, mapping, dataset or task), with evidence and a strength. It changes nothing until a person confirms it | a confirmed relationship or dataset |
| **Version** | an immutable snapshot of a dataset in `apps/versioning` (Datasets › Versions) | an environment revision, or an annotation document save |

## Repo map

```text
.
├── apps/            DEPLOYABLES: one Dockerfile, one k8s Deployment each, scaled independently
│   ├── web/         the SPA: Home, projects and their sections, the Studio (static files behind nginx in production)
│   ├── api/         Python kernel (projects, sources, imports, proposals) + plugin control plane (FastAPI)
│   ├── agent/       Node agent runtime (pi + Daytona sandboxes)
│   ├── worker/      Python plugin job runner + built-in subscribers: de-id checks, inspection of uploads (scales on queue depth)
│   ├── versioning/  Go dataset versioning service
│   └── mcp/         MCP server (stdio) for outside agents
├── plugins/         EXTENSIONS, never deployed alone: plugin.yaml, ui/, optional Python worker, skills/
├── packages/        LIBRARIES, imported, never deployed
├── registry/        presets + index.json (the plugin catalogue)
├── schemas/         JSON Schemas, the cross-language source of truth
├── infra/           docker/ (compose), k8s/ (Kustomize base + overlays)
├── tools/           repo-wide scripts: fetch-seeds.py, check-boundaries.mjs, build-registry.mjs, rename-namespace.mjs
├── tests/e2e/       tests that span services (agent runs, plugin install + jobs)
├── docs/            this folder
├── todo/            implementation plans
├── secrets/         LOCAL DEV ONLY, git-ignored except README.md and *.example
└── seed-data/       LOCAL DEV ONLY, git-ignored; `pnpm seeds:upload` copies it to object storage
```

## Three import rules

`tools/check-boundaries.mjs` (TypeScript, and plugin Python) and `import-linter` (the root
`pyproject.toml`, `uv run lint-imports`) enforce them in CI:

1. `apps/*` never import each other. They talk over HTTP and events only, so each one can
   deploy and scale alone. Shared code goes in `packages/`.
2. `packages/*` never import from `apps/*` or `plugins/*`.
3. `plugins/*/ui` imports only `@studio/plugin-ui-sdk`, `@studio/contracts`, `@studio/ui` and
   `@studio/renderers` (and other plugins' `manifest.ts` / `public.ts`). A plugin's Python
   imports only `studio_plugin_sdk`.

## Old paths

`todo/done/todo1.md`, `todo/done/todo2.md` and older plans cite files where they used to be:

| Old path | New path |
|---|---|
| `inkling.md` | `docs/product.md` |
| `ui.md`, `agent.md`, `plugins.md`, `versioning.md` | `docs/ui.md`, `docs/agent.md`, `docs/plugins.md`, `docs/versioning.md` |
| `scripts/fetch-seeds.py`, `scripts/build-registry.mjs`, `scripts/rename-namespace.mjs` | `tools/…` |
| `apps/web/scripts/check-boundaries.mjs` (+ `boundaries-allowlist.json`) | `tools/check-boundaries.mjs`, now with the repo-wide rules (the empty allowlist was dropped in todo5) |
| `apps/web/scripts/mcp.mjs` | `apps/mcp/src/main.ts` (`@studio/mcp`, `pnpm mcp`) |
| `apps/web/e2e/agent_test.py`, `apps/web/e2e/plugins_test.py`, `e2e/fixtures/agent-script.json` | `tests/e2e/…` |
| package `web` | `@studio/web` |
| `apps/api/uv.lock`, `apps/worker/uv.lock`, `packages/plugin-sdk-py/uv.lock` | one root `uv.lock` (uv workspace); plugins keep their own |
