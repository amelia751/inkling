# Plugin infrastructure (`plugins.md`) on top of the modular Studio

**Goal.** Reshape the modular Studio on `modular-viewers` (`/Users/anhlam/inkling-modular`) into the layout and contracts in `plugins.md`:

- a stable kernel and Studio shell;
- plugins that declare capabilities, providers, tools, skills and UI contributions;
- trusted renderers;
- a control plane that installs, pins and rolls back plugins per workspace;
- Python plugin workers;
- a Builder Agent that discovers and activates plugins before it writes code.

**What already exists.** The frontend half is mostly done in spirit: manifests, contributions, an environment spec, per-module lazy `load()`, `when` clauses, a catalogue for the agent, and declarative agent panels. The backend half does not exist yet.

**How to read this.** Phase 1 is almost pure file moving. Phase 2 onward is new code. Every step lists the files it touches. Keep each phase a separate PR, and keep `pnpm typecheck`, `pnpm test`, `pnpm check:boundaries --strict` and the Python e2e suite green at the end of each one.

---

## Status (2026-10-30)

- **Phase 0:** partial. The naming config, the brand-literal check, the rename tooling and the docs are done. The baseline in 0.2 was never recorded, and the SDK and `apps/agent` don't read `schemas/naming.json` yet.
- **Phase 1:** done. The whole e2e suite passes on merged `main` and the generated schemas are current.
- **Phase 2:** done, except the root `README.md` for `plugins/export-dicom`.
- **Phase 3:** done.
- **Phase 4:** done, except that no CI runs the contract drift check.
- **Phase 5:** done.
- **Phase 6:** partial. The SDK, worker, segmentation plugin, `studio.mask-review.v1` and budgets are in, and the exit e2e passes locally. Still missing: the SDK's `annotations.write` client, a Meta SAM adapter verified against the real API, and CI.
- **Phase 7:** done. `apps/agent` reads `schemas/naming.json` (`src/naming.ts`); `src/tools/kernel.ts` has the builder and task tools; `builder` and `task` profiles; install approvals go through the approval broker into the Studio's install review (`approval.detail.kind = "plugin-install"`); skills/READMEs are fetched lazily and wrapped as untrusted; `policy.ts` refuses `stage_plugin` (and sandbox/build) unless the user asked for a plugin change in this run; the §7.1 preference order is in `prompts/builder.md`. The kernel now enforces `plugins.read|manage|author|approve` scopes, and agent tokens never get `plugins.approve`.
- **Phase 8:** partial. Most of the §14 tests exist (`apps/api/tests`, `apps/worker/tests`, `plugins/segmentation/tests`, `apps/agent/test/unit/builder-policy.test.ts`). The rollback and tier-3 iframe web e2e tests don't.
- **Phase 9:** done, with two limits (below). `create_plugin_sandbox` / `run_plugin_checks` / `build_plugin_artifact` in `apps/agent/src/tools/kernel.ts`; `apps/api/src/studio_api/plugins/artifacts.py` (checks, digest, Ed25519 dev signature, private store, `trust_tier: generated`, visible to the authoring workspace only); the install review shows the code diff. Verified live on Daytona + a real kernel (`apps/agent/test/live/plugin-build.live.test.ts`, 2026-10-30).

Next after this plan comes `todo/todo3.md` (monorepo restructure). It moves things like `scripts/` and the docs, so the paths below may change.

### What's left

- **Phase 0**
  - `packages/plugin-sdk-py` reads `schemas/naming.json` instead of literals. `apps/agent` is covered in Phase 7.
- **Phase 2**
  - Add `plugins/export-dicom/README.md`.
- **Phase 4**
  - Wire `apps/api/scripts/gen_contracts.py --check`, `emit-schemas.mjs --check` and `build-registry.mjs --check` into CI. There is no CI config yet.
- **Phase 6**
  - Add an `annotations.write` client to `packages/plugin-sdk-py/src/studio_plugin_sdk/context.py`, or record that results go only through the gateway.
  - Verify `plugins/segmentation/src/segmentation_plugin/providers/meta_sam.py` against Meta's current API docs.
  - Run `apps/web/e2e/plugins_test.py` in CI (it passes locally). A unit test for `packages/studio-renderers/src/mask-review/MaskReview.tsx` would also help.
- **Phase 8**
  - A rollback web e2e test.
  - A web e2e test asserting the tier-3 iframe has `sandbox` without `allow-same-origin`.
- **Phase 9** (follow-ups, not blocking)
  - Forking an existing plugin into the sandbox (preference step 4): `create_plugin_sandbox` only scaffolds from `plugins/_template`. Needs a kernel route that serves a package's files.
  - Generated `python-worker` plugins pass the build checks, but `studio-plugin-sdk` is only resolvable through a path source, so the worker can't install them from the artifact store until the SDK is on an internal index.
  - On Daytona tiers 1–2 (no egress rules), the plugin-build sandbox keeps the org's default network; it has no bash, only file tools and `run_plugin_checks`.

---

## 0. Decisions to settle before starting

