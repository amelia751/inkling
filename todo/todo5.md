# Naming and tidy-up: one rule for every name, fewer stray files

**Goal.** Make it possible to guess any name from the folder it lives in: a package, an import, an env var, an image or a Kubernetes object. Remove the files and branches that no longer serve anyone. There's no behavior change and no new features.

**When.** Start after `todo3-monorepo` (`.worktrees/todo3`, commit fb13ecb and later) and `todo2-phase7-9` are merged into `main`. Both branches touch the same paths (docs, `tools/`, agent config and env vars), so doing this sooner means conflicts. This plan assumes todo3's layout: `docs/`, `tools/`, `apps/mcp`, `tests/e2e`, the uv workspace and `@studio/web`.

**Audit date:** 2026-10-30, against `main` 581922d plus todo3's fb13ecb.

## Status (2026-10-30)

Done on branch `todo5-naming` (from `main` 3439eae, after todo2 Phase 7–9 and todo3 merged), one commit per step. D1–D4 took the recommended options.

Checks: `pnpm typecheck` (10 tasks, the Python packages included), `pnpm test`, `check:boundaries`, `check:names`, `check:icons`, `emit:schemas --check`, `build-registry --check`, `contracts:check`, `dump_openapi --check`, `lint-imports`, `ruff`, `go vet` + `go test ./...` and segmentation's own pytest are green. The full `apps/web/e2e` suite passed twice in a row (10/10 files both times; at the start, image2d and volume3d failed because the local annotations had drifted). With the new env names, `tests/e2e/plugins_test.py` passed 8/8, `agent_test.py` 13/13 and `builder_test.py` 9/9, run against a local api + worker. On a fresh SQLite database the first agent and builder run each hit a 500 from an existing workspace get-or-create race (in `BACKLOG.md`); every later run was clean.

Where the work differs from the plan:

- **1.2:** every merged branch and worktree is deleted. `wip/main-daytona` is kept (the user's call: it has one commit that isn't on `main`). `todo2-phase7-9` was already gone.
- **1.4:** `emit:schemas` now writes the catalogue prompt to `schemas/catalog.md`, so all three URLs are served from `schemas/`.
- **1.5:** `plugins/dicom-export/README.md` already existed; only the secrets line was left.
- **1.6:** the e2e dev server (`<P>E2E=1`) copies `apps/web/e2e/fixtures/annotations/` to a temp folder at startup (`<P>WEB_ANNOTATIONS_DIR` overrides). `2d-xray.json` there rebuilds the five boxes image2d expects; the other fixtures are copies of the last local state.
- **3:** the scheme was applied beyond the table: `<P>WEB_URL` (the agent's `AGENT_STUDIO_URL`, the MCP server's `<P>URL`), `<P>MCP_AUTHOR`, `<P>LOG_FORMAT`, `<P>E2E_API_URL`, nginx's `AGENT_UPSTREAM` → `<P>AGENT_URL`, the SDK's `STUDIO_NAMING_FILE` → `NAMING_FILE`, and the integration harness's `VERBOSE` → `<P>VERSIONING_TEST_VERBOSE`. `<P>ENV` takes `development|test|production` everywhere (the API used `dev`). The env-read check lives in `tools/check-names.mjs`, next to the package-name rule. The exit grep still matches `tools/migrate-env.mjs`, whose job is to map the old names.
- **4:** the real gap was `\b`: `_`, digits and camelCase humps now count as boundaries. That found more leaks than listed: image2d's COCO extras (`${RES}_class`, `_id`, `_provenance`, `_measurements`) and its `__${RES}2d` / `__${RES}Raster` hooks. The brand check now also scans `apps/agent`, whose tests hard-coded sandbox names and labels. Neither the WSI nor the COCO importer reads those metadata keys, so there was no legacy reader to extend. As D3 allows, comments and the spelled-out env prefix in `infra/`, Dockerfiles and nginx templates (rewritten by `tools/rename-namespace.mjs`) still mention the brand.
- **Found on the way:** `schemas/api/openapi.json` and the api-client types were stale on `main` (regenerated), and CI's `uv sync` installed neither the workspace members nor observability's `otel` extra, which `lint-imports` and pyright need.

---

## 0. The naming model (decide once, then apply mechanically)

There are three kinds of name, and today they're mixed up.

