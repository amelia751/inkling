# Modular viewers: from six medical adapters to agent-composed environments

**Goal.** An agent can boot an annotation environment for *any* data type and task (medical or not) by writing a declarative **environment spec** that references **modules**. Modules can be added, removed, swapped or reconfigured without touching the shell. Medical stays first-class but becomes six presets, not six hardcoded code paths.

All paths are relative to `apps/web/src/` unless they start with `apps/`, `seed-data/` or `todo/`.

> **Status (2026-10-29, branch `modular-viewers` in worktree `../inkling-modular`):** phases 0–9 are done. All six viewers
> are modules, `viewers/` is gone, and `check:boundaries --strict` passes. The full e2e suite is green: 8 suites, 162/162,
> plus 10/10 in environments_test.py. Still open: the optional `text-spans` module, MCP exposure, safety tiers 2–3
> (documented only), `[~]` means partly done; the note says what's left.

---

## 0. Audit summary (why this work is needed)

What already works and should be kept:

- `viewers/ViewerAdapter.ts` is a real boundary: `{ kind, tools, Component, inspect, exporters }`. Annotations go through one store (`stores/studio.ts`) with undo, batch and provenance.
- `viewers/shared/` (geometry, draw, `useViewport2D`, `useCanvasSize`) and `viewers/cornerstone/` are real shared layers.
- The pathology viewer splits an imperative engine (`pathology/controller.ts`) from a thin React shell (`PathologyViewer.tsx`). That split is the target shape for every viewer.
- Exporters are already pluggable per adapter.

What blocks modularity:

| # | Problem | Where |
|---|---|---|
| A | A closed enum of viewer kinds is used as the switch key across the shell | `types/index.ts` (`ViewerKind`), `lib/items.ts`, `lib/format.ts`, `lib/shortcuts.ts`, `CanvasToolbar.tsx:146`, `DatasetStudioPage.tsx`, `WorkspacePage.tsx` |
| B | One adapter per project. You can't compose a renderer from one module with tools, panels and exporters from others | `viewers/registry.ts`, `Project.viewer` |
| C | Closed unions for tools and geometry. Adding a tool or geometry means editing core types, `TOOL_META`, `TOOL_KEYS` and `describeGeometry` | `stores/studio.ts` (`Tool`), `types/index.ts` (`Geometry`), `CanvasToolbar.tsx` (`TOOL_META`), `lib/shortcuts.ts` (`TOOL_KEYS`), `LeftSidebar.tsx` (`describeGeometry`) |
| D | Domain vocabulary is baked into core geometry: `beat`, `wave`, `rhythm`, `phase`, WFDB codes, SNOMED special case in `setClass` | `types/index.ts:123-138`, `stores/studio.ts:224` |
| E | Viewer-specific shortcuts live in the central table, keyed by viewer kind (about 40 entries) | `lib/shortcuts.ts:43-100` |
| F | Hidden channels between a viewer and its adapter: module-level singletons read by `inspect` | `video/VideoViewer.tsx:41` (`videoPlayhead`), `cine4d/model.ts:502` (`knownGrids`), `signal/record.ts:34` (`cachedInfo`) |
| G | Side panels are rendered *inside* viewers, so the shell can't place, hide or reuse them | `signal/SidePanel.tsx`, `cine4d/MetricsPanel.tsx`, `cine4d/PhaseMatrix.tsx`, `PathologyViewer.tsx` (`CountsPanel`, `AdjustPopover`, `ImportButton`) |
| H | Viewers import each other's internals | `cine4d/{Cine4DViewer,render,PhaseMatrix}.ts(x)` import `volume3d/nifti` |
| I | Three separate implementations of 2D vector editing (polygon draft, handles, hit-test, move) | `video/overlay.ts` + `VideoViewer.tsx`, `cine4d/Cine4DViewer.tsx`, `pathology/controller.ts` + `scene.ts` |
| J | Five private sets of viewport-bar buttons | `TB`/`Transport` (cine), `Seg`/`Pick`/`Toggle` (signal), `IconButton`/`TextButton` (video), `BarButton`/`BarSelect` (cornerstone/ui), pathology inline |
| K | 1,000-line React components mix data loading, view state, tool state machines, rendering and chrome | `Volume3DViewer.tsx` (1251), `Cine4DViewer.tsx` (1167), `VideoViewer.tsx` (1108), `SignalViewer.tsx` (1067) |
| L | Labels are `string[]`. There are no colors, hotkeys, allowed geometries, attributes or hierarchy, and semantics are guessed from label text (cine `structures(labels)` matches "left ventricle") | `types/index.ts` (`Project.labels`), `cine4d/model.ts` |
| M | Tool options are one global struct whose meaning varies by viewer (`brushThreshold` hidden for pathology through a kind check) | `stores/studio.ts` (`ToolOptions`), `CanvasToolbar.tsx:146` |
| N | Task semantics are string checks: `project.task === "classification"` | `LeftSidebar.tsx:102`, `ReviewPage.tsx:33` |
| O | Fixed layout: left sidebar with Files/Labels/Review tabs, canvas, optional AI panel | `DatasetStudioPage.tsx`, `LeftSidebar.tsx` |
| P | The agent can't do anything: no machine-readable catalogue, schema, validation or API to change the environment | `components/studio/AiAssistantPanel.tsx`, `apps/web/dev/seed-server.ts` |
| Q | No unit-test runner and no import-boundary check, so the module boundary can't be enforced | `apps/web/package.json` |

---

## 1. Target architecture (what "modular" means here)

Four layers. Each depends only on the ones above it.