| # | Question | Recommendation | Why |
|---|---|---|---|
| D1 | `plugins.md` puts the agent harness in Python (`apps/api/src/agents/`). `todo/todo1.md` chose pi in Node (`apps/agent`). | **Keep pi in `apps/agent`.** The kernel, control plane and plugin workers are Python (`apps/api`, `apps/worker`). The Builder and Task agents call the kernel over HTTP with a session-scoped token. Drop `apps/api/src/agents/` from the layout. | One agent runtime. `todo1.md` is already being built. `plugins.md` §8 only needs the tools to go through the gateway, not a Python agent. |
| D2 | `plugins.md` §5.3 says plugins supply descriptors, not React. The current modules are React. | **First-party plugins are trusted code**, compiled into the web build. Their `ui/` folder may contain React. Third-party and agent-authored plugins may only ship `plugin.yaml` + `ui/contributions.json` that reference trusted renderers by name. | That's the intent of "trusted renderer registry for MVP". Today's modules *are* the trusted renderers. |
| D3 | Naming. Today the brand `inkling` is hardcoded in contribution ids (`inkling.wsi.renderers.osd`), presets, e2e tests, the MCP server and saved environments, and `plugins.md` uses `studio.*`. The name may change. | **No brand name in anything new.** (a) Code identifiers that can't be configured (npm packages, Python packages, folders) use brand-free names: `@studio/*`, `studio_api`, `studio_plugin_sdk`, `segmentation_plugin`. (b) Runtime identifiers (the contribution-id namespace, `schemaVersion` prefix, sandbox and label prefixes, env-var prefix, display name) come from **one naming config** (step 0.1). In this plan they're written as `<ns>`. (c) Existing `inkling.*` ids keep working through an alias table, so a rename is a config change plus one migration script, not a find-and-replace. | A rename touches one file and runs one script. Saved environments and annotations keep resolving through the aliases. |
| D4 | `plugins.md` §4 roots everything under `studio/`. | Use the repo root: `apps/`, `packages/`, `plugins/`, `registry/`, `schemas/`. | It's already a pnpm monorepo. |
| D5 | Packages or path aliases for plugins? | `packages/*` become real workspace packages (`package.json` with `exports` pointing at `src/*.ts`, no build step). `plugins/*/ui` are reached through **one alias**, `@plugins/*`, with no per-plugin `package.json` yet. | Minimal churn. Per-plugin packages only matter once plugins are versioned artifacts (Phase 5). |
| D6 | Branch | Do all of this on `modular-viewers` (or a branch from it). `main` doesn't have the platform. | |

**Vocabulary mapping** (use it in code comments and docs so the two documents line up):

| `plugins.md` | Today on `modular-viewers` |
|---|---|
| Plugin | Module (`ModuleManifest`, `src/modules/<id>/manifest.ts`) |
| UI contribution | Contribution (`renderers`, `tools`, `panels`, `commands`, `inspectors`, `exporters`, …) |
| Trusted renderer | `RendererContribution` / panel components in `ModuleImpl` |
| Workspace configuration | Environment spec (`platform/environment.ts`) |
| Extension host | `platform/registry.ts`, `resolve.ts`, `runtime.ts`, `commands.ts` |
| Capability index (UI side) | `platform/catalog.ts` → `/api/catalog` |
| Builder tools | `platform/agent.ts` `AGENT_TOOLS` (`list_modules`, `patch_environment`, …) |
| Declarative UI / iframe extensions | `modules/experimental` (safety tiers 2 and 3) |
| Kernel, gateway, registry, installer, jobs, workers, secrets broker | **nothing yet** |

---

## Phase 0. Baseline (half a day)

### 0.1 One naming config (do this first; every later step uses it)
- [x] `packages/plugin-contracts/src/naming.ts` (create this package early, or put the file in `apps/web/src/platform/naming.ts` and move it in step 1.2). It is the only file that may contain the product name:
  ```ts
  export const NAMING = {
    displayName: "Inkling",          // UI copy, page titles, prompts
    namespace: "inkling",            // contribution ids: `${namespace}.<module>.<type>.<name>`
    schemaPrefix: "inkling",         // `${schemaPrefix}.plugins/v1`, `${schemaPrefix}.environment/v1`
    resourcePrefix: "inkling",       // sandbox names, labels (`app=`), cookie/storage keys
    envPrefix: "INKLING_",           // env vars read by apps
    legacyNamespaces: [] as string[], // old namespaces kept resolvable after a rename
  } as const;
  export const ns = (local: string) => `${NAMING.namespace}.${local}`;
  ```
