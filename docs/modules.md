# Modules, environments and presets

Inkling Studio is a shell that runs an **environment**: a JSON document that picks a data
kind, viewports (renderers), tools, panels, exporters and label groups from **modules**.
Medical Studios are presets (`preset:pathology`, `preset:ecg`, …), not special code paths.
An agent can boot a Studio for a data type Inkling has never seen by writing environment
JSON, as long as the modules it needs are registered.

The generated contribution reference (every id, description and edge) is
[`modules-reference.md`](modules-reference.md); machine-readable versions are served at
`/api/catalog` and `/api/catalog/schema` (`schemas/catalog.json`,
`schemas/environment.v1.json`; the web server also serves them, with `schemas/catalog.md`, at
`/catalog.json`, `/schema/environment.v1.json` and `/catalog.md`). They're built by
`pnpm emit:schemas`; never edit them by hand.

## Layers

A **module** here is what [`plugins.md`](plugins.md) calls a plugin's UI half: a manifest of
contributions plus a lazy `load()`. Vocabulary: plugin = module (`ModuleManifest`), UI
contribution = contribution, trusted renderer = `RendererContribution` / panel components,
workspace configuration = environment spec, extension host = `extension-host/`.

| Layer | Folder | May import |
|---|---|---|
| Contracts | `packages/contracts` (`@studio/contracts`) | nothing internal |
| Plugin UI SDK | `packages/plugin-ui-sdk` (`@studio/plugin-ui-sdk`) | contracts |
| UI primitives | `packages/ui` (`@studio/ui`): shadcn, icons, `cn`, keys | nothing internal |
| Trusted renderers / kits | `packages/renderers` (`@studio/renderers`) | sdk, contracts, ui |
| First-party plugins | `plugins/<name>/ui` (`@plugins/<name>/…`) | sdk, contracts, ui, renderers, other plugins' `manifest.ts` / `public.ts` |
| Extension host | `apps/web/src/extension-host/` (registry, resolver, commands, catalog, agent tools, agent panels) | sdk, contracts, ui |
| Studio shell | `apps/web/src/studio/` (routes, components, store, lib) | extension-host, sdk, contracts, ui; never `@plugins/*` |
| Studio built-ins | `apps/web/src/studio/core/` (files, labels, select, pan…; not a plugin) | like the shell, plus renderers |
| Composition roots | `extension-host/bundled.ts`, `extension-host/host.tsx` | everything: the bundled plugin list and the host API binding |

`pnpm check:boundaries` enforces this (tests may reach into the host). It also rejects the
product name in code (see below).

### The host API