1. **Platform** (`platform/`): contracts, registry, environment schema, resolver, runtime context, agent catalogue. Contains no domain code.
2. **Kits** (`kits/`): reusable, domain-neutral building blocks used by many modules:
   - `kits/overlay2d`: vector editing on a 2D image plane
   - `kits/viewport-chrome`: viewport bars, transport controls, legends
   - `kits/timeline`: time ruler, playhead, spans
   - `kits/io`: NIfTI, DICOM, WFDB, video frame sources, zip
   - `kits/cornerstone`: today's `viewers/cornerstone/`
3. **Modules** (`modules/<id>/`): one folder per capability bundle. Each has a static `manifest.ts` (pure data, readable without loading code) and a lazy `load()` that returns implementations keyed by contribution id.
4. **Environments**: JSON documents (seed manifest, presets, or agent-written) that pick modules and configure them.

### Contribution types a module can declare

| Contribution | Replaces | Example |
|---|---|---|
| `dataKinds` | `lib/items.ts` switch, `ITEM_NOUN`, `VIEWER_META` | `{ id: "raster-pyramid", match: { ext: [".dzi", ".svs"] }, itemNoun: "slide", icon, groupItems(assets) }` |
| `renderers` | `adapter.Component` | `{ id: "osd", consumes: ["raster-pyramid"], space: "image2d", capabilities: [...] }` |
| `geometries` | closed `Geometry` union, `describeGeometry` | `{ id: "track", schema: zod, describe(g), inspect(a, ctx) }` |
| `tools` | `Tool` union, `TOOL_META`, `TOOL_KEYS` | `{ id, label, hint, icon, group, hotkey, creates: "polygon", when: "renderer.space == image2d", optionsSchema }` |
| `commands` + `keybindings` | viewer-keyed `SHORTCUTS` entries | `{ command: "video.stepFrame", keys: ["ArrowLeft"], when: "renderer == video", replaces: ["core.nextItem"] }` |
| `panels` | `SidePanel`, `MetricsPanel`, `CountsPanel`, Labels/Review tabs | `{ id, slot: "left" \| "right" \| "bottom" \| "viewport-bar", title, configSchema }` |
| `inspectors` | `adapter.inspect` | per-geometry rows; reads the runtime context, not singletons |
| `exporters` | `adapter.exporters` | unchanged `Exporter`, plus `accepts: geometryIds[]` |
| `labelControls` | `project.labels: string[]` | Label Studio style: `{ tag: "PolygonLabels", geometry: "polygon" }` |
| `reviewRules` | `ReviewPage` classification check | `{ id: "source-label-disagreement", applies: { geometry: "class" } }` |
| `presets` | hardcoded six viewers | `preset:pathology`, `preset:ecg-12lead` |

### Environment spec (what the agent writes)

```jsonc
{
  "$schema": "inkling://schema/environment/v1",
  "id": "retail-shelf-boxes",
  "extends": "preset:image-2d",              // optional
  "modules": { "inkling.image2d": "^1", "inkling.export.coco": "*" },
  "data": { "kind": "inkling.image2d.dataKinds.raster" },
  "labels": [
    { "name": "products", "control": "RectangleLabels", "toName": "main",
      "classes": [{ "id": "cereal", "color": "#e66", "hotkey": "1" }, { "id": "soda" }],
      "attributes": { "occluded": { "type": "boolean" } } }
  ],
  "viewports": [{ "name": "main", "renderer": "inkling.image2d.renderers.cornerstone-stack",
                  "config": { "windowLevel": false } }],
  "tools": ["inkling.core.tools.select", "inkling.core.tools.pan", "inkling.overlay2d.tools.box"],
  "panels": { "left": ["inkling.core.panels.files", "inkling.core.panels.labels", "inkling.core.panels.review"],
              "right": ["inkling.core.panels.ai"] },
  "exporters": ["inkling.export.coco.exporters.coco"],
  "overrides": [{ "id": "inkling.image2d.tools.cobb", "disabled": true }],
  "layout": null                               // null = auto; else dockview toJSON()
}
```

Ids follow OHIF's form `<moduleId>.<contributionType>.<name>`. Everything is validated against a JSON Schema generated from the live registry, so invalid ids are caught at validation time and never reach runtime.

### Frameworks decision

- **Adopt now:** `zod` v4 (contribution and environment schemas, plus `z.toJSONSchema` for the agent catalogue) and `vitest` (registry and resolver unit tests).
- **Adopt in phase 9:** `dockview` (agent-serializable layout), and `@rjsf/core` v6 or JSON Forms (auto-built config forms from `configSchema`).
- **Later, behind a flag:** `@json-render/*` for panels the agent generates from a shadcn catalogue; an MCP Apps host for sandboxed agent-written UI; Module Federation once third parties ship modules.
- **Copy as patterns only:** OHIF extensions/modes, VS Code `contributes` + `when`, Label Studio `name`/`toName`, Backstage `attachTo` + overrides, JupyterLab `requires`/`optional`/`provides`, kiwifs `FenceSpec` (one self-describing spec with schema, example, summary), tldraw `ShapeUtil`/`StateNode` split.
- **Avoid:** forking OHIF; Label Studio's frontend (deprecated as standalone); tldraw as a dependency (license key required in production); tambo (hosted cloud shuts down 2026-10-31); golden-layout; Theia, single-spa, Piral.
- **Evaluate, don't migrate yet:** Cornerstone3D 5.14 (installed) ships `GenericViewport` with `WHOLE_SLIDE_NEXT`, `ECG_NEXT` and `VIDEO_NEXT`. Spike it as an *alternative renderer module* for WSI, ECG and video. Keep the custom renderers until it matches their features.

---

## Phase 0: Guardrails (do first, about half a day)

**`apps/web/package.json`**
- [x] Add `zod@^4` to dependencies. Add `vitest` and `@vitest/coverage-v8` to devDependencies.
- [x] Add scripts: `"test": "vitest run"`, `"check:boundaries": "node scripts/check-boundaries.mjs"`, `"emit:schemas": "node scripts/emit-schemas.mjs"`.

