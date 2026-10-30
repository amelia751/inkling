# One repo, one checkout: monorepo layout that can scale to Kubernetes

**Goal.**
1. Bring all work back into `/Users/anhlam/inkling`. Today it's split across three folders.
2. Settle a monorepo layout where every deployable unit can be built, configured and scaled on its own: Docker images, Kubernetes, autoscaling.
3. Keep it compatible with `todo1.md` (agent runtime) and `todo2.md` (plugins), which other agents are doing right now. This file never asks you to edit them.

## Status (2026-10-30)

Branch `todo3-monorepo` (`.worktrees/todo3`), with `main` at 38d0646 merged in (todo2 Phases 7–9, todo4 Phase 6, todo5's plan).

- **Phase A:** the sibling folders `../inkling-modular` and `../inkling-plugins` are gone, and their branches were merged earlier. `.worktrees/` and `.claude/worktrees/` are git-ignored, and `AGENTS.md` has "Parallel work". Branch cleanup and the push are below.
- **Phase B:** done. Two deviations: `versioning.md` also moved to `docs/`, and `builder_test.py` (added on `main`, spans web, api and agent) moved to `tests/e2e/`. `apps/web/dev/seed-server.ts` stays as the zero-infra dev mode.
- **Phase C:** done. Two deviations, both documented in their files:
  - `pnpm-workspace.yaml` lists `plugins/*` because a plugin's `package.json` sits at the plugin root.
  - Plugin workers aren't uv workspace members, because each keeps its own `uv.lock` for the worker's per-plugin environments.
- **Phase D:** done for `web`, `api`, `agent`, `worker`, `versioning` and `mcp`.
  - `pnpm stack:up` builds and runs everything from images.
  - All three overlays render, and kubeconform `-strict` passes 134/134 resources including the CRDs.
  - api → versioning JWTs: compose shares a `devtoken keygen` pair. In k8s, Secret `api-versioning-jwt` and ConfigMap `versioning-jwks` are created by `tools/versioning-keys.mjs` (`pnpm k8s:dev-keys`); no key is committed.
- **Phase E:** done.
  - agent: `SessionStore` (file|postgres), `RunEventBus` (memory|redis Streams), a run coordinator with leases, and SIGTERM drain.
  - api: `BlobStore` (local|s3), `JobQueue` (sql|redis), `EventBus` (sql|redis).
  - Every service: `/healthz`, `/readyz`, `/version`, JSON logs, `traceparent` propagation, config validated at startup.
  - `fetch-seeds.py --upload`.
- **Phase F:** `ci.yml`, `images.yml` and `e2e.yml` are written, but haven't run on GitHub yet (nothing pushed).
- **Phase G:** done.

Done-when, checked on 2026-10-30:
1. Yes, apart from the leftover in-repo worktrees listed under "What's left".
2. Yes, after two fixes: the turbo `dev` script now passes the environment through (`--env-mode=loose`; strict mode was dropping `AGENT_*`, `INKLING_*` and the model keys), and a worker pointed at a loopback kernel now uses the API's dev token. `pnpm dev` brings up web, api, agent and worker, all ready.
3. Yes.
4. Not run: no kind/k3d cluster here (the manifests are validated offline).
5. Yes in compose, with `--scale api=3 --scale agent=3 --scale worker=3`:
   - `tests/e2e/plugins_test.py` passes 8/8 and `builder_test.py` 9/9;
   - agent runs created on one replica stream and resume (`Last-Event-ID`) from the others.
6. The brand appears only where allowed, plus the env prefix in `infra/` (`tools/rename-namespace.mjs` rewrites it). todo5 Phase 4 tracks the rest.

### What's left

- Merge `todo3-monorepo` into `main` and push (needs the user's go-ahead).
- Delete the worktrees and branches that `main` already contains:
  - `.claude/worktrees/agent-*` (one is locked) and their `worktree-agent-*` branches;
  - `.worktrees/base`;
  - `conv-*`.
- `wip/main-daytona` has one commit that isn't on `main`. It's the pre-restructure WIP, already ported selectively. Delete it once the user agrees.
- Done-when 4: a kind or k3d run following `docs/running.md`, then `tests/e2e/versioning/chaos_test.py` against it (todo4 Phase 6).
- E.4: Daytona `otelEnabled` / OTLP export from the agent (moved from todo1 §9).
- First CI run on GitHub. `apps/versioning` lint needs `golangci-lint`; CI installs it, local machines may not have it.

---

## Why things are "in anhlam" today

`/Users/anhlam/inkling-modular` and `/Users/anhlam/inkling-plugins` are **not separate projects**. They are *git worktrees*: extra checkouts of the **same repo**, each on its own branch, placed next to the main folder so several agents could work in parallel.

| Folder | Branch | Who is using it | Uncommitted work in it |
|---|---|---|---|
| `/Users/anhlam/inkling` | `main` (at `8cff605`) | this repo's root | `apps/agent/` (Daytona layer), `secrets/`, `agent.md`, `plugins.md`, `todo/todo1-3.md`, the deleted `todo/todo.md`, and edits to old-layout files (`apps/web/src/viewers/*`, `e2e/harness.py`, `vite.config.ts`) |
| `/Users/anhlam/inkling-modular` | `modular-viewers` (at `750fa52`, ahead of `main`) | the `todo1.md` agent | its own copy of `apps/agent/` (derived from the one on `main`, has since diverged), web agent wiring, `apps/web/dev/agent/*` deleted, new `e2e/agent_test.py` |
| `/Users/anhlam/inkling-plugins` | `plugins` (at `750fa52`) | the `todo2.md` agent | `packages/plugin-contracts/`, many `apps/web` edits (`bundle.ts`, kits, scripts) |

So nothing has to be copied between folders by hand. The fix is to **commit each branch, merge the branches into `main`, and remove the extra worktrees** (Phase A). Folder moves happen inside the one repo after that (Phase B onward).

---

## 0. Decisions

| # | Question | Recommendation | Why |
|---|---|---|---|
| R1 | Should `plugins/` go under `apps/`? | **No. Keep `plugins/` at the root**, next to `apps/` and `packages/`. | `apps/*` means "a thing we deploy and scale": one image, one Kubernetes Deployment. A plugin isn't that. It's a bundle of a UI part (compiled into `apps/web`), an optional worker (run by `apps/worker`, or as its own image later), a manifest and skills. Putting plugins under `apps/` would mix deployables with extensions and break the "one Dockerfile per `apps/*`" rule CI and Kubernetes rely on. This also matches `plugins.md` and `todo2.md`. |
| R2 | Where do parallel agents work in future? | Worktrees go **inside** the repo, in `.worktrees/<branch>` (git-ignored), never as siblings in `~`. | Everything stays under `inkling/`, and cleanup is one `git worktree prune`. |
| R3 | Task runner | **Turborepo** for the task graph and caching across TS **and** Python. Python apps get a three-line `package.json` whose scripts call `uv run …`. Use **pnpm workspaces** for JS and a **uv workspace** for Python. | One `pnpm turbo run test --filter=...[origin/main]` runs only what a change affects. Nx is the alternative, but it's heavier than needed. |
| R4 | Names | Brand-free, as `todo2.md` D3 already decided: `@studio/*` for packages and apps, runtime names from the naming config. Rename `@inkling/agent` to `@studio/agent` once `todo1.md` is done. Docs drop the brand from file names too (`inkling.md` becomes `docs/product.md`). | A rename later touches only the naming config. |
| R5 | Kubernetes packaging | **Kustomize** (`infra/k8s/base` + `overlays/{dev,staging,prod}`) to start. Add a Helm chart only if someone outside the team must install the product. | Plain YAML that's easy to review. `kubectl apply -k` works anywhere. |
| R6 | Infra dependencies | **Postgres** (state), **S3-compatible object storage** (assets; MinIO locally), **Redis** (job queue and event fan-out, behind an interface so NATS can replace it). | These are the minimum that make every service stateless and therefore horizontally scalable. |

---

## Phase A. Consolidate the three checkouts into one (blocking; coordinate with the two agents)

Do this when the `todo1.md` and `todo2.md` agents reach a stopping point. Ask them to commit, or pause them. **Never run `git worktree remove` while an agent is still writing in that folder.**

### A.1 Safety checks first
- [ ] In each of the three folders, confirm secrets are ignored before any `git add -A`:
  ```sh
  git check-ignore -v secrets/daytona.env secrets/agent.env   # must print a matching .gitignore rule
  git status --short secrets/                                  # only README.md / *.example may show
  ```
  `inkling-modular` has a modified `.gitignore`. Check it still contains the `secrets/*` rules from `main`.
- [ ] Record what's uncommitted, for the merge notes: `git -C <folder> status --short > /tmp/<branch>-status.txt`.

### A.2 Commit each branch where it is
- [ ] `/Users/anhlam/inkling` (main): move the uncommitted work onto a branch so `main` stays mergeable:
  ```sh
  git switch -c wip/main-daytona && git add -A && git commit -m "WIP: Daytona layer, secrets templates, docs, todos"
  ```
- [ ] `/Users/anhlam/inkling-modular`: `git add -A && git commit -m "todo1: agent runtime + web wiring"` (or let the todo1 agent commit).
- [ ] `/Users/anhlam/inkling-plugins`: `git add -A && git commit -m "todo2: plugin layout, phase N"` (or let the todo2 agent commit).

### A.3 Merge into `main`, in this order
1. [ ] `main` ← `modular-viewers`. `main` is an ancestor (`merge-base` = `8cff605`), so it's a fast-forward:
   `git switch main && git merge --ff-only modular-viewers`.
2. [ ] `main` ← `plugins`: `git merge plugins`. Both branched from `750fa52`. Expect conflicts in `apps/web/package.json`, `vite.config.ts`, `pnpm-lock.yaml` and `pnpm-workspace.yaml`.
   - Resolve manifests by hand, then regenerate the lockfile with `pnpm install`. Never hand-merge `pnpm-lock.yaml`.
3. [ ] `main` ← `wip/main-daytona`, **selectively**. This branch is on the pre-modular layout, so don't merge it wholesale:
   - [ ] Take as-is: `secrets/README.md`, `secrets/*.example`, `agent.md`, `plugins.md`, `todo/todo1.md`, `todo/todo2.md`, `todo/todo3.md`, root `package.json` agent scripts, the `pnpm-workspace.yaml` `allowBuilds` and `minimumReleaseAgeExclude` entries.
     `git checkout wip/main-daytona -- <paths>`.
   - [ ] `apps/agent/`: the `modular-viewers` copy wins, because the todo1 agent kept working on it. Copy over only what that copy lacks, `apps/agent/README.md` and `apps/agent/NOTICE` (the Apache attribution for `@daytona/pi`; it must stay).
     Check: `diff -rq` against the `wip` copy, excluding `node_modules` and `.data`.
   - [ ] The old-layout edits (`apps/web/src/viewers/*`, `components/studio/FormatExports.tsx`, `lib/shortcuts.ts`, `e2e/harness.py`, `vite.config.ts`): run `git diff 8cff605 wip/main-daytona -- <file>` for each. If the change is already in `modular-viewers` (it usually is), drop it. Otherwise port it by hand into the new module location and note it in the merge commit.
   - [ ] `todo/todo.md` is deleted on that branch. Confirm the deletion is intended before keeping it.
4. [ ] Run the full baseline on merged `main`: `pnpm install && pnpm -r typecheck && pnpm -r test`, then `apps/web` lint, `check-boundaries`, `check-icons`, e2e, and `pnpm agent:test`. Fix before going further.

### A.4 Remove the sibling folders
- [ ] Secrets: for each file in `../inkling-*/secrets/`, compare it with the root copy **without printing values** (`shasum -a 256 secrets/* ../inkling-modular/secrets/*`). Copy any missing file into `/Users/anhlam/inkling/secrets/` with mode `0600`.
- [ ] `git worktree remove ../inkling-modular && git worktree remove ../inkling-plugins && git worktree prune`.
- [ ] Delete merged branches: `git branch --merged main`, then `git branch -d modular-viewers plugins wip/main-daytona` and any `conv-*` that shows as merged. Ask the user before deleting unmerged `conv-*` branches.
- [ ] `git push origin main` and `git push origin --delete modular-viewers` (once the user agrees).
- [ ] `.gitignore`: add `.worktrees/` (R2). Add a "Parallel work" section to `AGENTS.md` with `git worktree add .worktrees/<branch> -b <branch>`.

**Done when:** `git worktree list` shows one line, and `ls /Users/anhlam | rg inkling` shows only `inkling`.

---

## Phase B. Target layout

`todo2.md` Phase 1 already creates `packages/`, `plugins/`, `registry/` and `schemas/` at the root. This plan **keeps those exactly** and adds what deployment and scaling need.

```text
inkling/                         # repo root (the folder name is the only place the brand has to live)
├── apps/                        # DEPLOYABLES: one Dockerfile each, one k8s Deployment each, scaled independently
│   ├── web/                     #   SPA → static files served by nginx/CDN; no server code in production
│   ├── api/                     #   Python FastAPI: kernel + control plane (todo2 Phases 4–5)
│   ├── agent/                   #   Node: pi runtime + Daytona sandboxes (todo1)
│   ├── worker/                  #   Python: plugin worker host, scales on queue depth (todo2 Phase 6)
│   └── mcp/                     #   (later) MCP server, was apps/web/scripts/mcp.mjs
├── plugins/                     # EXTENSIONS (R1): never deployed on their own in v1
│   └── <name>/
│       ├── plugin.yaml          #   manifest (todo2 Phase 2)
│       ├── ui/                  #   compiled into apps/web
│       ├── worker/              #   optional Python package, loaded by apps/worker
│       ├── skills/  tests/
├── packages/                    # LIBRARIES: imported, never deployed
│   ├── plugin-contracts/  plugin-ui-sdk/  studio-ui/  studio-renderers/   # from todo2
│   ├── plugin-sdk-py/           #   from todo2 Phase 6
│   ├── api-client/              #   generated TS client for apps/api (OpenAPI), used by web and agent
│   └── observability-py/ observability-ts/   # logging/tracing setup shared by services (Phase E)
├── registry/                    # presets + index.json (todo2)
├── schemas/                     # JSON Schemas, the cross-language source of truth (todo2)
├── infra/
│   ├── docker/                  #   shared base images + compose.yaml (local full stack)
│   ├── k8s/
│   │   ├── base/<app>/          #   deployment, service, hpa, pdb, configmap, serviceaccount
│   │   ├── base/deps/           #   (dev only) postgres, redis, minio; managed services in prod
│   │   └── overlays/{dev,staging,prod}/
│   └── terraform/               #   (later) cluster, buckets, DB
├── tools/                       # repo-wide scripts: fetch-seeds.py, check-boundaries.mjs, rename-namespace.mjs, new-plugin
├── tests/e2e/                   # cross-service tests (web+api+agent+worker); apps/web/e2e keeps web-only tests
├── docs/                        # product.md (was inkling.md), ui.md, agent.md, plugins.md, modules.md, adr/
├── todo/                        # plans (stays at root)
├── secrets/                     # LOCAL DEV ONLY, git-ignored; k8s gets Secrets (Phase D.4)
├── seed-data/                   # LOCAL DEV ONLY, git-ignored; uploaded to object storage (Phase E.3)
├── .github/workflows/
├── AGENTS.md                    # stays at root (tools look for it there)
├── package.json  pnpm-workspace.yaml  turbo.json  tsconfig.base.json  .nvmrc
└── pyproject.toml  uv.lock  .python-version                          # uv workspace root
```

Three rules make this layout scale. `tools/check-boundaries.mjs` enforces them (Phase C.4):
1. `apps/*` never import each other. They talk over HTTP and events only, so each one can scale and deploy alone.
2. `packages/*` never import from `apps/*` or `plugins/*`.
3. `plugins/*/ui` imports only `plugin-ui-sdk`, `plugin-contracts`, `studio-ui` and `studio-renderers`. `plugins/*/worker` imports only `plugin-sdk-py`.

### B.1 File moves (after Phase A; mark each one done)

| From | To | When |
|---|---|---|
| `inkling.md` | `docs/product.md` | now |
| `ui.md`, `agent.md`, `plugins.md` | `docs/` | now. `todo1.md` and `todo2.md` cite them at the root, so add a line to `docs/README.md` mapping old paths to new. |
| `docs/modules.md` (from `modular-viewers`) | stays in `docs/` | — |
| `scripts/fetch-seeds.py` | `tools/fetch-seeds.py`, plus root `package.json` `seeds` script | now |
| `apps/web/scripts/check-boundaries.mjs` | `tools/check-boundaries.mjs`, extended to the repo-wide rules above | after todo2 Phase 1, which edits it |
| `apps/web/scripts/mcp.mjs` | `apps/mcp/src/main.ts`, its own package | after todo2 Phase 4 (it should call `apps/api`, not the web store) |
| `apps/web/dev/seed-server.ts` | replaced by `apps/api` asset routes. Keep the file as a dev fallback until then. | after todo2 Phase 4 |
| `apps/web/e2e/agent_test.py` and other tests that span services | `tests/e2e/` | after todo1 is done |
| `apps/agent/sandbox-image/` | stays (it's the agent's Daytona snapshot) | — |

Use `git mv` for every move so history follows. Then fix references with `rg -l '<old path>'` and update them, **except** in `todo/todo1.md` and `todo/todo2.md`.

---

## Phase C. Workspace tooling

### C.1 JS workspace
- [ ] `pnpm-workspace.yaml` `packages:` → `apps/*`, `packages/*`, `plugins/*/ui`. Python-only apps still need the `package.json` shim from C.3 so turbo sees them.
- [ ] Root `tsconfig.base.json`, if todo2 hasn't created it yet. Every TS package extends it.
- [ ] `.nvmrc` (`24`) at the root, and `devEngines` moved from `apps/agent/package.json` to the root `package.json`, so the whole repo uses Node 24.
- [ ] Package names: `web` → `@studio/web`, `@inkling/agent` → `@studio/agent` (R4). Update the `--filter` values in the root `package.json`.

### C.2 Python workspace (uv)
- [ ] Root `pyproject.toml`:
  ```toml
  [tool.uv.workspace]
  members = ["apps/api", "apps/worker", "packages/*-py", "plugins/*/worker"]
  ```
- [ ] Add a `.python-version` file containing `3.12`, and commit `uv.lock`.
- [ ] Shared dev tooling in the root `[dependency-groups] dev`: `ruff`, `pytest`, `pyright`, `import-linter`.
- [ ] `apps/web/e2e` uses Python (Playwright). Give it its own `pyproject.toml` workspace member so `uv run pytest apps/web/e2e` replaces whatever ad-hoc environment it uses today.

### C.3 Turborepo
- [ ] Add `turbo` as a root devDependency. `turbo.json` tasks: `build` (`dependsOn: ["^build"]`, `outputs: ["dist/**"]`), `typecheck`, `lint`, `test`, `dev` (`cache: false, persistent: true`), `e2e` (`cache: false`).
- [ ] Python apps (`apps/api`, `apps/worker`, `packages/plugin-sdk-py`) get a shim `package.json`, for example:
  ```json
  { "name": "@studio/api", "private": true,
    "scripts": { "dev": "uv run fastapi dev src/studio_api/main.py", "test": "uv run pytest", "lint": "uv run ruff check .", "typecheck": "uv run pyright" } }
  ```
- [ ] Root scripts:
  - `dev` = `turbo run dev --filter=@studio/web --filter=@studio/api --filter=@studio/agent --filter=@studio/worker`;
  - `test`, `typecheck`, `lint` = `turbo run <task>`;
  - `affected` = `turbo run test typecheck lint --filter=...[origin/main]`.

### C.4 Boundaries
- [ ] `tools/check-boundaries.mjs`: keep the rules `apps/web` has today, and add the three repo rules from Phase B for TS.
- [ ] For Python, add an `import-linter` contract in the root `pyproject.toml`: `apps.api` ↛ `apps.worker`, plugins → `studio_plugin_sdk` only.
- [ ] Both run in CI.

---

## Phase D. Containers and Kubernetes

### D.1 One Dockerfile per app (`apps/<app>/Dockerfile`, build context = repo root)
- [ ] **Node apps** (`agent`, `mcp`):
  - multi-stage, with `turbo prune @studio/<app> --docker`, then `pnpm install --frozen-lockfile`, then build;
  - final stage `node:24-slim`, non-root user, `NODE_ENV=production`, `CMD ["node","dist/main.js"]`. `apps/agent` needs a `build` step (tsc or tsup) instead of `tsx` in production.
- [ ] **web**:
  - build stage `turbo prune @studio/web` + `vite build`;
  - final stage `nginxinc/nginx-unprivileged` serving `dist/` with an SPA fallback.
  - **No env baked into the bundle.** At startup it fetches `/config.json`, mounted from a ConfigMap and holding the API base URL, agent URL, flags and naming display values. One image then works in every environment.
- [ ] **Python apps** (`api`, `worker`):
  - `ghcr.io/astral-sh/uv` builder running `uv sync --frozen --no-dev --package <app>`;
  - final stage `python:3.12-slim`, non-root.
  - `worker` also installs the first-party `plugins/*/worker` packages (one image for all bundled workers in v1).
- [ ] A root `.dockerignore`: `node_modules`, `.data`, `seed-data`, `secrets`, `.worktrees`, `**/e2e/.artifacts`, `.git`.
- [ ] Every image: a `HEALTHCHECK` (or the k8s probes from D.3), a read-only root filesystem with writable `/tmp` only, and labels `org.opencontainers.image.source` and `.revision`.

### D.2 Local full stack: `infra/docker/compose.yaml`
- [ ] Profile `deps` (the default): `postgres:17`, `redis:7`, `minio` plus a bucket-init job. `pnpm dev` runs the apps on the host against these.
- [ ] Profile `full`: the four app images from D.1 behind a `caddy`/`nginx` router with the same paths as the Ingress (D.3). It's used by `tests/e2e` and to reproduce production issues.
- [ ] Root scripts: `infra:up` = `docker compose -f infra/docker/compose.yaml --profile deps up -d`, and `stack:up` for the `full` profile.

### D.3 Kustomize (`infra/k8s`)
- [ ] `base/<app>/` for `web`, `api`, `agent`, `worker` (and `mcp` later) contains:
  - `Deployment`:
    - resources requests/limits, `readinessProbe` `/readyz` and `livenessProbe` `/healthz`;
    - `terminationGracePeriodSeconds` (agent 120 s, to drain SSE; worker 300 s, to finish jobs);
    - `securityContext` with non-root, read-only root filesystem and dropped capabilities;
    - `topologySpreadConstraints`.
  - `Service`, `ServiceAccount`, `PodDisruptionBudget` (`minAvailable: 1`), `ConfigMap` (non-secret env).
  - `HorizontalPodAutoscaler`:
    - CPU for `web`, `api` and `agent`;
    - **KEDA `ScaledObject` on Redis queue length** for `worker`, so it can scale to zero when idle.
- [ ] `base/ingress.yaml`: `/` → web, `/api` → api, `/agent` → agent. Agent SSE needs `proxy-buffering: off` and read timeouts of at least 1 h.
- [ ] `base/jobs/`:
  - `api-migrate` Job (Alembic `upgrade head`), run as a pre-deploy hook;
  - `agent-sweeper` CronJob running `apps/agent` `scripts/sweep.ts` every 15 min, **instead of** the in-process sweeper when there are several replicas. Otherwise each replica sweeps on its own; add a `SWEEPER_ENABLED=false` env in the Deployment.
- [ ] `overlays/dev`: one replica each, plus in-cluster postgres, redis and minio from `base/deps`.
- [ ] `overlays/staging` and `overlays/prod`: image tags pinned by digest, more replicas, managed Postgres/Redis/S3 endpoints from the ConfigMap, a `NetworkPolicy` (web can't reach the DB; only the agent can reach the Daytona API egress).
- [ ] Validate in CI: `kustomize build overlays/<env> | kubeconform -strict`.

### D.4 Secrets
- [ ] Local dev is unchanged: `secrets/*.env` (mode 0600, git-ignored), loaded by each app's `secrets.ts` or `settings.py` **only when the file exists**.
- [ ] Every app reads config **only from env vars**, with names from the naming config's `envPrefix` (todo2 0.1). Files are a dev convenience layered on top, never required.
- [ ] Kubernetes: one `Secret` per app (`<app>-secrets`), mounted as env.
  - Start with manually created Secrets, documented in `infra/k8s/README.md` with the key names only.
  - Move to External Secrets Operator (backed by the cloud secret manager) when staging exists.
  - Never commit a real Secret. CI fails on `kind: Secret` with `data:` under `infra/`.
- [ ] The Daytona key and model keys belong only to `agent-secrets`. Plugin provider keys are brokered by `apps/api` (`plugins.md` secrets broker), never mounted into `worker`.

---

## Phase E. Make each service stateless (what actually lets replicas > 1 work)

Kubernetes only helps if any replica can serve any request. This is the real code work, and it lands in the apps, so each item says when it's safe to do.

### E.1 `apps/agent` (after todo1 is done)
- [ ] `.data/` (local session and run storage) → Postgres via a `SessionStore` interface. Keep the file store as the dev implementation behind `STORE=file|postgres`.
- [ ] Run events and SSE: publish run events to Redis Streams (`<resourcePrefix>:run:<id>`). Any replica can stream or resume a run with `Last-Event-ID`, so sticky sessions aren't needed.
- [ ] Approvals: store pending approvals in Postgres or Redis, not memory, so the approving POST can hit a different replica than the running loop.
  - A run's agent loop still lives on one replica. If that pod dies, the run is marked `interrupted` and the user can resume. Document this; don't build distributed loops.
- [ ] Graceful shutdown on `SIGTERM`: stop accepting runs, let in-flight runs finish within the grace period or checkpoint them, and stop Daytona sandboxes that this pod owns.

### E.2 `apps/api` and `apps/worker` (build stateless from day one in todo2 Phases 4–6; just check)
- [ ] All state in Postgres, all blobs in object storage via a `BlobStore` interface (`local` for tests, `s3` everywhere else). Nothing written to local disk except `/tmp`.
- [ ] The job queue behind a `JobQueue` interface (Redis in v1). Workers pull, ack and retry with visibility timeouts and idempotency keys, so a killed pod's job is re-run safely.
- [ ] Events (the `plugins.md` events bus): Redis pub/sub or Streams behind an `EventBus` interface.

### E.3 Assets and seed data
- [ ] `tools/fetch-seeds.py --upload`: after downloading, upload `seed-data/*` to the `assets` bucket (MinIO locally) with the same keys as `seed-data/manifest.json`.
- [ ] `apps/api` serves assets through presigned URLs or a streaming route. `apps/web` already goes through `assetUrl` (todo2 step 1.6), so only the host-API implementation changes. `apps/web/dev/seed-server.ts` stays as the zero-infra dev mode.

### E.4 Shared conventions (every service)
- [ ] `/healthz` (process up) and `/readyz` (DB, Redis and storage reachable), excluded from auth and access logs.
- [ ] JSON logs on stdout with `service`, `version`, `request_id` and `trace_id`. No log files.
- [ ] OpenTelemetry traces and metrics through `packages/observability-{ts,py}`. Propagate `traceparent` from web to api, agent and worker, so one trace follows a user action through tools and jobs.
- [ ] Config validated at startup (zod in TS, pydantic-settings in Python). Fail fast with the missing key names, never the values.
- [ ] Version endpoint `/version` returning the git SHA (injected as a Docker build arg).
- [ ] Later (moved from todo1 §9): Daytona's own traces, `new Daytona({ otelEnabled: true })` with OTLP export from `apps/agent`, and pi-telemetry contracts once they're stable.

---

## Phase F. CI/CD (`.github/workflows`)

- [ ] `ci.yml` on every PR:
  - `pnpm install --frozen-lockfile`, then `uv sync --frozen`;
  - `pnpm affected` (typecheck, lint, test);
  - `tools/check-boundaries.mjs`, then `lint-imports`;
  - the `kubeconform` step from D.3;
  - a secret scan (`gitleaks`) and the "no committed Secret" check from D.4.
- [ ] `images.yml` on `main`: build only the affected app images (`turbo prune` with `--filter=...[HEAD^1]`), push to GHCR tagged `sha-<short>`, and attach SBOM and provenance (`docker/build-push-action` with `provenance: true, sbom: true`).
- [ ] `e2e.yml`:
  - `stack:up` (compose `full` profile), then `tests/e2e` and `apps/web/e2e`;
  - Daytona-live tests only on a schedule or manual dispatch, with the key from repository secrets, then `pnpm --filter @studio/agent sweep` in an `always()` step.
- [ ] Deploy (later): GitOps with Argo CD or Flux watching `infra/k8s/overlays/*`. CI only bumps image digests in the overlay. Nothing runs `kubectl apply` from CI.

---

## Phase G. Docs
- [ ] `docs/README.md`: a map of the repo (the Phase B tree), the three import rules, and the old-to-new path table from B.1.
- [ ] `docs/adr/0001-monorepo-layout.md`: R1–R6 with the reasons above.
- [ ] `docs/running.md`: three ways to run the product:
  - `pnpm dev` plus `infra:up` (daily work);
  - `stack:up` (prod-like, local);
  - `kubectl apply -k infra/k8s/overlays/dev` (kind or k3d cluster).
- [ ] `infra/k8s/README.md`: the Secret key names per app (names only), the scaling knobs (HPA and KEDA thresholds), and how to add a new app (copy `base/<app>`, add it to the overlays and Ingress).
- [ ] `AGENTS.md`: the layout rules, `.worktrees/` for parallel work (R2), and "never import across `apps/*`".

---

## Order of work and who may do it

| Step | Safe while todo1/todo2 agents are running? |
|---|---|
| Phase A | **No.** Needs both agents paused or committed. Do it first. |
| B.1 docs and `tools/fetch-seeds` moves; C.1 `.nvmrc`; C.2 root `pyproject.toml`; D.2 compose `deps` profile; D.3 skeleton for `web`; F `ci.yml`; G | Yes. These don't touch `apps/web` or `apps/agent` internals. |
| C.1 package renames, C.3 turbo shims, D.1 `agent` Dockerfile, E.1 | After todo1 is done |
| B.1 boundaries/mcp/seed-server moves, D.1 `api`/`worker` Dockerfiles, E.2, E.3 | After the todo2 phase each row names |
| D.3 `api`/`worker`/`agent` bases, KEDA, overlays for staging/prod | After E.1 and E.2. Replicas > 1 before the services are stateless will cause subtle bugs. |

**Done when:**
1. There's one checkout, `/Users/anhlam/inkling`.
2. `pnpm dev` plus `pnpm infra:up` runs the whole product.
3. `pnpm stack:up` runs it from images.
4. `kustomize build infra/k8s/overlays/dev | kubectl apply -f -` on a local kind cluster serves the Studio.
5. Scaling `api`, `agent` or `worker` to 3 replicas passes `tests/e2e`.
6. No file outside the naming config, presets, fixtures and docs contains the brand name.