| Kind | What it is | Where it may appear | Value |
|---|---|---|---|
| **Brand** | The product name users see; white-label-able | only `packages/plugin-contracts/src/naming.ts` → `schemas/naming.json`, user-facing docs, the repo folder | `Inkling` / `inkling` / `INKLING_` |
| **Scope** | The fixed, brand-free code name of the platform | package names, Python imports, the Go module, image names | `studio` |
| **Role** | What one folder is for | the folder name, the k8s Deployment, the env-var segment, the ingress path | `api`, `agent`, `worker`, `web`, `mcp`, `versioning` |

**The rule:** every artifact name is `scope + role`, where the role is the folder name.

| Folder | npm (or shim) | Python dist / import | Image | k8s | Env vars |
|---|---|---|---|---|---|
| `apps/api` | `@studio/api` | `studio-api` / `studio_api` | `studio-api` | `api` | `<P>API_*` |
| `apps/worker` | `@studio/worker` | `studio-worker` / `studio_worker` | `studio-worker` | `worker` | `<P>WORKER_*` |
| `apps/agent` | `@studio/agent` | — | `studio-agent` | `agent` | `<P>AGENT_*` |
| `apps/web` | `@studio/web` | — | `studio-web` | `web` | `<P>WEB_*` (build time) |
| `apps/mcp` | `@studio/mcp` | — | `studio-mcp` | `mcp` | `<P>MCP_*` |
| `apps/versioning` | `@studio/versioning` | — (Go: `studio.local/versioning`) | `studio-versioning` | `versioning` | `<P>VERSIONING_*` |
| `packages/<x>` | `@studio/<x>` | `studio-<x>` / `studio_<x>` | — | — | — |
| `plugins/<x>` | `@studio/plugin-<x>` | `studio-plugin-<x>` / `studio_plugin_<x>` | — | — | — |

`<P>` is `NAMING.envPrefix` (`INKLING_`).

### Why `apps/api` holds `studio_api` and not `studio`

`apps/api` is the folder, so it's named for its role, the same way `apps/agent` holds `@studio/agent`. `studio_api` is the importable name, and it has to be unique across the whole uv workspace. The API, the worker, the plugin SDK and the e2e tests all share one environment and one `uv.lock`.

- A bare `import api` collides with anything else called `api`, and it doesn't say whose API it is.
- `import studio` would make the API own the entire scope. The SDK and the worker would then have nowhere to live, short of becoming subpackages of the API.

So `studio_api` is the right pattern. It looked messy only because the pattern wasn't applied everywhere. The places that break it are listed in Phase 2.

- [x] **D1. Flat imports or a namespace package.** **Recommended: keep flat `studio_<role>`.**
  - A PEP 420 namespace (`studio.api`, `studio.worker`, `studio.plugin_sdk`) reads nicer, but pytest rootdirs, pyright, hatchling `packages =` and import-linter root packages all need special handling.
  - The flat form maps one-to-one from the dist name (`studio-api` → `studio_api`), and import-linter already uses it.
- [x] **D2. "Kernel" or "api".** **Recommended: the service is `api` everywhere it's configured or deployed.**
  - That covers env vars, URLs, images and docs headings.
  - "Kernel" stays an architecture word for the stable core inside it (`studio_api/kernel/`, `docs/plugins.md` §6).
  - Today one service has three names: the `INKLING_KERNEL` and `INKLING_KERNEL_URL` env vars, the `apps/api` folder, and "Kernel and control plane" in its README.