**`apps/web/vite.config.ts`**
- [x] Add a `test: { environment: "jsdom", include: ["src/**/*.test.ts"] }` block (or a separate `vitest.config.ts`).

**`apps/web/scripts/check-boundaries.mjs`** (new; model it on `scripts/check-icons.mjs`)
- [x] Fail if `platform/**` imports from `modules/**`, `kits/**` or `components/studio/**`.
- [x] Fail if `kits/**` imports from `modules/**`.
- [x] Fail if `modules/A/**` imports `modules/B/**` internals. Only `modules/B/manifest.ts` and `modules/B/public.ts` are allowed.
- [x] Fail if the shell (`app/**`, `components/studio/**`, `lib/**`) imports anything under `modules/**` except through `platform/`.
- [x] Until phase 6, run it in warn-only mode with an allowlist that shrinks as each viewer migrates.

**`apps/web/e2e/`**
- [x] Record a green baseline of every `*_test.py` before refactoring. Each phase below must keep it green. Its `data-testid`s (e.g. `volume-3d`, `plane-*`, `viewer-status`) are the regression contract, so keep them.

---

## Phase 1: Platform contracts (new `platform/` folder)

**`platform/module.ts`** (new)
- [x] Define `ModuleManifest`: `{ id, version, title, description, engines, requires?, optional?, activation?, contributes, load }`.
- [x] Define the contribution interfaces listed in section 1. Every contribution has `id`, a one-line `description` (shown to the agent, kiwifs style) and an optional `configSchema: ZodType`.
- [x] Add `defineModule(m)`, an identity helper that type-checks and freezes. `load()` returns `Promise<ModuleImpl>`, keyed by the same contribution ids (components, functions).
- [x] Define `RendererProps` (replaces `ViewerProps`): `{ env, viewport, item, config, runtime }`. `runtime` is the context API from `platform/runtime.ts`.

**`platform/registry.ts`** (new; replaces `viewers/registry.ts`)
- [x] `registerModule(manifest)` is idempotent. It indexes every contribution under its full id `<module>.<type>.<name>`.
- [x] Add `get(type, id)`, `list(type, filter?)`, `loadImpl(id)` (lazy, cached) and `modulesFor(dataKind)`.
- [x] Detect duplicate ids and hotkey conflicts per resolved environment (move `findConflicts` here from `lib/shortcuts.ts`).

**`platform/environment.ts`** (new)
- [x] Zod `EnvironmentSpec` matching section 1, plus `LabelSchema` (classes with `id`, `name`, `color?`, `hotkey?`, `parent?`, `allowedGeometries?`, `attributes?` as a JSON-Schema subset).
- [x] `environmentJsonSchema(registry)` builds the JSON Schema with `enum`s of real registered ids, so the agent can't invent ids.

**`platform/resolve.ts`** (new)
- [x] `resolveEnvironment(spec, registry): { env: ResolvedEnv } | { errors: EnvError[] }`.
- [x] Apply `extends` (deep-merge the preset), then `overrides` (`disabled`, `config`).
- [x] Check that every `requires` is met; that each renderer `consumes` the data kind; that each tool's `creates` geometry is supported by its viewport's `space`; that each label `toName` names a viewport; that each exporter `accepts` at least one geometry in use; and that hotkeys are unique within a `when` scope.
- [x] Errors are structured (`{ path, code, message, suggestion }`, A2UI `ValidationFailed` style) so an agent can repair them.
- [x] Return `ResolvedEnv`: ordered tools, keybindings, panels by slot, exporters, label schema, merged configs.

**`platform/when.ts`** (new)
- [x] A tiny `when`-clause evaluator: `==`, `!=`, `&&`, `||`, `!`, `in`. Context keys: `renderer`, `renderer.space`, `tool`, `dataKind`, `selection.count`, `drafting`, plus anything a module publishes. No `eval`.

**`platform/runtime.ts`** (new; fixes problem F)
- [x] A per-item runtime context store (a Zustand slice or `createStore`): `publish(itemId, key, value)`, `useRuntime(itemId, key)`, `getRuntime(itemId, key)`.
- [~] Renderers publish `playhead`, `grid` (spacing/dims), `signalInfo` (fs), `viewportState`. Inspectors and panels read from it. _(store + API done; viewers publish in phase 6)_

**`platform/commands.ts`** (new; fixes problem E)
- [x] Command registry: `registerCommand(id, handler, { when })`, `execute(id, args)`. Handlers return `false` to fall through, matching today's `useShortcuts` semantics.
- [x] Keybindings come from the resolved env and map keys to commands. Rebuild `lib/hotkeys.ts` on top of this, keeping its priority model (`SHELL_PRIORITY`).

**`platform/catalog.ts`** (new; agent surface, like kiwifs `kiwi_widget_reference`)
- [x] `describeCatalog()` returns every module and contribution with description, config JSON Schema, an example and `consumes`/`creates` edges.
- [x] `catalogPrompt()` returns compact markdown for the AI panel's system prompt.

**`platform/*.test.ts`** (new)
- [x] Resolver tests: valid preset resolves; unknown id, missing `requires`, tool/space mismatch and hotkey clash each produce the expected error; `extends` + `overrides` merge.

---

## Phase 2: Generalize the data model

