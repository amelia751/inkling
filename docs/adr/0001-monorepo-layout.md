# ADR 0001: Monorepo layout that scales to Kubernetes

- Status: accepted (2026-10-30)
- Plan: `todo/done/todo3.md`

## Context

Work was split across three checkouts of the same repo (sibling git worktrees for parallel
agents). We want one checkout, and a layout where every deployable unit can be built,
configured and scaled on its own (Docker images, Kubernetes, autoscaling), without
disrupting the agent runtime (`todo1.md`) and plugin (`todo2.md`) work.

## Decisions

| # | Decision | Why |
|---|---|---|
| R1 | `plugins/` stays at the root, next to `apps/` and `packages/`; it does not go under `apps/`. | `apps/*` means "a thing we deploy and scale": one image, one Deployment. A plugin is a bundle (UI compiled into `apps/web`, an optional worker run by `apps/worker`, a manifest, skills). Mixing the two breaks the "one Dockerfile per `apps/*`" rule CI and Kubernetes rely on. |
| R2 | Parallel work uses worktrees **inside** the repo, in `.worktrees/<branch>` (git-ignored), never sibling folders in `~`. | Everything stays under one folder; cleanup is `git worktree prune`. |
| R3 | Turborepo for the task graph across TS and Python; pnpm workspaces for JS; a uv workspace for Python. Python apps get a small `package.json` whose scripts call `uv run …`. | `pnpm affected` (`turbo run … --filter=...[origin/main]`) runs only what a change affects. Nx would work but is heavier than needed. |
| R4 | Brand-free names: `@studio/*` packages, runtime names from the naming config (`packages/contracts/src/naming.ts` → `schemas/naming.json`). Docs drop the brand from file names (`studio.md` → `docs/product.md`). | A rename touches the naming config and `tools/rename-namespace.mjs`, nothing else. |
| R5 | Kustomize (`infra/k8s/base` + `overlays/{dev,staging,prod}`). Helm only if outsiders must install the product. | Plain, reviewable YAML; `kubectl apply -k` works anywhere. |
| R6 | Postgres for state, S3-compatible object storage for blobs (MinIO locally), Redis for the job queue and event fan-out, each behind an interface (`SessionStore`, `BlobStore`, `JobQueue`, `EventBus`). | The minimum that makes every service stateless and therefore horizontally scalable; NATS can replace Redis behind the same interface. |

## Consequences and deviations

- `pnpm-workspace.yaml` lists `plugins/*`, not `plugins/*/ui`: a plugin's `package.json`
  sits at the plugin root and exports `./ui/*`.
- Plugin Python packages are **not** uv workspace members. The worker gives every plugin
  version its own locked environment (`uv sync --locked --project plugins/<name>`), which
  needs a per-plugin `uv.lock`; a workspace would share one lock. Rule 3 for plugin Python is
  therefore checked by `tools/check-boundaries.mjs`, not import-linter.
- The catalogue and environment-validation routes (`/api/catalog*`,
  `/api/environments/validate`) run the TypeScript registry, so they stay in the web dev
  server. In production `apps/api` stores environments and the Studio validates them
  client-side.
- Env-var names in `infra/` carry the naming config's `envPrefix`; `tools/rename-namespace.mjs`
  rewrites them on a rename.