- [ ] `scripts/emit-schemas.mjs` also writes `schemas/naming.json`, so the Python kernel, worker and SDK (Phases 4–6), `scripts/mcp.mjs` and `apps/agent` read the same values instead of their own literals. _(partial: `schemas/naming.json` is emitted and read by the kernel, worker, `mcp.mjs`, Vite config and e2e harness; `packages/plugin-sdk-py` and `apps/agent` still don't read it)_
- [x] Replace literals in code with `ns(...)` / `NAMING.*`:
  - module id constants (`export const IMAGE2D = "inkling.image2d"` → `ns("image2d")`), in every `manifest.ts` and kit manifest;
  - `resolveDefaults.baseModules`;
  - `bundled.ts` preset module id;
  - storage keys in `stores/` and `lib/`;
  - UI copy that says "Inkling" (→ `NAMING.displayName`);
  - agent prompts in `platform/agent.ts`.

  Add a boundaries rule to `scripts/check-boundaries.mjs`: the regex `\binkling\b` (case-insensitive) is an error outside `naming.ts`, `registry/presets/*.json`, fixtures and docs.
- [x] Stored documents (presets, environment specs, annotations whose `geometry.type` is `<module>.<name>`) keep **full** ids, because they must stay readable on their own. Make them rename-safe:
  - `extension-host/registry.ts`: `canonicalId(id)` maps any `legacyNamespaces` prefix to the current namespace, and every lookup (`get`, `resolve`, `when` clauses, geometry types) goes through it.
  - `scripts/rename-namespace.mjs --from <old> --to <new>`: rewrites `registry/presets/*.json`, `seed-data/**/environment*.json` and fixture files, and prints a summary. The kernel gets the same migration as an Alembic data migration in Phase 4.
  - Test `naming.test.ts`: with `namespace` changed to `acme` and `legacyNamespaces: ["inkling"]`, every preset still resolves and every e2e fixture environment validates.
- [x] Mention in `docs/modules.md` that module ids are `${namespace}.<module>` and must never be hardcoded.

### 0.2 Record the baseline
- [ ] On `modular-viewers`, run and record: `pnpm --filter web typecheck`, `pnpm --filter web test`, `pnpm --filter web check:boundaries --strict`, `pnpm --filter web emit:schemas` (expect no diff), and the e2e harness (`apps/web/e2e/*_test.py`). _(superseded: never recorded before the moves; the merged `main` run in Phase 1 is the baseline now)_
- [ ] Note the facts that make Phase 1 cheap:
  - Only `src/bundle.ts` imports from `src/modules/**` or `src/kits/**`. Everything else goes through the registry.
  - `boundaries-allowlist.json` is empty.
  - `platform/` imports almost nothing: 2 `@/types`, 1 `@/lib`, 1 `@/components`, 1 `@/bundle`.
- [ ] Note what modules and kits import, which is the coupling to break:
  - `@/platform`: 150 imports
  - `@/kits`: 117
  - `@/types`: 90
  - `@/stores/studio`: 39
  - `@/components/icons`: 26
  - `@/lib/utils`: 18
  - `@/lib/labels`: 17
  - `@/lib/api`: 16 (all `seedUrl` but two)
  - `@/components/ui/*`: about 20
  - `@/migrations/annotations-v1-to-v2`: 6

---

## Phase 1. Move files into the `plugins.md` layout (no behavior change)

Target tree after this phase:

```text
apps/web/src/
├── studio/                 # shell: app/, components/studio, components/layout, stores, lib (moved from src/*)
│   └── core/               # was modules/core: built-in Studio contributions (files, labels, select, pan…), not a plugin
├── extension-host/         # was platform/ minus the SDK types: registry, resolve, runtime, commands, catalog, describe,
│   │                       #   patch, flags, agent.ts, bundled.ts (was src/bundle.ts)
│   └── agent-panels/       # was modules/experimental (tier 2 declarative + tier 3 sandbox iframe): host machinery
packages/
├── plugin-contracts/       # canonical types + JSON Schemas (environment, annotations, geometries, later plugin.yaml)
├── plugin-ui-sdk/          # defineModule, contribution types, when-clause types, host API hooks
├── studio-ui/              # components/ui (shadcn), components/icons, lib/utils (presentational only)
└── studio-renderers/       # was src/kits/*: cornerstone, overlay2d, timeline, viewport-chrome, io
plugins/
├── _template/ui/           # was modules/_template (the SDK template that §9.1 needs)
├── image2d/ui/  volume/ui/  timeseries/ui/  video/ui/  cine/ui/  cardiac-metrics/ui/  wsi/ui/  text-spans/ui/
└── export-dicom/ui/        # was modules/dicom-export
registry/
└── presets/*.json          # was platform/presets/*.json (workspace templates)
schemas/                    # emitted JSON Schemas (was apps/web/public/schema/*, still copied to public/ at build)
```

Use `git mv` for every move so `git diff -M --stat` shows renames. Do it in the order below, because each step only depends on the ones before it.

### 1.1 Workspace wiring
- [x] `pnpm-workspace.yaml`: add `packages/*` to `packages:`. Leave `plugins/*` out until Phase 5 (D5).
- [x] Root `tsconfig.base.json` (new): shared `compilerOptions` (strict, `moduleResolution: bundler`, `jsx: react-jsx`). `apps/web/tsconfig.json` extends it.
- [x] `apps/web/tsconfig.json` `paths`: keep `"@/*": ["./src/*"]` and add `"@plugins/*": ["../../plugins/*/ui"]`.
- [x] `apps/web/vite.config.ts` and `vitest.config.ts`: add the same `@plugins` alias, and add `../../plugins` and `../../packages` to `server.fs.allow`.
- [x] Each new package gets a `package.json` (`"name": "@studio/<pkg>"`, `"type": "module"`, `"exports": { ".": "./src/index.ts", "./*": "./src/*.ts" }`, `"private": true`) and a `tsconfig.json` extending the base. Add them to `apps/web` dependencies as `"workspace:*"`.

### 1.2 `packages/plugin-contracts` (canonical types)
- [x] Move `apps/web/src/types/` (Annotation, Geometry, Project, StudioItem, …) to `packages/plugin-contracts/src/types/`, re-exported from `src/index.ts`.
- [x] Move `apps/web/src/platform/environment.ts` (the zod environment spec) to `packages/plugin-contracts/src/environment.ts`.
- [x] Move `apps/web/src/migrations/annotations-v1-to-v2.ts` to `packages/plugin-contracts/src/migrations/`. It's an annotation-schema concern, which the kernel will need too.
- [x] Leave `apps/web/src/types/index.ts` as a one-line re-export (`export * from "@studio/plugin-contracts"`) for one PR, so shell files can move gradually. Delete it at the end of Phase 1.

### 1.3 `packages/plugin-ui-sdk` (what a plugin's UI may import)
- [x] Move `platform/module.ts` (`defineModule`, every `*Contribution`, `ModuleImpl`, `RendererProps`, `PanelProps`, `RuntimeApi`, …) to `packages/plugin-ui-sdk/src/module.ts`.
- [x] `module.ts` imports `ResolvedEnv`/`ResolvedViewport` from `resolve.ts`. Move only those **types** into `plugin-ui-sdk/src/resolved.ts`; `resolve.ts` (the logic) stays in the host and imports them. Do the same for any type `when.ts` exposes to manifests.
- [x] Move `lib/labels.ts` (17 uses) to `plugin-ui-sdk/src/labels.ts` if it's pure. If it reads the store, split it into a pure part (SDK) and a store part (host API, step 1.6).
- [x] Add `plugin-ui-sdk/src/host.ts`: the `StudioHost` interface and the `useHost()` hooks. At first these only re-export what the store provides (step 1.6 lists the selectors).

### 1.4 `packages/studio-ui` (presentational primitives)
- [x] Move `components/ui/*`, `components/icons/*` and `lib/utils.ts` (`cn`) to `packages/studio-ui/src/`. Check nothing in them imports `@/stores` or `@/lib/api`. They're shadcn, so they shouldn't.
- [x] Update `components.json` (shadcn config) aliases to the new location so `shadcn add` keeps working.
- [x] `scripts/check-icons.mjs`: point it at the new icons path.

### 1.5 `packages/studio-renderers` (was `kits/`)
- [x] `git mv apps/web/src/kits/{cornerstone,overlay2d,timeline,viewport-chrome,io} packages/studio-renderers/src/`. Also move `kits/tool-catalog.ts`.
- [x] Kits that have a `manifest.ts` (`cornerstone`, `overlay2d`, `timeline`) stay modules: they contribute tools, renderers and commands. Keep the manifest next to the kit and export it from `packages/studio-renderers/src/<kit>/manifest.ts`.
- [x] Rewrite imports inside kits:
  - `@/platform/module` → `@studio/plugin-ui-sdk`
  - `@/types` → `@studio/plugin-contracts`
  - `@/components/*`, `@/lib/utils` → `@studio/studio-ui/*`
  - `@/stores/studio` (6 uses) → `@studio/plugin-ui-sdk` host hooks (step 1.6)
  - `@/kits/x` → relative `../x`
- [x] Move the Cornerstone dependencies (`@cornerstonejs/*`, `@kitware/vtk.js`, `dicom-parser`, `dcmjs`, …) from `apps/web/package.json` into `packages/studio-renderers/package.json`. Keep the exact versions, and keep any Vite `optimizeDeps` and worker config in `apps/web/vite.config.ts`.

### 1.6 Break the store and API coupling (the only real refactor in Phase 1)
Modules and kits reach into the shell's Zustand store and seed API directly. Give them a host API instead, so a plugin's UI never imports `apps/web` internals.

- [x] In `plugin-ui-sdk/src/host.ts`, define hooks that cover exactly what modules use today:
  - **State reads:** `annotations` (13), `tool` (9), `lockedLabels` (7), `selectedIds` (6), `hiddenLabels` (6), `activeLabel` (6), `selectedId` (4), `overlayOpacity` (4), `itemIndex` (2), `outlineOnly` (2).
  - **Actions:** `setViewerStatus` (5), `select` (3), `remove` (3), `setItemIndex` (2), `update`, `toggleLabelLocked`, `toggleLabelHidden`, `toggleAi`, `setOverlayOpacity`, `setClass`.
  - **Helpers:** `newAnnotation` (12), `isEditable` (12), `visibleFor` (9), `toolOption`/`useToolOption` (5), `brushSizeOf` (4), `LOCAL_AUTHOR` (3), the `Tool` type.
  - **Assets:** `assetUrl(path)` replaces `seedUrl` (14). Later it becomes the kernel Asset API's short-lived signed URL (§6).
  - **Labels:** `labelGroupsFrom` (1).
- [x] Implement the hooks once, in `apps/web/src/extension-host/host.tsx`, as a `<StudioHostProvider>` backed by the existing `useStudio` store. Wrap the Studio route in it.
- [x] Codemod: in `modules/**` and `kits/**`, replace `useStudio((s) => s.X)` with `useHost((s) => s.X)` (same selector shape, so the codemod is mechanical) and `seedUrl(` with `assetUrl(`.
- [x] Add a unit test that renders one renderer per module inside a fake `StudioHostProvider` (no Zustand). That proves plugins depend only on the SDK.

### 1.7 Move modules into `plugins/`
- [x] `git mv` each module:

| From `apps/web/src/` | To |
|---|---|
| `modules/image2d` | `plugins/image2d/ui` |
| `modules/volume` | `plugins/volume/ui` |
| `modules/timeseries` | `plugins/timeseries/ui` |
| `modules/video` | `plugins/video/ui` |
| `modules/cine` | `plugins/cine/ui` |
| `modules/cardiac-metrics` | `plugins/cardiac-metrics/ui` |
| `modules/wsi` | `plugins/wsi/ui` |
| `modules/text-spans` | `plugins/text-spans/ui` |
| `modules/dicom-export` | `plugins/export-dicom/ui` |
| `modules/_template` | `plugins/_template/ui` |
| `modules/core` | `apps/web/src/studio/core` (kernel built-ins, **not** a plugin: `resolveDefaults.baseModules`) |
| `modules/experimental` | `apps/web/src/extension-host/agent-panels` (host machinery for declarative and iframe UI) |
| `platform/presets/*.json` | `registry/presets/*.json` |

- [x] Rewrite imports inside the moved modules:
  - `@/platform/module` → `@studio/plugin-ui-sdk`
  - `@/platform/*` (other) → `@studio/plugin-ui-sdk`. If a module needs host internals, that's a bug to fix through the host API.
  - `@/kits/x` → `@studio/studio-renderers/x`
  - `@/types` → `@studio/plugin-contracts`
  - `@/components/*`, `@/lib/utils` → `@studio/studio-ui/*`
  - `@/modules/<other>/public` (7 cross-module imports, e.g. cardiac-metrics → cine) → `@plugins/<other>/public`
- [x] Each moved module keeps its README, tests and `__fixtures__`. Update `vitest.config.ts` `include` to pick up `../../plugins/*/ui/**/*.test.ts` and `../../packages/*/src/**/*.test.ts`.

### 1.8 Extension host and composition root
- [x] `git mv apps/web/src/platform apps/web/src/extension-host` (whatever is left after 1.2–1.3: `registry`, `resolve`, `runtime`, `commands`, `catalog`, `describe`, `patch`, `flags`, `keys`, `when`, `agent.ts` and the tests).
- [x] `git mv apps/web/src/bundle.ts apps/web/src/extension-host/bundled.ts`. It still lists the bundled first-party plugins, now imported from `@plugins/<name>/manifest` and `@studio/studio-renderers/<kit>/manifest`. Change the preset glob to `../../../../registry/presets/*.json`.
- [x] Move the shell into `apps/web/src/studio/`: `app/`, `components/{studio,layout,annotation,ai}`, `stores/`, `lib/` (minus what moved), `styles/`. The `@/` alias keeps working because it still points at `src/`; only path segments change.

### 1.9 Tooling, scripts, docs
- [x] `scripts/check-boundaries.mjs`: rewrite the layer table to:
  - `packages/plugin-contracts` → imports nothing internal
  - `plugin-ui-sdk` → contracts
  - `studio-ui` → nothing internal
  - `studio-renderers` → sdk, contracts, studio-ui
  - `plugins/*/ui` → sdk, contracts, studio-ui, studio-renderers, other plugins' `manifest.ts`/`public.ts` only
  - `extension-host` → sdk, contracts, studio-ui, plus `bundled.ts` → everything
  - `studio` (shell) → extension-host, sdk, contracts, studio-ui, **never** `@plugins/*`

  Keep `--strict` green.
- [x] `scripts/emit-schemas.mjs`: write to `schemas/` (and keep copying to `apps/web/public/schema/` and `public/catalog.json` for the dev server). Update the import paths.
- [x] `scripts/mcp.mjs`: update any imports of `platform/*`. Check `pnpm mcp` still lists modules and patches environments.
- [x] `dev/seed-server.ts` and `dev/agent/*`: update imports.
- [x] E2E: no URL changes are expected. Run the whole suite. _(2026-10-30 on merged `main`: shell, generic, image2d, volume3d, cine4d, signal, video, pathology, environments, agent 13/13 and plugins 8/8 pass; volume3d's islands step is flaky)_
- [x] Docs:
  - `docs/modules.md`: layers table, folder paths, "adding a module" → "adding a first-party plugin", the D2 rule.
  - `docs/modules-reference.md`: regenerate.
  - `inkling.md`: layout tree.
  - `AGENTS.md`: where things live.
- [x] **Exit:** _(typecheck, 234 vitest tests, strict boundaries and `emit:schemas --check` pass after regenerating on 2026-10-30)_
  - All checks green.
  - `git diff -M50% --stat` shows mostly renames.
  - No change to any environment JSON, preset id or contribution id.

---

## Phase 2. Data-only plugin manifests and declarative UI contributions

The TypeScript manifests stay the source of truth for **trusted** code: functions like `groupItems`, review-rule `check`, icons and zod schemas can't be data. This phase adds the `plugins.md` manifest **beside** them, so the registry, installer and agent can reason about plugins without executing code.

### 2.1 Contracts
- [x] `packages/plugin-contracts/src/plugin-manifest.ts`: a zod schema for `plugin.yaml` (`schemaVersion: <ns>.plugins/v1`, built from `SCHEMA_PREFIX` in `naming.ts`) following `plugins.md` §5.2. Fields: `id`, `name`, `version`, `publisher`, `license`, `compatibility` (`studio`, `pluginApi`), `capabilities[]`, `runtime`, `providers[]`, `ui.contributions`, `ui.module`, `skills[]`, `permissions.{required,optional}`, `resources`, `events.subscribes`.
  - `runtime.kind` is one of `browser-bundled` (UI-only first-party plugins, new), `python-worker`, or `none`.
  - The `ui.module` field, which points a first-party plugin at its trusted TS manifest, is new as well.
  - Use `.strict()` so unknown privileged fields are rejected (§5.2).
- [x] `packages/plugin-contracts/src/ui-contributions.ts`: a zod schema for `ui/contributions.json` (§5.3): `toolbarActions[]`, `panels[]`, each with `id`, `surface`, `title`, `command` / `renderer`, `visibleWhen` / `dataBinding`.
- [x] `packages/plugin-contracts/src/capabilities/`: one file per capability id, starting with `image.segment` (request and result schemas from §6.1 as zod; mask encoding RLE or artifact PNG; pixel XYXY).
- [x] `scripts/emit-schemas.mjs`: also emit `schemas/plugin.v1.json`, `schemas/ui-contributions.v1.json` and `schemas/capabilities/*.json`. These are the shared source for the Python kernel (Phase 4 generates pydantic models from them).

### 2.2 A manifest for every first-party plugin
- [ ] Write `plugins/<name>/plugin.yaml` for image2d, volume, timeseries, video, cine, cardiac-metrics, wsi, text-spans and export-dicom. Use `runtime.kind: browser-bundled` and `ui.module: ui/manifest.ts`. Permissions are empty: these are UI-only and run in the trusted origin. Add a `README.md` at the plugin root (move the module README up one level). _(partial: every `plugin.yaml` exists; `plugins/export-dicom/README.md` is missing)_
- [x] Write `plugins/_template/plugin.yaml` plus a commented `ui/contributions.json`. This template is what the coder worker copies in Phase 9.
- [x] `apps/web/src/extension-host/manifests.ts`: load the plugin manifests at build time (`import.meta.glob("../../../../plugins/*/plugin.yaml", { query: "?raw" })` plus `yaml` parse, or convert them to `plugin.json` if you'd rather not add a YAML dependency) and validate them against the contract.
- [x] Test `extension-host/manifests.test.ts`:
  - every `plugin.yaml` validates;
  - its `id`/`version` equal the TS module's;
  - every module in `bundled.ts` has a `plugin.yaml`.

### 2.3 Declarative UI contributions with trusted renderers
- [x] `apps/web/src/extension-host/surfaces.ts`: map `plugins.md` surfaces to existing slots, so declarative contributions land where today's code-backed ones do:

| Surface | Slot / place today |
|---|---|
| `image.viewer.toolbar` | tool strip (`ToolContribution`), viewport bar (`panels.viewport-bar`) |
| `annotation.inspector` | inspector rows / right panel |
| `studio.panel.left` / `.right` / `.bottom` | `PanelSlot` left / right / bottom |
| `command.palette` | `CommandContribution` |

- [x] `apps/web/src/extension-host/trusted-renderers.ts`: a registry from versioned renderer names to components.
  - `studio.declarative-panel.v1` → the tier-2 panel from `agent-panels/`
  - `studio.sandbox-frame.v1` → the tier-3 iframe
  - later `studio.mask-review.v1` (Phase 6)

  Unknown names fail closed and show a "renderer not available" notice.
- [x] `apps/web/src/extension-host/contributions-loader.ts`: turn a plugin's `ui/contributions.json` into synthetic registry contributions under the plugin's id.
  - A toolbar action becomes a command contribution with `when` built from `visibleWhen`.
  - A panel becomes a panel contribution whose component is the named trusted renderer, with `dataBinding` resolved through the tier-2 binding code (`agent-panels/bridge.ts`: `selectValue`, runtime keys).

  This makes "a plugin with no React" possible for non-first-party plugins.
- [x] Command dispatch: a declarative `command: "<ns>.<plugin>.<tool>"` goes to `extension-host/gateway.ts`. In this phase it only calls local command handlers. In Phase 4 it POSTs to the kernel command gateway.
- [x] Tests:
  - a fixture plugin with only `plugin.yaml` and `contributions.json` shows a toolbar button on PNG items and not on DICOM;
  - an unknown renderer fails closed.

---

## Phase 3. Workspace activation in the web app

Today every bundled module is registered at boot (`for (const m of MODULES) registry.registerModule(m)`). `plugins.md` requires per-workspace installation (acceptance test 1) and activation without a deploy (Phase 1 exit in `plugins.md`).

- [x] `packages/plugin-contracts/src/workspace.ts`: `WorkspaceInstallation { pluginId, version, artifactDigest?, configRevision, state }` and `WorkspaceState { workspaceId, plugins: WorkspaceInstallation[], environment: EnvironmentSpec }`.
- [x] `extension-host/registry.ts`:
  - split *available* (bundled, known) from *active* (installed in this workspace);
  - add `activate(pluginId)`, `deactivate(pluginId)` and a change event;
  - `requires` still pulls in dependencies, but only from *available*, and a missing dependency is reported, not silently added (§14 #11).
- [x] `extension-host/resolve.ts` and `catalog.ts`: resolve and catalogue against *active* plugins only. The catalogue the agent sees (`/api/catalog`, `list_modules`) must not list inactive plugins.
- [x] `extension-host/bundled.ts`: register bundled plugins as *available*, then activate the set from the workspace state. In dev, read it from `seed-data/<project>/workspace.json` or default to "all bundled". In Phase 5, read it from the kernel Workspace API.
- [x] React: the Studio subscribes to registry changes and re-resolves. Enabling a plugin at runtime adds its tools and panels without a reload. Disabling it removes them; annotations of its geometry types stay in the store and are shown as "unavailable type" rather than dropped (§14 #9).
- [x] Agent tools (`extension-host/agent.ts`, `scripts/mcp.mjs`):
  - add `list_capabilities` (from active manifests);
  - add `inspect_plugin(id)` (manifest + contribution summaries);
  - keep `list_modules`, `get_environment` and `patch_environment`.

  Install and activate tools come in Phase 7, through the kernel.
- [x] Tests:
  - two workspaces with different plugin sets see different catalogues;
  - activate then deactivate restores the previous resolved environment exactly;
  - e2e: enabling the WSI plugin (`<ns>.wsi`) on a workspace without it makes the pathology preset resolvable.

---

## Phase 4. Kernel (`apps/api`, Python): `plugins.md` §6 and Phase 0

New code. Nothing to move, except the dev seed endpoints.

- [x] Scaffold `apps/api` with `uv` (Python 3.12), FastAPI, pydantic v2, SQLAlchemy 2 + Alembic, SQLite in dev and Postgres later. Layout: `src/studio_api/{kernel,plugins,routes}/` (no `agents/`, per D1), `tests/`.
- [ ] `kernel/contracts/`: generate pydantic models from `schemas/*.json` (`datamodel-code-generator`, pinned) into `kernel/contracts/_generated/`. CI fails if regeneration produces a diff. _(partial: `scripts/gen_contracts.py --check` exists and passes; no CI wires it in)_
- [x] Kernel APIs, each a router plus a service, all with `workspace_id`, principal, `correlation_id` and an idempotency key taken from the request context, **never** from the body (§6):
  - **Assets:** metadata, short-lived signed URLs (HMAC in dev), derived artifacts. Port the seed-file serving from `apps/web/dev/seed-server.ts`.
  - **Annotations:** canonical schema (from `plugin-contracts`), provenance, review state, the v1→v2 migration. Port the `/api/annotations/:id` endpoints from the seed server.
  - **Command gateway:** `POST /v1/commands { capability | tool, input }`. It resolves the active plugin and version, validates input against the capability schema, checks grants and budget, routes to execution, validates output, then commits and writes the audit entry.
  - **Jobs:** enqueue, progress, cancel, retry, idempotency, cost. Start with a DB-backed queue polled by `apps/worker`; no Redis yet.
  - **Events:** typed outbox table with at-least-once delivery, a rate limit and a recursion guard.
  - **Secrets broker:** secrets stored encrypted (dev key from `secrets/api.env`); workers receive a proxied call or a short-lived scoped token, never plaintext in agent context or the UI.
  - **Workspace API:** active plugin versions, config revisions, environment spec.
  - **Audit API:** append-only.
- [x] `apps/web/vite.config.ts`: proxy `/api/*` (except `/api/agent`) to `apps/api` on `127.0.0.1:8000`. Keep the seed server as a fallback behind a flag until the e2e suite passes against `apps/api`.
- [x] `apps/web/src/extension-host/gateway.ts`: POST plugin commands to `/api/v1/commands`. `assetUrl()` in the host API calls the Asset API.
- [x] **Exit (`plugins.md` Phase 0):** a hardcoded first-party `image.segment` command with a mock provider (fixed masks) runs through the gateway, stores provider-independent masks as canonical annotations, and they render in the image viewer.

---

## Phase 5. Control plane: registry, resolver, installer (`plugins.md` §7, §11)

- [x] `registry/index.json` (curated): one entry per plugin version with id, publisher, version, artifact digest, capabilities, media types, runtime, permissions, licence (code, model and service terms separately, §5.2), cost hints, compatibility and trust tier. `scripts/build-registry.mjs` builds it from `plugins/*/plugin.yaml` and digests each plugin folder (a tarball of `plugins/<name>` minus `ui/node_modules`).
- [x] Turn `plugins/*` into workspace packages now (D5): add `plugins/*` to `pnpm-workspace.yaml`, a `package.json` per plugin, and pinned versions.
- [x] `apps/api/src/studio_api/plugins/`:
  - `catalog.py`: search and inspect the registry.
  - `resolver.py`: semver constraints, kernel API compatibility, cycles and conflicts, which are surfaced and never auto-rewritten (§14 #11).
  - `installer.py`: the §7.2 state machine (`REQUESTED → RESOLVED → STAGED → VALIDATED → AWAITING_APPROVAL → ACTIVATED | REJECTED`, then `DISABLED` / `ROLLED_BACK`), with atomic activation of `{plugin_id, version, artifact_digest, config_revision}`.
  - `policy.py`: grants per plugin version, workspace and actor, keeping *requested*, *granted* and *used* distinct (§10.1).
- [x] Alembic migration with the §11 tables: `plugin_packages`, `plugin_versions`, `workspace_plugins`, `workspace_plugin_grants`, `workspace_plugin_configs`, `plugin_capabilities`, `plugin_jobs`, `plugin_events`, `plugin_audit`.
- [x] Routes: `GET /v1/plugins`, `GET /v1/plugins/:id`, `POST /v1/workspaces/:id/plugins/plan`, `.../stage`, `.../approve`, `.../activate`, `.../disable`, `.../rollback`, `GET /v1/workspaces/:id/state`.
- [x] Web: an install-review dialog (`apps/web/src/studio/components/plugins/InstallReview.tsx`) shows the diff: modules, permissions, secrets, egress hosts, estimated spend, data residency and UI surfaces. Approve calls `.../approve`. Phase 3's activation reads `GET /v1/workspaces/:id/state`.
- [x] Settings page: installed plugins with version, state, disable and rollback.

---

## Phase 6. Python plugin worker and the reference segmentation plugin (`plugins.md` §5.1, §12)

- [ ] `packages/plugin-sdk-py` (uv package `studio-plugin-sdk`, import name `studio_plugin_sdk`): _(partial: `Registry` tools, `ToolContext` with assets/jobs/brokered secrets, RLE/PNG mask helpers; no `annotations.write` client, results go back through the gateway)_
  - a `register(tool)` decorator;
  - a `ToolContext` with scoped clients: `assets.read`, `annotations.write`, `jobs.progress`, `secrets.use(name)` (brokered);
  - no DB or network handles;
  - `normalize` helpers for canonical masks (RLE, artifact PNG).
- [x] `apps/worker`:
  - pulls jobs from the kernel;
  - runs each plugin in its own process with a per-plugin `uv` environment from the plugin's `uv.lock`;
  - enforces timeout, CPU and memory limits and per-plugin egress (dev: allowlist through a proxy; prod: network policy);
  - reports results to the gateway, which validates and commits them.

  A plugin crash fails only its own job (§14 #6).
- [ ] `plugins/segmentation/` exactly per §5.1: _(partial: full layout and 9 passing tests; `meta_sam.py` is a placeholder not verified against Meta's current API)_
  - `plugin.yaml` (`id: <ns>.segmentation`, `runtime.kind: python-worker`);
  - `pyproject.toml` and `uv.lock`;
  - `skills/segmentation/SKILL.md`;
  - `src/segmentation_plugin/{tools.py, normalize.py, providers/{base.py, mock.py, meta_sam.py, local_sam.py}}`;
  - `ui/contributions.json` (toolbar "Segment" on `image/*`, inspector panel `studio.mask-review.v1`);
  - `tests/` (contracts, mock provider, permissions);
  - `fixtures/sample_image.png`.
  - `meta_sam.py` must follow the **current** Meta API docs at integration time. Don't copy the §6.1 abstraction as if it were the upstream signature.
- [x] `packages/studio-renderers/src/mask-review/`: a trusted `studio.mask-review.v1` renderer that overlays instances (reusing overlay2d/cornerstone mask drawing), with accept, reject and edit per instance. Edits write canonical annotations with provenance (`provider`, `model`, `prompt`, `review_status`).
- [x] Budgets: estimate the cost before a batch from provider metadata (`effective_at`, `source_url`), and deny before any billable call (§14 #10).
- [ ] **Exit (`plugins.md` Phase 1):** "Add segmentation" (by hand through the install dialog for now) activates the toolbar, masks work with the mock provider in CI, and no web deploy was needed. _(partial: `apps/web/e2e/plugins_test.py` passes 8/8 locally against the kernel and a worker (2026-10-30); there's no CI yet)_

---

## Phase 7. Agent integration (`apps/agent`, pi): `plugins.md` §8

Coordinate with the `todo/todo1.md` work: start only after its sessions, client tools and approvals sections have landed, and add to them rather than reworking them.

- [x] Naming: `apps/agent` currently hardcodes the brand in `src/sandbox/defaults.ts` (`APP_LABEL`, sandbox name prefix) and in its prompts. Read these from `schemas/naming.json` (`resourcePrefix`, `displayName`) instead (D3). _(`src/naming.ts`; prompts use `{{displayName}}`; `AGENT_NAMING_FILE` overrides the path)_
- [x] `apps/agent/src/tools/kernel.ts`: server tools that call `apps/api` with a session-scoped token. The principal and workspace come from the session record, never from tool arguments.
  - **Builder** tools (`plugins.md` §8.1): `inspect_workspace`, `list_capabilities`, `search_plugins`, `inspect_plugin`, `plan_plugin_change`, `stage_plugin`, `run_plugin_checks`, `request_install_approval`, `activate_plugin`, `configure_plugin`, `disable_plugin`, `rollback_plugin`, and `create_plugin_sandbox` (Phase 9).
  - **Task** tools (`plugins.md` §8.2): `list_assets`, `invoke_capability`, `create_job`, `get_job_status`, `list_annotations`, `export_dataset`.
- [x] `apps/agent/src/agent/profiles.ts`: add a `builder` profile (builder tools plus environment client tools, no data-plane writes) and a `task` profile (task tools only), so the two permission sets stay separate (§8).
- [x] Approval: `request_install_approval` and `activate_plugin` always go through the existing approval broker and the web install-review dialog. Activation for an approved, low-risk settings change can take the streamlined path (§7.2).
- [x] Prompt hygiene:
  - The agent sees capability summaries. It fetches full schemas and `SKILL.md` lazily (`inspect_plugin`), never all at once (§8.2).
  - Plugin skills and READMEs are wrapped as untrusted content (§10). A skill can't make the agent install code (§14 #4); `policy.ts` blocks `stage_plugin` unless the user asked for it in this run.
- [x] Preference order (§7.1) in the builder prompt: installed, then vetted plugin, then compose, then fork in sandbox, then author new.

---

## Phase 8. Acceptance tests (`plugins.md` §14)

Each item from §14 becomes a test, kept in a single file per area:

| §14 | Test |
|---|---|
| 1 workspace isolation | `apps/api/tests/test_workspace_isolation.py`, plus web catalogue test (Phase 3) |
| 2 unapproved plugins can't invoke | `test_gateway_policy.py` |
| 3 undeclared egress fails closed | `apps/worker/tests/test_egress.py` |
| 4 skill can't trigger install | `apps/agent/test/unit/builder-policy.test.ts` |
| 5 invalid provider output → recoverable job error | `plugins/segmentation/tests/test_contracts.py` + gateway output validation |
| 6 worker timeout doesn't affect API | `apps/worker/tests/test_isolation.py` |
| 7 idempotent re-run | `test_jobs_idempotency.py` |
| 8 provider switch preserves masks | `test_provider_switch.py` |
| 9 rollback keeps annotations | `test_rollback.py` + web e2e |
| 10 budget denial before billable call | `test_budget.py` |
| 11 dependency conflicts surfaced | `test_resolver.py` |
| 12 generated UI never runs in the main origin | web e2e: a tier-3 iframe has `sandbox` without `allow-same-origin`; a contributions loader test rejects `renderer` values that aren't in the trusted registry |

---

## Phase 9. Agent-authored plugins (`plugins.md` §9, Phase 3)

Start only after Phases 4–6, because it needs the registry, validator and worker.

- [x] `create_plugin_sandbox` uses the existing Daytona layer in `apps/agent/src/sandbox/`. It copies `plugins/_template` into a fresh sandbox (labelled `purpose=plugin-build`) with `networkBlockAll` or a package-index-only allowlist, and fake credentials. _(the template minus its trusted TS UI, id rewritten, `ui.module` dropped; package-index allowlist where the org tier allows egress rules)_
- [x] The coder edits only the mounted plugin source. `run_plugin_checks` runs `uv sync --locked`, the plugin's tests, manifest validation and a dependency and licence scan inside the sandbox.
- [x] The artifact builder (`apps/api/src/studio_api/plugins/artifacts.py`):
  - takes the package as a tarball;
  - computes a digest and signature (a dev signing key; sigstore later);
  - stores it in a private artifact store (a local dir in dev);
  - registers it with `trust_tier: generated`.

  Generated plugins may only use declarative UI (D2).
- [x] Review: the install dialog shows the code diff as well as the permissions, and installs to the current workspace only, with rollback.

---

## How much is "file moving"

| Phase | Kind | Rough size |
|---|---|---|
| 1 | **Moves**, plus one mechanical codemod (host API) | about 180 files under `platform/` and `modules/` plus the kits (about 13k lines), mostly renames. The only design work is the host API (about 30 selectors and helpers) and the boundary script. |
| 2 | Small new code next to existing manifests | about 10 YAML files, 3 schemas, a loader and tests |
| 3 | Registry refactor (available vs active) | medium; touches `registry.ts`, `resolve.ts`, `catalog.ts` and the Studio root |
| 4–6 | **All new** (Python kernel, control plane, worker, SDK, first plugin) | most of the work in `plugins.md` |
| 7 | Additive tools and profiles in `apps/agent` | small to medium, after `todo1.md` |
| 8–9 | Tests and the sandbox authoring flow | medium |