**`types/index.ts`**
- [x] Delete `ViewerKind`. Replace `Project.viewer` with `Project.environment: EnvironmentSpec | { preset: string }`. Keep a migration shim (`viewer: "pathology"` maps to `{ extends: "preset:pathology" }`) in `lib/api.ts`.
- [x] Replace `labels?: string[]` with `labels?: LabelGroup[]` (from `platform/environment.ts`). Add `labelNames(env)` for the transition.
- [x] Split `Geometry` into **core geometries** that stay in this file and are domain-neutral: `class`, `box`, `ellipse`, `polygon`, `multipolygon`, `polyline`, `spline`, `keypoint`, `point3d` (today's `point`), `measurement`, `mask`, `span` (start/end on a time axis, optional `channel`), `instant` (t or frame, optional `channel`), `track`.
- [~] Re-express the medical geometries on core ones, carrying their codes in `attributes`: _(types, migration and tests done; each viewer switches over in phase 6 via MIGRATED_V1_TYPES in lib/api.ts)_
  - `interval` becomes `span` with `channel: lead`
  - `beat` becomes `instant` with `channel` and `attributes.code`
  - `wave` becomes `span` with `attributes.wave` and `attributes.peak`
  - `rhythm` becomes `span` with `channel: "rhythm"` and `attributes.rhythm`
  - `phase` becomes `instant` with `attributes.phase`
  - `segment` becomes `span`; `event` becomes `instant`; `mark` becomes `keypoint` with no placement

  Keep the module-specific *validation* in the owning module's `geometries` contribution, which refines the attributes schema.
- [x] Allow module geometries: `{ type: \`${string}.${string}\`; [k: string]: unknown }` validated by the registry, for cases core can't express.
- [x] Add `annotationsVersion` to `AnnotationDocument`, plus `migrations/annotations-v1-to-v2.ts` (new) that rewrites stored medical geometries into core ones. Run it on load in `lib/api.ts`.
- [x] `StudioItem`: add `dataKind: string`; drop nothing else.

**`stores/studio.ts`**
- [x] `Tool` becomes `type ToolId = string`. Delete the union; the source of truth is the registry.
- [x] `ToolOptions` becomes `toolOptions: Record<ToolId, Record<string, unknown>>`, defaulted from each tool's `optionsSchema`. Add `useToolOption(toolId, key)`. Brush size becomes an option of `overlay2d.tools.brush` and of `cornerstone.tools.brush`. Each declares its own options, so the `brushThreshold` hack goes away.
- [x] Remove the SNOMED special case from `setClass`. Add `setClass(itemId, label, author, { group })`, where single- versus multi-valued is read from the label group's `control` (`Choices` with `multiple: true`).
- [x] Add `env: ResolvedEnv | null` and `setEnv(env)` (with undo stack `envPast`/`envFuture`), so agent edits are undoable separately from annotation edits.
- [x] Keep `newAnnotation`, `visibleFor` and `isEditable` unchanged.

**`seed-data/manifest.json`** and **`scripts/fetch-seeds.py`**
- [x] Emit `environment: { extends: "preset:<id>" }` instead of `viewer`. Emit label groups with colors.
- [x] Keep `viewer` for one release so older checkouts still load.

**`apps/web/dev/seed-server.ts`**
- [x] Add `GET /api/catalog` (returns `describeCatalog()` JSON, built at dev-server start via `emit:schemas`).
- [x] Add `GET/PUT /api/environments/:projectId`, stored in `seed-data/.environments/`, with the same revision semantics as annotations.
- [x] Add `PATCH /api/environments/:projectId` accepting RFC 6902 JSON Patch. Validate server-side with the emitted JSON Schema and return structured errors on failure.

---

## Phase 3: De-hardcode the shell (no viewer changes yet; wrap the six adapters as modules)

**`viewers/registry.ts`**
- [x] Replace it with a thin `legacyAdapterModule(adapter, meta)` that turns each existing `ViewerAdapter` into a `defineModule` with one dataKind, one renderer, its tools, inspectors and exporters. This lets the shell switch to the platform before any viewer is rewritten.

**`viewers/ViewerAdapter.ts`**
- [x] Mark it `@deprecated` and re-export `Exporter`/`ExportContext` from `platform/module.ts`. Delete it at the end of phase 6.

**`platform/presets/*.json`** (new; six files)
- [x] `image-2d`, `volume-3d`, `ecg`, `video`, `cine-4d`, `pathology`: each reproduces today's tools (same order), exporters, labels and panels exactly. The e2e baseline must pass unchanged.

**`lib/items.ts`**
- [x] Delete the `switch`. `projectItems(project)` becomes `registry.get("dataKinds", env.data.kind).groupItems(project.assets)`. Move each case body into its module's dataKind contribution.

**`lib/format.ts`**
- [x] Delete `VIEWER_META` and `ITEM_NOUN`. Add `envLabel(env)`, `envIcon(env)` and `itemNoun(env)` read from the dataKind contribution. Keep `formatBytes` and the `plural*` helpers.

**`lib/shortcuts.ts`**
- [x] Keep only the studio-wide entries (undo, redo, delete, deselect, selectAll, next/prevItem, pickLabel, brush size as a `when: "tool.options.size"` binding, showShortcuts) as `inkling.core` keybindings.
- [x] Move every viewer-specific entry (lines 64-100) into the owning module's manifest as `commands` + `keybindings` with `when` clauses.
- [x] Delete `TOOL_KEYS`; hotkeys move to each tool contribution (and label hotkeys to label classes).
- [x] Delete `POLYGON_VIEWERS`, `VIDEO` and `PLAYBACK_VIEWERS`. They become `when: "renderer.capabilities has 'drafting'"` and similar.

**`lib/hotkeys.ts`**
- [x] Route through `platform/commands.ts`. `useShortcuts(map)` becomes `useCommands(map)`, so modules register handlers by command id. Keep the priority and fall-through behavior.

**`app/routes/DatasetStudioPage.tsx`**
- [x] Load the environment (`/api/environments/:id` or the preset), call `resolveEnvironment`, and put `ResolvedEnv` in the store. Show resolver errors as a full-page message listing `path` and `message`.
- [x] Replace `adapter.Component` with `<ViewportHost viewport={env.viewports[0]} item={item} />` (new `components/studio/ViewportHost.tsx`), which lazy-loads the renderer impl through `registry.loadImpl`.
- [x] `useStudioShortcuts` calls `useCommands` for the `inkling.core.*` commands only.
- [x] Choose the initial tool from `env.tools[0]` instead of `adapter.tools`.
- [x] Stop passing `project.viewer` anywhere.

**`components/studio/CanvasToolbar.tsx`**
- [x] Delete `TOOL_META` and the icon imports. Read `label`, `hint`, `icon`, `group` and `hotkey` from tool contributions in `env.tools`.
- [x] Remove the `project.viewer !== "pathology"` check. Render an options strip from the active tool's `optionsSchema`: number becomes a slider, boolean a checkbox, enum a segmented control. Use RJSF/JSON Forms here in phase 9.
- [x] The `drawing` check becomes `toolContribution.creates !== undefined`.
- [x] Add a `viewport-bar` panel slot on the right so modules can contribute toolbar widgets.

**`components/studio/LeftSidebar.tsx`**
- [x] Turn the hardcoded three tabs into `env.panels.left`. Move `FilesTab`, `LabelsTab` and `ReviewTab` into `modules/core/panels/` as `inkling.core.panels.files`, `.labels` and `.review`.
- [x] `describeGeometry` becomes `registry.get("geometries", g.type).describe(g)`. Core geometries' `describe` lives in `modules/core/geometries.ts`.
- [x] `SelectionInspector` reads rows from the inspector contributions for that geometry (several modules may add rows), passing `runtime` rather than nothing.
- [x] Remove `project.task === "classification"`. Show the "Image label" section when the env has a label group with `control: "Choices"` bound to the item.
- [x] Labels come from `env.labels` (colors, hotkeys), not `labelColor(labels, l)` by index.

**`components/studio/FormatExports.tsx`**
- [x] Read exporters from `env.exporters`, not `adapterFor(project)`.

**`components/studio/ShortcutsDialog.tsx`**
- [x] Take `env` instead of `viewer` + `tools`. List keybindings whose `when` can be true in this env, grouped as before.

**`components/studio/AiAssistantPanel.tsx`**
- [x] Turn it into the `inkling.core.panels.ai` contribution in the `right` slot. Phase 8 adds the agent wiring.

**`components/studio/StudioTopBar.tsx`**, **`CanvasStatusBar.tsx`**
- [x] Use `envLabel`/`itemNoun`. `viewerStatus` stays, and is also published to `runtime` so panels can read structured status.

**`app/routes/WorkspacePage.tsx`**
- [x] Replace `VIEWER_META[project.viewer]` and `ITEM_NOUN[...]` with the `lib/format.ts` env helpers.

**`app/routes/ReviewPage.tsx`**
- [x] Replace the classification check with `env.reviewRules`. Move the source-label disagreement rule to `modules/core/reviewRules.ts`.

**`app/routes/ExportPage.tsx`**
- [x] Put `environment` (resolved ids and versions) into the export manifest next to `task`, so an export records exactly which modules produced it.

**Exit criteria:** `rg "viewer ===|\.viewer\b|ViewerKind" src --glob '!viewers/**'` returns nothing; all e2e tests pass; the six presets resolve with zero errors.

---

## Phase 4: Shared kits (extract duplication before converting viewers)

**`kits/viewport-chrome/`** (new; fixes problem J)
- [x] Move `viewers/cornerstone/ui.tsx` primitives here: `ViewportBar`, `BarButton`, `BarSelect`, `BarSep`, `BarLabel`, `CornerText`, `OrientationMarkers`, `TextPrompt`, `releaseFocusAfterPointer`.
- [~] Add `BarSegmented` (replaces signal `Seg`/`Pick`), `BarToggle` (signal `Toggle`, cine `TB`), `BarIconButton`/`BarTextButton` (video), `Transport` (from cine `Transport`, also used by video), and `Legend` (from cine). _(BarSegmented, BarPick, BarToggle, BarIconButton, BarTextButton, ToolbarButton done; Transport and Legend left for the cine conversion)_
- [~] Delete the private copies in `SignalViewer.tsx:923-1034`, `Cine4DViewer.tsx:1017-1100` and `VideoViewer.tsx:1055-1108`. _(signal, video and cine copies replaced; cine Transport/Legend remain)_

**`kits/overlay2d/`** (new; fixes problem I; the biggest win for non-medical 2D tasks)
- [~] `transform.ts`: image to screen mapping, generalizing `pathology/transform.ts` and `shared/useViewport2D.ts` (camera with zoom, pan, rotation, flip). _(pathology transform moved into kits/overlay2d; generalisation is part of 6.1)_
- [x] `shapes/*.ts`: one tldraw-style `ShapeUtil` per core 2D geometry (`box`, `ellipse`, `polygon`, `multipolygon`, `polyline`, `spline`, `keypoint`), each with `bounds`, `hitTest`, `handles`, `applyHandle`, `translate`, `draw(ctx, style)`. Sources: `video/overlay.ts`, `pathology/scene.ts` + `regions.ts`, and the cine contour code. _(as kits/overlay2d/shapes.ts)_
- [x] `tools/*.ts`: one state machine per drawing tool (`select` with marquee/lasso, `box`, `ellipse`, `polygon`, `freehand`, `polyline`, `spline`, `keypoint`, `brush`/`eraser` on vector regions, `length`), lifted from `pathology/controller.ts` (the most complete). Each exports `onPointerDown/Move/Up`, `onKey`, `draft()` and `cancel()`, and reads options from `useToolOption`.
- [x] `OverlayEngine.ts`: owns the overlay canvas(es), spatial index (`flatbush`, as pathology does), LOD drawing and the selection/handle layer. It subscribes to the store with `getState`/`subscribe`, never React state.
- [x] `useOverlay2D(hostRef, { item, placement, transform })`: the React binding. `placement` filters annotations by `frame`/`slice`, which is how video and cine reuse it per frame or slice.
- [x] `manifest.ts`: contributes the 2D tools as `inkling.overlay2d.tools.*`, each with `when: "renderer.space == image2d"`. Any renderer declaring `space: "image2d"` gets them for free. This is what makes a new image-like data type cheap.
- [x] Unit tests for every `ShapeUtil` (hit-test, handle drag, translate round-trip).

**`kits/timeline/`** (new)
- [x] Extract the ruler, playhead, span lanes and filmstrip from `video/Timeline.tsx`, generalized to "time axis + lanes of `span`/`instant` annotations". Signal's rhythm track and cine's phase markers become lanes. Tools `inkling.timeline.tools.span` and `.instant` declare `when: "renderer.capabilities has 'time'"`. _(kits/timeline/Timeline.tsx, used by video)_

**`kits/io/`** (new; fixes problem H)
- [x] Move `volume3d/nifti.ts` to `kits/io/nifti.ts`; update the cine imports.
- [x] Move `cine4d/niftiIO.ts`, `video/frameSource.ts`, `video/zip.ts` and `signal/wfdb.ts` here. Each becomes reusable by any module.

**`kits/cornerstone/`**
- [x] Move `viewers/cornerstone/*` here unchanged, apart from `ui.tsx`, which moved to viewport-chrome. Update imports.

**`viewers/shared/`**
- [x] Move `geometry.ts` and `draw.ts` into `kits/overlay2d/` (geometry math) and `kits/viewport-chrome/` (`formatTime`). Delete the folder once it's empty. Deduplicate `polygonArea` (also in `cornerstone/inspect.ts:22`).

---

## Phase 5: Module folder layout and conventions

For each `modules/<name>/`:

```
manifest.ts       pure data: defineModule({...}), imports only types, icons and zod schemas
public.ts         the ONLY file other modules may import (types, schemas)
impl.ts           export default { renderers: {...}, panels: {...}, inspectors: {...}, exporters: {...}, commands: {...} }
renderer/         engine (imperative class) + thin React host
panels/           one file per panel contribution
geometries.ts     geometry refinements (attribute schemas, describe, inspect)
exporters.ts
*.test.ts
README.md         one paragraph + example environment snippet (also used by catalog)
```

Rules (enforced by `check:boundaries`):
- [x] Renderers never import the shell. They get everything through `RendererProps` and `platform/runtime`.
- [x] Domain constants (WFDB codes, LV/RV/myocardium, CT presets) live in module `configSchema` defaults, never in kits or platform. _(CT presets, WFDB codes, ECG vocabulary and cardiac structures are config defaults or preset data)_
- [x] Every contribution has an `example` so `describeCatalog()` can show the agent a working snippet (kiwifs fence rule).

**`modules/core/`** (new)
- [~] Panels: files, labels, review, inspector, ai. Core geometries' `describe`/`inspect`, review rules, studio commands, and the `select`/`pan` tools as defaults for every renderer. _(files, labels (with inspector), review, ai panels, geometries, review rules, commands, select/pan done)_

---

## Phase 6: Convert each viewer (one PR per viewer; e2e must stay green)

The order runs from the cleanest to the most entangled. After each conversion, remove that viewer from the phase-3 legacy shim and from the boundary allowlist.

### 6.1 `pathology` to `modules/wsi/` (the reference conversion)
- [x] `manifest.ts`: dataKind `raster-pyramid` (from the `pathology` case in `lib/items.ts`), renderer `osd` (`space: "image2d"`, capabilities `["pan","zoom","rotate","overlay"]`), configSchema `{ objective?, mpp?, showNavigator }`.
- [x] `renderer/controller.ts`: keep only OpenSeadragon ownership, the tile transform and adjustments. Delegate drawing, hit-testing and tool state machines to `kits/overlay2d`. Expect `controller.ts` to drop from 1,325 to about 350 lines.
- [x] Keep `wand*.ts` as a module tool, `inkling.wsi.tools.wand` (needs pixel access).
- [x] Move `CountsPanel`, `AdjustPopover` and `ImportButton` out of `PathologyViewer.tsx` into `panels/counts.tsx` (slot `right`), `panels/adjust.tsx` (slot `viewport-bar`) and a command `inkling.wsi.importGeoJSON`.
- [x] Inspector: `measure.ts#inspectRows` reads `mpp` from `runtime`, not `item.assets[0]`.
- [x] Keybindings: `toggleClassNames`, `rotateView`, `holdToPan` and `removeLastVertex` move to the manifest.
- [x] Exporters: `io.ts` (GeoJSON/QuPath), `accepts: [polygon, multipolygon, keypoint, polyline]`.

### 6.2 `image2d` to `modules/image2d/`
- [x] dataKind `raster` (PNG/JPEG/DICOM single frame). Renderer `cornerstone-stack` (`space: "image2d"`). Make window/level, invert, flip and colormap viewport-bar contributions, each toggleable through config (`windowLevel: false` for natural photos).
- [x] Provide a second, lightweight renderer `canvas-raster` (no Cornerstone, plain `<canvas>` + `kits/overlay2d`) for non-medical images. That's the default for `preset:generic-image`.
- [x] Measurement tools (`length`, `angle`, `cobb`, `bidirectional`, `probe`, `arrow`) become `inkling.image2d.tools.*` with `when: "renderer == inkling.image2d.renderers.cornerstone-stack"`. Disable `cobb` outside radiology presets. _(measurement tools live in kits/cornerstone with `when: 'cornerstone' in renderer.capabilities`; generic-image disables cobb)_
- [x] Split `Image2DViewer.tsx` (573 lines) into `renderer/CornerstoneStackEngine.ts`, `renderer/Host.tsx` and `panels/viewControls.tsx`.
- [x] Exporters: `coco.ts` stays; the DICOM SEG/SR exporters move to `modules/dicom-export/` so any Cornerstone renderer can opt in.

### 6.3 `video` to `modules/video/`
- [x] dataKind `video` (mp4/webm). Renderer `frame-canvas` (`space: "image2d"`, capabilities `["time","playback"]`).
- [x] Delete the `videoPlayhead` singleton (`VideoViewer.tsx:41`). Publish `runtime.playhead`; `adapter.ts` inspect reads it.
- [x] Overlay drawing and editing go through `kits/overlay2d` with `placement.frame`. Track interpolation (`tracks.ts`) becomes a `geometries` contribution for `track`, plus a `ShapeUtil` wrapper that resolves the shape at the playhead.
- [x] Timeline goes through `kits/timeline`. Keyframe, outside and occluded become module commands with keybindings (moved from `lib/shortcuts.ts`).
- [x] Split `VideoViewer.tsx` (1,108 lines) into `renderer/VideoEngine.ts` (frame source, playback clock) and `renderer/Host.tsx`, under 250 lines.

### 6.4 `signal` to `modules/timeseries/` (rename: ECG is a preset, not the module)
- [x] dataKind `multichannel-timeseries` with readers `wfdb` (now), `csv` and `edf` (later). Renderer `strip-chart`, with configSchema `{ layout: "stacked"|"12lead"|"3x4"…, paperSpeed, gain, grid: "ecg"|"plain", filters }`. ECG paper is a config value, not code.
- [x] Geometries: core `span`/`instant` with `channel`. The ECG vocabulary (`codes.ts`: beat codes, rhythms, SNOMED) moves to `presets/ecg/vocabulary.json`, referenced by the label groups, so a non-ECG timeseries uses the same module with different classes.
- [x] `dsp.ts`, `dsp.worker.ts`, `dspClient.ts` and `measure.ts` stay in the module. Pan–Tompkins becomes a command `inkling.timeseries.detectBeats` flagged `ecg` in config, and marks results `ai-suggested`.
- [x] Move `SidePanel.tsx` to `panels/measurements.tsx` (slot `right`). `CalibrateDialog` becomes a command.
- [x] `cachedInfo` (`record.ts:34`) becomes `runtime.signalInfo`.
- [x] Move the suggestion-review keybindings (Tab, Enter, Delete) to `inkling.core` as generic "AI suggestion review" commands with `when: "selection.provenance == ai-suggested"`. They're useful for every module.
- [x] Split `SignalViewer.tsx` (1,067 lines) into `renderer/StripChartEngine.ts`, `renderer/Host.tsx` and the panels.
  _(done: vocabulary is preset:ecg config (`instantCodes`, `trackCodes`, `waves`, `channelOrder`…) plus a `statements` Choices group with `multiple: true`; label groups now merge by name across `extends`; readers `wfdb` + `csv`, EDF is the next extension point; exports proven byte-identical by `exporters.test.ts`)_

### 6.5 `volume3d` to `modules/volume/`
- [x] dataKind `volume` (NIfTI, DICOM series). Renderer `cornerstone-mpr` (`space: "volume"`, capabilities `["slices","planes","crosshairs"]`), with config for the 1×3, 2×2 and 1+3D layouts.
- [x] Turn `volumeSources()` (exported from the viewer, line 152) into the dataKind's `groupItems`/sequence picker.
- [x] Interpolate-slices, remove-islands and confidence-connected become commands. The segment list and visibility become `panels/segments.tsx`. _(commands `interpolateSlices`, `removeIslands`, `smartFill`/`similarFill`; the viewer had no segment list, and the reference-mask toggle stays in its viewport bar, so no segments panel)_
- [x] Split `Volume3DViewer.tsx` (1,251 lines) into an engine, a host and panels.

### 6.6 `cine4d` to `modules/cine/` (most domain-coupled; do last)
- [x] dataKind `volume-time` (4D NIfTI + reference segmentations). Renderer `slice-frame-canvas` (`space: "image2d"`, capabilities `["time","slices","playback"]`), using `kits/overlay2d` with `placement.{slice,frame}` and `kits/io/nifti`.
- [x] Remove the label-text guessing: `model.ts#structures(labels)` becomes configSchema `{ structures: { lv?: labelId, rv?: labelId, myo?: labelId } }`, set by `preset:cardiac-cine`. The generic `cine` module works for any slice × frame data.
- [x] Replace `knownGrids` (`model.ts:502`) with `runtime.grid`.
- [x] Panels: `MetricsPanel.tsx` (EF, volumes, mass) becomes `modules/cardiac-metrics/` (a separate module that `requires: ["inkling.cine"]`) so it can be included or excluded. `PhaseMatrix.tsx` becomes `panels/sliceFrameMatrix.tsx` (generic; ED/ES highlighting via config). _(slice × frame matrix stays inside the host: it needs the decoded volume and view state)_
- [x] Move the copy-contour commands and keybindings to the manifest.
- [x] Split `Cine4DViewer.tsx` (1,167 lines) into an engine, a host and panels.

### 6.7 Cleanup
- [x] Delete `viewers/` (`ViewerAdapter.ts`, `registry.ts`, the legacy shim). `check:boundaries` goes strict (no allowlist).
- [x] `rg "videoPlayhead|knownGrids|cachedInfo|POLYGON_VIEWERS|TOOL_META|TOOL_KEYS|ITEM_NOUN|VIEWER_META"` returns nothing.

---

## Phase 7: Prove generality with non-medical environments (acceptance test)

Write these as **environment JSON only**: no new module code allowed. If one needs code, that exposes a missing contribution point; fix the platform rather than the preset.

- [x] `platform/presets/generic-image-boxes.json`: retail shelf photos; `image2d.canvas-raster` + overlay2d box/polygon + COCO. _(shipped as `generic-image.json`)_
- [x] `platform/presets/drone-video-tracks.json`: `video` + track tool + MOT/CVAT export.
- [x] `platform/presets/sensor-timeseries-events.json`: accelerometer CSV through `timeseries` with `grid: "plain"`, span/instant labels.
- [x] `platform/presets/satellite-tiles.json`: `wsi.osd` on a non-pathology DZI with `mpp` set to metres per pixel.
- [~] Add matching `seed-data` fixtures (CC0 or synthetic) and e2e smoke tests in `apps/web/e2e/generic_test.py`. _(synthetic accelerometer CSV in e2e/fixtures; image smoke tests in generic_test.py, sensor/drone/satellite in environments_test.py; drone and satellite reuse the video and WSI seeds)_
- [ ] Optional new module to prove the contract from the outside: `modules/text-spans/` (NER on plain text; `space: "text"`). It must not change any file outside its folder except one `registerModule` line.

---

## Phase 8: Agent surface (the "boot an environment" loop)

**`apps/web/scripts/emit-schemas.mjs`** (new; kiwifs `emit-fence-schemas` pattern)
- [x] Build `public/schema/environment.v1.json` and `public/catalog.json` from all manifests. CI fails if they're stale (drift check).

**`components/studio/AiAssistantPanel.tsx`** → `modules/core/panels/ai.tsx`
- [x] The system prompt includes `catalogPrompt()`, the current env JSON and resolver errors.
- [x] Agent tools (function-calling schema): _(platform/agent.ts)_
  - `list_modules`
  - `describe_contribution(id)`
  - `get_environment`
  - `validate_environment(spec)`
  - `patch_environment(jsonPatch)`, which returns the new env or structured errors
  - `preview_environment(spec)`, which renders in a sandbox store without saving
  - `run_command(id, args)`
- [~] Every agent edit is one undoable `setEnv` step with an "Agent changed: …" diff summary in the panel, and is revertible. _(undoable setEnv + Undo button done; not yet checked end-to-end against a live model)_

**`apps/web/dev/seed-server.ts`** (and later `apps/api/`)
- [x] Back the tools with `/api/catalog` and `/api/environments/:id` (GET/PUT/PATCH) from phase 2. Store the environment history (revision, author `agent:<model>` or user, timestamp), mirroring kiwifs's git-backed actor attribution.
- [ ] Later: expose the same tools over MCP (`inkling mcp`) so Claude or Cursor can boot environments from outside the app.

**Safety tiers** (document them in `docs/modules.md`):
- [x] Tier 1: the agent references trusted bundled modules (all of the above).
- [~] Tier 2: the agent generates declarative panels (json-render catalogue of shadcn components bound to `runtime` and store selectors), behind a feature flag. _(documented in docs/modules.md; not implemented)_
- [~] Tier 3: agent-written code runs only in an MCP Apps-style sandboxed iframe with a postMessage bridge to read annotations or propose them as `ai-suggested`. Never in the main bundle. _(documented in docs/modules.md; not implemented)_

---

## Phase 9: Agent-composable layout

**`apps/web/package.json`**
- [x] Add `dockview` and `@rjsf/core@^6` (or `@jsonforms/react`).

**`app/routes/DatasetStudioPage.tsx`** + new **`components/studio/StudioLayout.tsx`**
- [x] Replace `react-resizable-panels` with dockview. Panels come from `env.panels` slots. `env.layout` is dockview `toJSON()` (null means auto-layout from slots). _(slots are the dockview panels; each slot keeps its own tabs)_
- [x] Before `fromJSON`, drop panel ids that aren't in the resolved env (dockview throws on unknown panels).
- [x] Keep today's phone and tablet behavior: slots collapse into `Sheet`s below the desktop breakpoint.
- [x] Support multiple viewports (`env.viewports[]`), e.g. a video next to its timeseries, synced through `runtime.playhead`. _(viewports render side by side; renderers sync by reading/publishing runtime keys)_

**`components/studio/ModuleConfigForm.tsx`** (new)
- [x] An RJSF form generated from any contribution's `configSchema`, opened from a panel's ⋯ menu. Edits go through `patch_environment`, so humans and the agent share one path.

---

## Phase 10: Documentation

- [x] **`inkling.md` §2 and §3.1**: replace the `ViewerAdapter`/`ViewerKind` proposal with modules, environments and presets. Make the "adapters share a dataset/annotation API, not a universal renderer" rule explicit as the module contract. _(sections 2, 3.1 and the §4 tree rewritten)_
- [x] **`AGENTS.md`** (new, repo root): how to add a module (copy `modules/_template/`, write the manifest, run `emit:schemas`, add a preset, add an e2e smoke test), the boundary rules, and "never hand-edit generated schema files".
- [x] **`docs/modules.md`** (new): contribution reference (generated from `describeCatalog()`), `when`-clause context keys, runtime keys, the safety tiers.
- [x] **`modules/_template/`** (new): a minimal compiling module with one renderer, one tool and one panel.

---

## Suggested order and sizing

| Phase | Depends on | Size |
|---|---|---|
| 0 Guardrails | none | S |
| 1 Platform contracts | 0 | M |
| 2 Data model | 1 | M (annotation migration needs care) |
| 3 Shell de-hardcoding + legacy shim | 1, 2 | M |
| 4 Kits (overlay2d is the big one) | 3 | L |
| 6.1 to 6.6 Viewer conversions | 4 | L (one PR each) |
| 7 Non-medical proofs | 6 | S to M |
| 8 Agent surface | 3 (can start in parallel with 4) | M |
| 9 Layout | 3 | M |
| 10 Docs | ongoing | S |

Definition of done:
1. An agent, given only `/api/catalog` and a dataset, writes an environment JSON that validates and boots a working studio for a data type Inkling has never seen, with zero code changes.
2. The six medical presets behave exactly as today (e2e green).
3. `check:boundaries` passes in strict mode.