Plugin UI never imports `apps/web`. It reads Studio state with `useHost(selector)` (same
shape as a Zustand hook; `useHost.getState()` / `useHost.subscribe()` outside React) and
calls `assetUrl`, `useCommands`, `execute`, `commandDef`, `describeGeometry`, `inspectRows`
and `resolveSpec` from `@studio/plugin-ui-sdk`. The extension host binds the real
implementation at boot (`extension-host/host.tsx`, backed by the shell's store) and wraps the
Studio route in `<StudioHostProvider>`; tests render plugins inside a fake
`<HostProvider host={…}>` (`extension-host/host.test.ts`).

### Adding a first-party plugin

1. Copy `plugins/_template` to `plugins/<name>` and rename the module id (`ns("<name>")`).
2. Import only from the SDK, contracts, ui and renderers; third-party
   dependencies go in the plugin's own `package.json` (`@studio/plugin-<name>`), and the
   plugin's `plugin.yaml` describes it for the registry (`node tools/build-registry.mjs`).
3. Add one import and one `MODULES` entry in `apps/web/src/extension-host/bundled.ts`, and a
   `@plugins/<name>/*` path in `apps/web/tsconfig.json`.
4. Run `pnpm emit:schemas` and the checks.

### Data-only manifests and declarative UI

Every plugin also has `plugins/<name>/plugin.yaml` (schema: `packages/contracts/src/plugin-manifest.ts`,
emitted as `schemas/plugin.v1.json`): id, version, capabilities, runtime, providers,
permissions, licences, resources. The registry, installer and agent read it without running
code; `extension-host/manifests.ts` validates every one at build time, and a test checks
that id and version match the TS module.

A plugin without trusted code ships `ui/contributions.json` instead
(`schemas/ui-contributions.v1.json`): toolbar actions that name a command, and panels that
name a **trusted renderer** (`studio.declarative-panel.v1`, `studio.sandbox-frame.v1`,
`studio.mask-review.v1`; see `extension-host/trusted-renderers.tsx`). Unknown renderers fail
closed. `extension-host/contributions-loader.tsx` turns it into an ambient module: a toolbar
action becomes a command with `surface: "toolbar"` and a `when` built from `visibleWhen`
(`item.mediaType =~ …`), and runs through the command gateway (`extension-host/gateway.ts`).
Surfaces map to today's slots in `extension-host/surfaces.ts`.

### Workspace activation

The registry separates **available** plugins (everything bundled) from **active** ones (what
this workspace installed). Lookups, the resolver and the agent's catalogue see active
plugins only; built-ins are pinned. The Studio reads the workspace state from
`GET /api/v1/workspaces/:id/state` (the kernel's Workspace API; in dev the seed server serves
`seed-data/<project>/workspace.json`, or every bundled plugin) and calls `applyWorkspace`.
`registry.activate` / `deactivate` change the set at runtime and the Studio re-resolves
without a reload. `requires` is pulled from available plugins only, and a missing one is
reported. Annotations of a disabled plugin's geometry types stay in the store and show as
"unavailable type".

**Trust rule (todo2 D2).** First-party plugins are trusted code compiled into the web build,
so their `ui/` folder may contain React. Third-party and agent-authored plugins may only ship
`plugin.yaml` plus `ui/contributions.json` that name trusted renderers; they never run their
own code in the main origin.

## Contribution types

Ids are `<moduleId>.<type>.<name>` (OHIF style), e.g. `inkling.wsi.renderers.osd`. Every
contribution has a one-line `description`, may have a `configSchema` (zod) and an `example`.

Module ids are `${namespace}.<module>`. The namespace comes from the naming config
(`packages/contracts/src/naming.ts`, also emitted as `schemas/naming.json`), so never
hardcode it: write `ns("wsi")` or `` `${NS}.core.commands.undo` ``. That file is the only
place the product name may appear in code, and `check:boundaries` enforces this. Stored
documents (presets, environments, annotation geometry types) keep full ids. After a rename,
the old namespace goes into `legacyNamespaces` so those documents still resolve, and
`node tools/rename-namespace.mjs --from <old> --to <new>` rewrites them.

| Type | What it is |
|---|---|
| `dataKinds` | How assets are recognised and grouped into items (`groupItems`), the item noun and icon |
| `renderers` | The viewport component; declares `consumes` (data kinds), `space` and `capabilities` |
| `geometries` | A geometry `type` with `describe` (and validation); core ones are bare-named |
| `tools` | Toolbar entries: label, hint, icon, group, `hotkey`, `creates`, `when`, `optionsSchema` |
| `commands` | Named actions with default `keys`, `when`, `replaces` / `shadows`, `contextual` |
| `panels` | Components for the `left`, `right`, `bottom` or `viewport-bar` slot |
| `inspectors` | Rows for the selection inspector, per geometry type |
| `exporters` | Downloadable formats; `accepts` lists geometry types |
| `labelControls` | Label Studio style controls (`Labels`, `PolygonLabels`, `Choices`…) |
| `reviewRules` | Validation checks on the review page |
| `presets` | Ready-made environments, used with `extends` |

A tool's local name (`box`, `brush`) is what the store holds (`useStudio().tool`) and what
renderers switch on; the resolver guarantees names are unique within an environment.

### Which tools the toolbar shows (todo8 D4)

**Rule 1: only usable tools.** The resolver keeps a tool in `env.tools` only when some label
group in the environment accepts the geometry it `creates` (the label control's
`geometries`). Tools without `creates`, and the `navigate` and `measure` groups, are exempt, and
so is every tool while the environment declares no label groups (a bare preset, a catalogue
preview). The dropped ones go to `env.unusableTools` as `{ tool, reason }` with a plain reason
("No label accepts boxes"), which Task setup shows greyed. The catalogue still lists every
tool. So for a plugin author: set `creates` to the geometry your tool draws and make sure a
label control lists it in `geometries`, or your tool won't appear; a classification task (only
a `Choices` group) shows no drawing tools at all.

**Rule 2: groups fold.** Tools are laid out by `group` (`navigate`, `shape`, `measure`, `mask`,
`time`) in first-appearance order, with separators only between groups. A group with three or
more tools folds into one split button whose face is the active tool, else the last one used
in that group (per environment, in `stores/tool-prefs.ts`, not `useStudio`), else the first;
its chevron, or a long press, lists the group with names and keys. Groups with one or two tools
stay expanded. `navigate` never folds, but Zoom is left to the renderer's view controls (scroll
already zooms; the toolbar shows it only while it's active). Keys never change: a tool's
`hotkey` works whether or not it's the face, and pressing it makes it the face. Pick the
`group` that matches what the tool does, since it decides where the tool lands and which
heading it gets in the shortcuts sheet. Declarative plugins' toolbar actions
(`data-toolbar-action`) are never folded.

## Environment spec

