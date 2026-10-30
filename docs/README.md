# Docs

| Doc | What it covers |
|---|---|
| [`product.md`](product.md) | What the product is: users, data types, the Studio, the backend split (was `inkling.md` at the root). |
| [`ui.md`](ui.md) | UI rules: layout, provenance colours, saving states, keyboard. |
| [`modules.md`](modules.md) | The modular Studio: environments, modules (a plugin's UI half), contributions, presets. |
| [`modules-reference.md`](modules-reference.md) | Generated reference of every contribution (`pnpm emit:schemas`). Don't edit by hand. |
| [`plugins.md`](plugins.md) | Plugin infrastructure: manifests, kernel, control plane, workers, agent authoring, security. |
| [`agent.md`](agent.md) | The agent runtime (`apps/agent`): pi, Daytona sandboxes, tools, approvals, events. |
| [`versioning.md`](versioning.md) | Dataset versioning (`apps/versioning`): branches, commits, reviews, merges. |
| [`running.md`](running.md) | Three ways to run the product: dev servers, the compose stack, a local Kubernetes cluster. |
| [`adr/`](adr/) | Architecture decisions. [`0001`](adr/0001-monorepo-layout.md): the monorepo layout. |

## Repo map

```text
.
├── apps/            DEPLOYABLES: one Dockerfile, one k8s Deployment each, scaled independently
│   ├── web/         Studio SPA (static files behind nginx in production)
│   ├── api/         Python kernel + plugin control plane (FastAPI)
│   ├── agent/       Node agent runtime (pi + Daytona sandboxes)
│   ├── worker/      Python plugin job runner (scales on queue depth)
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
3. `plugins/*/ui` imports only `plugin-ui-sdk`, `plugin-contracts`, `studio-ui` and
   `studio-renderers` (and other plugins' `manifest.ts` / `public.ts`). A plugin's Python
   imports only `studio_plugin_sdk`.

## Old paths

`todo/todo1.md`, `todo/todo2.md` and older plans cite files where they used to be:

| Old path | New path |
|---|---|
| `inkling.md` | `docs/product.md` |
| `ui.md`, `agent.md`, `plugins.md`, `versioning.md` | `docs/ui.md`, `docs/agent.md`, `docs/plugins.md`, `docs/versioning.md` |
| `scripts/fetch-seeds.py`, `scripts/build-registry.mjs`, `scripts/rename-namespace.mjs` | `tools/…` |
| `apps/web/scripts/check-boundaries.mjs` (+ `boundaries-allowlist.json`) | `tools/check-boundaries.mjs` (+ `tools/boundaries-allowlist.json`), now with the repo-wide rules |
| `apps/web/scripts/mcp.mjs` | `apps/mcp/src/main.ts` (`@studio/mcp`, `pnpm mcp`) |
| `apps/web/e2e/agent_test.py`, `apps/web/e2e/plugins_test.py`, `e2e/fixtures/agent-script.json` | `tests/e2e/…` |
| package `web` | `@studio/web` |
| `apps/api/uv.lock`, `apps/worker/uv.lock`, `packages/plugin-sdk-py/uv.lock` | one root `uv.lock` (uv workspace); plugins keep their own |
