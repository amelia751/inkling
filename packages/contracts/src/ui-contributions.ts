import * as z from "zod";

/**
 * `ui/contributions.json` (docs/plugins.md §5.3): declarative UI for plugins that may not
 * ship code into the main origin (third-party, agent-authored, python-worker). A toolbar
 * action names a command; a panel names a trusted renderer from the host's registry
 * (`studio.declarative-panel.v1`, `studio.mask-review.v1`, …). Unknown renderers fail closed.
 */

export const SURFACES = [
  "image.viewer.toolbar",
  "annotation.inspector",
  "studio.panel.left",
  "studio.panel.right",
  "studio.panel.bottom",
  "command.palette",
] as const;
export const Surface = z.enum(SURFACES);
export type Surface = z.infer<typeof Surface>;

const LocalId = z.string().regex(/^[a-z][\w.-]*$/, "lower-case local id");

/** When a contribution is visible. All given conditions must hold. */
export const VisibleWhen = z
  .object({
    /** Media types of the current item's assets, e.g. image/png. `image/*` wildcards allowed. */
    assetMediaType: z.array(z.string()).optional(),
    /** A `when` clause over the Studio context (`renderer.space == image2d`). */
    when: z.string().optional(),
    /** Only when an annotation is selected. */
    selection: z.boolean().optional(),
  })
  .strict();
export type VisibleWhen = z.infer<typeof VisibleWhen>;

export const ToolbarAction = z
  .object({
    id: LocalId,
    surface: z.enum(["image.viewer.toolbar", "command.palette"]),
    title: z.string().min(1),
    description: z.string().optional(),
    /** Full command / tool id, e.g. `<namespace>.segmentation.segment_objects`. */
    command: z.string().min(1),
    /** Static input merged into the command call. */
    args: z.record(z.string(), z.unknown()).optional(),
    icon: z.string().optional().describe("Icon name from the Studio icon set"),
    keys: z.array(z.string()).optional(),
    visibleWhen: VisibleWhen.optional(),
  })
  .strict();
export type ToolbarAction = z.infer<typeof ToolbarAction>;

export const DATA_BINDINGS = ["annotations.currentSelection", "annotations.currentItem", "item.current", "none"] as const;
export type DataBinding = (typeof DATA_BINDINGS)[number];

export const PanelDecl = z
  .object({
    id: LocalId,
    surface: z.enum(["annotation.inspector", "studio.panel.left", "studio.panel.right", "studio.panel.bottom"]),
    title: z.string().optional(),
    description: z.string().optional(),
    /** Versioned trusted renderer name, e.g. `studio.mask-review.v1`. */
    renderer: z.string().regex(/^[a-z][\w-]*(?:\.[\w-]+)*\.v\d+$/, "a versioned trusted renderer name, e.g. studio.mask-review.v1"),
    dataBinding: z.enum(DATA_BINDINGS).optional(),
    /** Renderer config (validated by the renderer's own schema). */
    config: z.record(z.string(), z.unknown()).optional(),
    visibleWhen: VisibleWhen.optional(),
  })
  .strict();
export type PanelDecl = z.infer<typeof PanelDecl>;

/**
 * A viewport renderer on a trusted renderer (todo10 Phase 5, ladder rung 4): in practice
 * `studio.sandbox-frame.v1` with `config.module`, an ESM viewer that runs in the MCP Apps
 * sandbox (packages/plugin-ui-sdk/src/viewer.ts). The plugin ships no code into the main origin.
 */
export const RendererDecl = z
  .object({
    id: LocalId,
    title: z.string().optional(),
    description: z.string().optional(),
    renderer: z.string().regex(/^[a-z][\w-]*(?:\.[\w-]+)*\.v\d+$/, "a versioned trusted renderer name, e.g. studio.sandbox-frame.v1"),
    /** Full data kind ids it displays; default: the generic one-item-per-file kind. */
    consumes: z.array(z.string()).optional(),
    space: z.enum(["image2d", "volume", "time", "text"]).default("image2d"),
    capabilities: z.array(z.string()).default([]),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type RendererDecl = z.infer<typeof RendererDecl>;

/**
 * A keyboard command a plugin's trusted panel handles (todo25 W5): declared here with its keys
 * and label, bound by the renderer with `useCommands` under the plugin's id. The renderer
 * documents which local ids it answers (e.g. `studio.mask-review.v1`: `acceptItemMasks`,
 * `rejectItemMasks`, `acceptAllMasks`); ids it doesn't know simply do nothing.
 */
export const PanelCommand = z
  .object({
    id: z.string().regex(/^[a-zA-Z][\w.-]*$/, "a local command id"),
    title: z.string().min(1),
    description: z.string().optional(),
    keys: z.array(z.string()).default([]),
    visibleWhen: VisibleWhen.optional(),
  })
  .strict();
export type PanelCommand = z.infer<typeof PanelCommand>;

export const UiContributions = z
  .object({
    $schema: z.string().optional(),
    $comment: z.string().optional(),
    toolbarActions: z.array(ToolbarAction).default([]),
    panels: z.array(PanelDecl).default([]),
    renderers: z.array(RendererDecl).default([]),
    commands: z.array(PanelCommand).default([]),
  })
  .strict()
  .meta({ id: "UiContributions" });
export type UiContributions = z.infer<typeof UiContributions>;