```jsonc
{
  "$schema": "inkling://schema/environment/v1",
  "extends": "preset:image-2d",            // presets deep-merge first
  "data": { "kind": "inkling.image2d.dataKinds.raster" },
  "labels": [{ "name": "products", "control": "RectangleLabels",
               "classes": [{ "id": "cereal", "color": "#e66", "hotkey": "shift+1" }] }],
  "viewports": [{ "name": "main", "renderer": "inkling.image2d.renderers.canvas-raster" }],
  "tools": ["inkling.core.tools.select", "inkling.overlay2d.tools.box"],
  "panels": { "left": ["inkling.core.panels.files", "inkling.core.panels.labels"] },
  "exporters": ["inkling.image2d.exporters.coco"],
  "keybindings": [{ "command": "inkling.image2d.commands.fitView", "keys": ["f"] }],
  "overrides": [{ "id": "inkling.cornerstone.tools.cobb", "disabled": true }],
  "layout": null
}
```

`studio` holds what annotators see (todo8 D8, set in Task setup → Annotators see):
`showSourceLabels` (labels that came with the files, e.g. a source folder named `pneumonia`;
off by default for classification tasks, so the labels people make are an independent read)
and `showFilePaths`. Defaults come from `studioDefaults` in `apps/web/src/studio/lib/task-setup.ts`.