- [x] **D3. Env-var scheme.** **Recommended:** `<P><ROLE>_<KEY>` for settings a service owns, and `<P><ROLE>_URL` and `<P><ROLE>_TOKEN` for how other services reach it.
  - Settings every service shares: `<P>ENV` (`development|test|production`) and `<P>LOG_LEVEL`.
  - Unprefixed names are allowed only for third-party standards (`DAYTONA_*`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OTEL_*`) and for `NAMING_FILE`. `NAMING_FILE` can't carry the prefix because the prefix is read from that file.
- [x] **D4. Package folders drop the redundant `studio-` and `plugin-` words** (see 2.2). **Recommended: yes, done as one codemod commit.**

---

## Phase 1. Trim (cheap, no renames; can start right after the merges)

### 1.1 Plans
- [x] Move finished plans to `todo/done/`:
  - `todo/todo.md` (modular viewers, done);
  - `todo/phase6-brief.md` (the brief for the `conv-*` agents, done);
  - `todo/todo1.md` (done).
  - Copy todo1's one open "Later" item (Daytona `otelEnabled` / OTLP export) into todo3 Phase E.4, which owns OpenTelemetry.
- [x] Once todo2 Phase 7–9 and todo3 land, add `todo/BACKLOG.md`.
  - It holds only the open items from the "What's left" sections of todo2, todo3 and todo4, one line each with a link back to the section.
  - Then archive any plan whose remaining items all moved there.

### 1.2 Branches and worktrees (ask the user first; none of these are on `main`)
- [x] `conv-cine`, `conv-image2d`, `conv-timeseries`, `conv-video`, `conv-volume`, `conv-wsi`.
  - These are the per-viewer conversions; `modular-viewers` (merged) already replaced them.
  - Before deleting, check each with `git log --oneline main..conv-<x>`.
- [ ] `wip/main-daytona`: the old `main` uncommitted work, in the pre-restructure layout; the merged code replaces all of it.
- [x] After the agents finish: `todo2-phase7-9`, `todo3-monorepo`, `.worktrees/todo3`, and the three locked `.claude/worktrees/agent-*` worktrees with their `worktree-agent-*` branches.
  - Remove them with `git worktree remove`, then `git worktree prune`.

### 1.3 Dead code and shims
- [x] Delete `apps/agent/src/protocol.ts` (a one-line `export type *` shim). Import `@studio/agent-protocol` directly in `apps/agent/src`, `scripts/smoke.ts` and `test/unit/*`.
- [x] Delete `apps/web/src/studio/lib/agent/protocol.ts` (a re-export). Its three importers (`stores/agent.ts`, `components/ai/cards.tsx`, `core/panels/ai.tsx`) use `@studio/agent-protocol`.
- [x] `tools/boundaries-allowlist.json` is `[]`. Delete it and its loading code; add it back when there's a real exception.
- [x] `.gitignore`: replace the per-app `.data/` lines with `**/.data/`. `apps/agent/.data/` and `apps/versioning` need it too.

### 1.4 Generated duplicates
- [x] `apps/web/public/catalog.json`, `public/catalog.md` and `public/schema/environment.v1.json` are copies of `schemas/catalog.json` and `schemas/environment.v1.json`, written by `emit:schemas`.
  - Serve `schemas/` from Vite instead: a dev middleware, plus a copy step in `build`.
  - Stop tracking the copies.
  - Keep the URLs (`/catalog.json`, `/schema/environment.v1.json`), because agents and the MCP server read them.

### 1.5 Secrets and docs hygiene
- [x] `secrets/README.md`: remove the line saying the Daytona key was copied from another project (`jetrun/kiwi/...`). It's unrelated, and naming where a key came from doesn't belong in the repo. Keep the rotation instructions.
- [x] `plugins/export-dicom/` is the only plugin without a `README.md`. Add one with the same sections as the others (todo2 Phase 2 left this open).

### 1.6 Make the e2e suite self-contained
- [x] `apps/web/e2e/image2d_test.py` passes only when the untracked `seed-data/.annotations/2d-xray.json` happens to be in the canonical state. A local edit breaks it.
  - Have the harness point the dev server at a temp copy of the annotations folder (an env var such as `<P>WEB_ANNOTATIONS_DIR`), seeded from `fixture_annotations`.
  - Then no test reads or writes the developer's real annotations.
- [x] `seed-data/manifest.json` must be version 2. Have `tools/fetch-seeds.py --check` fail on an old manifest, and call it from the harness before the run starts.

**Exit:** all checks green (the `AGENTS.md` list, plus `uv run pytest` and `go test ./...`), the full e2e suite passes twice in a row, and `git branch` shows only `main` and branches in active use.

---

## Phase 2. Package and folder names (one codemod commit per bullet)

### 2.1 Places where the folder, the package and the import disagree today
| Today | Problem | Fix |
|---|---|---|
| `packages/plugin-sdk-py`, npm shim `@studio/plugin-sdk-py`, dist `studio-plugin-sdk` | The folder and shim carry a language suffix that the dist doesn't | Folder → `packages/plugin-sdk`, shim → `@studio/plugin-sdk`. The import `studio_plugin_sdk` stays, since plugin authors already use it. |
| `plugins/export-dicom`, package `@studio/plugin-export-dicom`, id `<ns>.dicom-export` | The folder disagrees with the id | Folder → `plugins/dicom-export`, package → `@studio/plugin-dicom-export`. The id is stored in environments, so it doesn't change. |
| `plugins/segmentation`, dist `segmentation-plugin` / `segmentation_plugin` | Doesn't follow `studio-plugin-<x>` | → `studio-plugin-segmentation` / `studio_plugin_segmentation`. Update `pyproject.toml`, the `plugin.yaml` entrypoint, the tests and the import-linter contract. |
| Root `package.json` `studio`, root `pyproject.toml` `studio-workspace` | The two roots disagree | Both → `studio-workspace` |

### 2.2 Redundant words in package names (D4)
| Today | New | Why |
|---|---|---|
| `packages/studio-ui` (`@studio/studio-ui`) | `packages/ui` (`@studio/ui`) | The scope already says "studio" |
| `packages/studio-renderers` (`@studio/studio-renderers`) | `packages/renderers` (`@studio/renderers`) | Same |
| `packages/plugin-contracts` (`@studio/plugin-contracts`) | `packages/contracts` (`@studio/contracts`) | It holds the environment schema, workspace, media types and naming, not only plugin contracts. Everything imports it. |

- [x] Steps:
  1. `git mv` each folder.
  2. Run a codemod over `@studio/<old>` → `@studio/<new>` in TS, TSX, MJS, JSON and MD files.
  3. Update `apps/web/tsconfig.json` `paths`, `apps/web/aliases.ts`, the `tools/check-boundaries.mjs` layer names, and `AGENTS.md`.
  4. Run `pnpm install`, then all checks.
  5. Update the docs, including the `AGENTS.md` "Rules" layer list.
- [x] `packages/plugin-ui-sdk` and `packages/agent-protocol` already follow the rule; keep them.

### 2.3 Enforce it
- [x] Add a check to `tools/check-boundaries.mjs` (or a new `tools/check-names.mjs`). For every workspace member, the package name must equal `@studio/<folder>`, or `@studio/plugin-<folder>` under `plugins/`. Python dist names get the same check. It runs in CI with the others.

**Exit:** `rg '@studio/(studio-ui|studio-renderers|plugin-contracts|plugin-sdk-py)'` finds nothing outside `todo/done/`, and all checks are green.

---

## Phase 3. Env vars and config (D2, D3)

Today each service invents its own names: `apps/api` uses `INKLING_API_*`; the web dev server uses `INKLING_KERNEL`, `INKLING_KERNEL_URL` and `VITE_INKLING_KERNEL`; the worker uses `INKLING_KERNEL_URL`; the agent's are unprefixed (`AGENT_*`, `APP_ENV`, `LOG_LEVEL`, `INTERNAL_AGENT_SERVICE_TOKEN`); and versioning uses `INKLING_VERSIONING_*` plus an unprefixed `NAMING_CONFIG`.

| Today | New | Read by |
|---|---|---|
| `INKLING_KERNEL=1` and `VITE_INKLING_KERNEL` | removed: the web dev server uses the API when `INKLING_API_URL` is set; Vite passes the boolean through `define` | web |
| `INKLING_KERNEL_URL` | `INKLING_API_URL` | web, worker (and agent, todo2 Phase 7) |
| `AGENT_PORT`, `AGENT_MODEL`, `AGENT_SCRIPT`, `AGENT_SANDBOX`, `AGENT_DATA_DIR`, `AGENT_THINKING`, `AGENT_PLUGIN_TEMPLATE_DIR` | `INKLING_AGENT_*` | agent |
| `INTERNAL_AGENT_SERVICE_TOKEN` | `INKLING_AGENT_TOKEN` | agent, web proxy |
| `APP_ENV` | `INKLING_ENV` | all |
| `LOG_LEVEL` | `INKLING_LOG_LEVEL` | all |
| `AGENT_NAMING_FILE` (agent), `NAMING_CONFIG` (versioning) | `NAMING_FILE` (the one deliberately unprefixed name) | agent, versioning, api, worker |
| `LOAD_ENTRIES`, `LOAD_RESULTS`, `VERBOSE` (versioning load test) | `INKLING_VERSIONING_LOAD_*` | `make load` only |
| `INKLING_API_*`, `INKLING_VERSIONING_*`, `INKLING_AGENT_URL`, `INKLING_E2E` | unchanged | — |

- [x] Each service reads env vars in exactly one place, through an `env("<ROLE>_KEY")` helper that adds the prefix:
  - `apps/agent/src/config.ts`
  - `apps/api/src/studio_api/config.py`
  - `apps/worker/src/studio_worker/main.py` (moved into a `config.py`)
  - `apps/versioning/internal/config`
  - `apps/web/vite.config.ts`

  A check fails on `process.env.X`, `os.environ` and `os.Getenv` anywhere else (third-party names are on an explicit list).
- [x] Migration in one commit:
  - Update `secrets/*.env.example`, `secrets/README.md`, the e2e harness, `tests/e2e/*`, the app READMEs and `docs/agent.md`.
  - Add `tools/migrate-env.mjs`, which rewrites the key names in a developer's local `secrets/*.env` in place without printing values. For example, it renames `INTERNAL_AGENT_SERVICE_TOKEN` in `secrets/agent.env`.
  - Nothing is deployed yet, so no fallback to the old names.
- [x] `apps/api/README.md` heading: "API service (`apps/api`): kernel and plugin control plane". `docs/plugins.md` keeps "kernel" for the concept.

**Exit:** `rg -n 'KERNEL_URL|INKLING_KERNEL|APP_ENV|INTERNAL_AGENT_SERVICE_TOKEN|AGENT_NAMING_FILE|NAMING_CONFIG'` finds nothing outside `todo/`. The agent e2e and plugins e2e pass with the new names.

---

## Phase 4. Brand leaks the check misses

`check-boundaries` catches the brand in plain string and identifier tokens, but it misses these:

- [x] `plugins/volume/ui/renderer/MprEngine.ts`: the e2e hook is `` `__inkling3d` `` (a template literal). Change it to `` `__${RES}3d` ``, update `apps/web/e2e/volume3d_test.py` to read the name from `schemas/naming.json`, and add template-literal text to the brand check.
- [x] `plugins/wsi/ui/io.ts`: exported GeoJSON uses the metadata keys `inkling_item` and `inkling_provenance`. Change them to `${RES}_item` and `${RES}_provenance`. The importer also accepts `legacyNamespaces` prefixes, so files exported before a rename still load. Update `wsi.test.ts`.
- [x] `plugins/*/plugin.yaml` hard-codes `schemaVersion: inkling.plugins/v1` and `id: inkling.<x>`. That's allowed (they're data, and `tools/rename-namespace.mjs` rewrites them). Add one test asserting that every `plugin.yaml` id starts with `NAMING.namespace`, so a rename can't half-apply.
- [x] Generated `apps/api/.../_generated/plugin_v1.py` contains `Literal['inkling.plugins/v1']`. That's fine because it's generated, but put `_generated/` on the brand check's skip list explicitly.

**Exit:** `rg -i inkling` outside `naming.ts`, `schemas/naming.json`, `plugin.yaml`, `_generated/`, `docs/`, `todo/`, READMEs and e2e assertions on visible text returns nothing.

---

## Phase 5. One vocabulary in the docs

These words are used loosely across `docs/`, `AGENTS.md` and code comments. Add a short glossary to `docs/README.md` (todo3 Phase G creates it) and fix any doc that contradicts it.

| Term | Means | Not |
|---|---|---|
| **Studio** | the annotation UI shell (`apps/web/src/studio/`) | the whole product, or the code scope `@studio` |
| **Plugin** | an installable unit: `plugin.yaml` + optional `ui/` + optional worker code | — |
| **Module** | a plugin's UI half (`ModuleManifest`, `ui/manifest.ts`) | a plugin |
| **Extension host** | the registry, resolver, commands and catalogue in the web app | the API's plugin control plane |
| **API** (service) | `apps/api` | — |
| **Kernel** | the stable core inside the API (`studio_api/kernel/`) | the API service |
| **Environment** | a JSON spec of what one Studio shows | a deployment environment (dev, staging, prod: call those **stages**) |
| **Preset** | an environment shipped in `registry/presets/` | — |
| **Workspace** | per-project plugin activation and settings (`workspace.v1.json`) | a pnpm or uv workspace (call those **repo workspaces** in docs) |

- [x] `infra/k8s/overlays/{dev,staging,prod}` keep their folder names; docs call them stages, never environments.

**Exit:** the glossary exists, and `AGENTS.md` links to it in its first paragraph.

---

## Order and size

| Phase | Depends on | Size | Risk |
|---|---|---|---|
| 1 Trim | todo3 and todo2-phase7-9 merged | half a day | low (deletions; ask before deleting branches) |
| 2 Package names | 1 | half a day (codemod) | medium (touches every import; one commit each, checks after each) |
| 3 Env vars | 2, todo2 Phase 7 (the agent's kernel client) | half a day | medium (local `secrets/*.env` need `tools/migrate-env.mjs`) |
| 4 Brand leaks | — (can go alongside 2) | an hour or two | low |
| 5 Vocabulary | todo3 Phase G | an hour | none |

Every phase ends with the `AGENTS.md` checks, `uv run pytest`, `go test ./...`, and the full e2e suite: web-only in `apps/web/e2e`, cross-service in `tests/e2e`.
