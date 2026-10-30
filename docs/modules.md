# Modules, environments and presets

Inkling Studio is a shell that runs an **environment**: a JSON document that picks a data
kind, viewports (renderers), tools, panels, exporters and label groups from **modules**.
Medical Studios are presets (`preset:pathology`, `preset:ecg`, …), not special code paths.
An agent can boot a Studio for a data type Inkling has never seen by writing environment
JSON, as long as the modules it needs are registered.

The generated contribution reference (every id, description and edge) is
[`modules-reference.md`](modules-reference.md); machine-readable versions are served at
`/api/catalog` and `/api/catalog/schema` (`apps/web/public/catalog.json`,
`apps/web/public/schema/environment.v1.json`). They're built by `pnpm emit:schemas`; never
edit them by hand.

## Layers

| Layer | Folder | May import |
|---|---|---|
| Platform | `apps/web/src/platform/` | nothing below it |
| Kits | `apps/web/src/kits/` | platform |
| Modules | `apps/web/src/modules/<id>/` | platform, kits, other modules' `manifest.ts` / `public.ts` |
| Shell | `app/`, `components/studio/`, `lib/` | platform (never a module) |
| Composition root | `src/bundle.ts` | everything: the one place that lists bundled modules |

`pnpm check:boundaries` enforces this; `--strict` ignores the allowlist.

## Contribution types

Ids are `<moduleId>.<type>.<name>` (OHIF style), e.g. `inkling.wsi.renderers.osd`. Every
contribution has a one-line `description`, may have a `configSchema` (zod) and an `example`.

Module ids are `${namespace}.<module>`. The namespace comes from the naming config
(`packages/plugin-contracts/src/naming.ts`, also emitted as `schemas/naming.json`), so never
hardcode it: write `ns("wsi")` or `` `${NS}.core.commands.undo` ``. That file is the only
place the product name may appear in code, and `check:boundaries` enforces this. Stored
documents (presets, environments, annotation geometry types) keep full ids. After a rename,
the old namespace goes into `legacyNamespaces` so those documents still resolve, and
`node scripts/rename-namespace.mjs --from <old> --to <new>` rewrites them.

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
`cornerstone`, `suggestions` (Tab / Enter review of AI suggestions).

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

`pnpm mcp` starts a stdio MCP server (`apps/web/scripts/mcp.mjs`) over a running dev server
(`INKLING_URL`, default `http://localhost:5173`). Tools: `list_projects`, `catalog`,
`list_modules`, `describe_contribution`, `get_environment`, `validate_environment`,
`patch_environment`, `set_environment`. Edits are validated by the app's resolver and saved
with author `agent:mcp`; the Studio shows them the next time the project opens.

```bash
claude mcp add inkling -- node /abs/path/to/inkling/apps/web/scripts/mcp.mjs
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

Enable the flag per browser with `localStorage.setItem("inkling.flags", "agentPanels")`, or for
a build with `VITE_INKLING_FLAGS=agentPanels`. Without it the experimental module isn't
registered, so environments can't reference its panels.