Merging: objects merge, arrays replace, `overrides` and `keybindings` concatenate, and
`labels` groups merge by `name` (a same-named group replaces the preset's; new groups append).
`resolveEnvironment` never throws for bad input; every problem comes back as
`{ path, code, message, suggestion }` with `path` a JSON Pointer.

## `when` clauses

VS Code syntax: `==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `||`, `!`, `in`, `not in`, `=~`
and parentheses. A bare word on the right of a comparison is a string. Parsed by hand,
never `eval`'d.

| Key | Value |
|---|---|
| `renderer` | Full renderer id of the viewport |
| `renderer.name` | Its local name |
| `renderer.space` | `image2d`, `volume`, `time` or `text` |
| `renderer.capabilities` | Array, e.g. `'playback' in renderer.capabilities` |
| `dataKind` | Full data kind id |
| `tool` | Active tool name (runtime) |
| `tool.options` | Option keys of the active tool, e.g. `'size' in tool.options` |
| `selection.count` | Number of selected annotations (runtime) |
| `env.tools` | Tool names in the environment |

Static keys are known at resolve time; the runtime keys only at dispatch, so the resolver
treats them as "maybe". Hotkey conflicts are checked among bindings that are
unconditionally active together.

Common capabilities: `drafting` (Enter / Esc finish or cancel a shape), `vertexUndo`,
`holdToPan`, `rotate`, `playback`, `time`, `slices`, `planes`, `windowLevel`,
`cornerstone`, `suggestions` (Tab / Enter review of AI suggestions), `overlayOpacity` (the
renderer's view menu has the overlay opacity control, `OverlayOpacityControl` from
`@studio/renderers/viewport-chrome/opacity`; without it the Labels panel keeps the slider).
View settings (window/level, invert, overlay opacity, zoom, flip, rotate) belong in the
renderer's `viewport-bar` panel, not in a left-panel tab: they're per-person and act on the
canvas. The Cornerstone stack's panel (`plugins/image2d/ui/panels/viewControls.tsx`) is the
reference, with a View ▾ menu for the rarely used ones.

## Runtime context

Renderers publish live values per item (`runtime.publish(key, value)`); inspectors and
panels read them (`runtime.get`, `useRuntime(itemId, key)`). Never use module-level
singletons for this.

| Key | Published by | Value |
|---|---|---|
| `status` | the shell | the status-bar text |
| `playhead` | video, cine | `{ frame, time }` (cine adds `slice`) |
| `grid` | cine | the slice grid: spacing, origin, orientation and `dims` |
| `cine.references`, `cine.coverage` | cine | reference segmentations and which cells are contoured (read by cardiac metrics) |
| `volume` | volume | `{ dims, spacing, modality, frameOfReferenceUID }` |
| `signalInfo` | timeseries | `{ record, fs, samples, channels, header? }` |
| `mpp` | wsi | microns (or metres) per pixel |
| `image2d.view`, `image2d.controls` | image2d cornerstone-stack | view state and actions for its viewport-bar panel |
| `viewportState` | image2d canvas-raster, volume | canvas: `{ zoom, pan, width, height }`; volume: `{ layout, sequence, activePlane, slices }` |
| `adjust` | wsi adjust panel | brightness / contrast / gamma the renderer applies |

## Agent surface and safety tiers

The assistant (`inkling.core.panels.ai`) and the dev API expose: `list_modules`,
`describe_contribution`, `get_environment`, `validate_environment`, `patch_environment`
(RFC 6902), `preview_environment` and `run_command`. Every agent edit is one undoable
`setEnv` step, recorded with author `agent:<model>` in the environment history.

### From outside the app (MCP)

`pnpm mcp` starts a stdio MCP server (`apps/mcp/src/main.ts`) over a running dev server
(`<envPrefix>WEB_URL`, e.g. `INKLING_WEB_URL`; default `http://localhost:5173`). Tools: `list_projects`, `catalog`,
`list_modules`, `describe_contribution`, `get_environment`, `validate_environment`,
`patch_environment`, `set_environment`. Edits are validated by the app's resolver and saved
with author `agent:mcp`; the Studio shows them the next time the project opens.

```bash
claude mcp add inkling -- pnpm --dir /abs/path/to/inkling mcp
```

1. **Tier 1 (on):** the agent references trusted, bundled modules only.
2. **Tier 2 (flag `agentPanels`):** `inkling.experimental.panels.declarative`. The agent writes
   JSON blocks (`text`, `stat`, `list`, `progress`) bound to `{ runtime: key }` or one of the
   whitelisted `{ store: selector }`s (`annotations.count`, `annotations.item`, `items.total`,
   `items.annotated`, `selection.count`, `activeLabel`, `tool`, `labels.counts`). The block
   schema is the panel's `configSchema`, so bad blocks are resolver errors. No code runs.
3. **Tier 3 (flag `agentPanels`):** `inkling.experimental.panels.sandbox`. Agent-written HTML/JS
   runs in an `<iframe sandbox="allow-scripts">` (opaque origin: no app DOM, storage or
   cookies; no navigation, popups or forms) under a CSP that blocks all network access. Its
   only API is `window.inkling.getAnnotations()` and `window.inkling.propose([...])` over
   postMessage. Proposals are vetted (known label, a geometry type the environment's tools
   create, plain attribute values, bounded size) and land as `ai-suggested`, author
   `agent:sandbox`, so the expert reviews them like any AI suggestion. Never in the main bundle.

### Sandboxed viewers on MCP Apps (todo10 Phase 5)

`studio.sandbox-frame.v1` (tier 3 above, and ladder rung 4) runs every View behind an
[MCP Apps](https://github.com/modelcontextprotocol/ext-apps) **sandbox proxy**
(`apps/web/public/sandbox-proxy.html`): an iframe on a separate origin (runtime config
`sandboxOrigin`; in dev `http://sandbox.localhost:<port>`, served by the same Vite server) with
`sandbox="allow-scripts"` only and a CSP header without network (`SANDBOX_PROXY_CSP` in
`vite.config.ts`, same value in nginx). The proxy loads the View into its own srcdoc frame
(`allow-scripts`, inherits that CSP) and relays JSON-RPC. The Studio side
(`extension-host/sandbox/bridge-host.ts`) answers `ui/initialize`, sends the item as
`ui/notifications/tool-result`, and handles the View's `tools/call` with the viewer tools
(`viewer-tools.ts`): `viewer_read_asset` (the current item's assets only),
`viewer_get_runtime` / `viewer_publish_runtime` (`viewer.*` keys only),
`viewer_list_annotations`, `viewer_propose_annotations` (vetted typed geometries, stored
`ai-suggested`). Links, chat messages and downloads are refused.

A **rung-4 viewer** is one ESM module with anywidget's shape (`packages/plugin-ui-sdk/src/viewer.ts`):

```js
export default { async render({ model, el, signal, host }) {
  const bytes = await host.readAsset(model.get("item").assets[0].path);
  // draw into el; host.annotations.propose([{ label, geometry: { type: "class" } }])
} };
```

A declarative plugin ships it in `ui/contributions.json` as a viewport renderer, so no code
reaches the main origin and the kernel signs it like any generated plugin:

```json
{ "renderers": [{ "id": "ply", "renderer": "studio.sandbox-frame.v1", "config": { "title": "PLY", "module": "export default { render() {} }" } }] }
```

It consumes `<namespace>.generic.dataKinds.files` (one item per file, any format) unless it names
other data kinds. `apps/mcp` serves the same viewers as MCP Apps UI resources, so they render in
Claude, ChatGPT or any MCP Apps host (`apps/mcp/README.md`). Tests: `apps/web/e2e/plugin_isolation_test.py`
(isolation), `tests/e2e/viewer_test.py` (install, approval, render), `tests/e2e/mcp_apps_host_test.py`
(outside the Studio).

Enable the flag per browser with `localStorage.setItem("inkling.flags", "agentPanels")`, or for
a build with `VITE_INKLING_FLAGS=agentPanels`. Without it the experimental module isn't
registered, so environments can't reference its panels.
