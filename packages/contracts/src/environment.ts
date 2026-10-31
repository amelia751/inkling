import * as z from "zod";

/**
 * The environment spec: the declarative document an agent (or a preset, or the seed
 * manifest) writes to boot a Studio. It picks modules and configures them; it never
 * contains code. Ids are full contribution ids, `<module>.<type>.<name>`.
 */

/** JSON-Schema subset for per-class or per-group attributes (Label Studio / CVAT attributes). */
export const AttributeSchema = z
  .object({
    type: z.enum(["boolean", "string", "number", "enum"]),
    values: z.array(z.string()).optional().describe("Allowed values when type is enum"),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    description: z.string().optional(),
  })
  .meta({ id: "Attribute" });

export const LabelClassSchema = z
  .object({
    id: z.string().min(1).describe("Value stored on annotations (annotation.label)"),
    name: z.string().optional().describe("Display name; defaults to id"),
    color: z.string().optional().describe("CSS color (#hex, hsl()) or a theme palette slot chart-1…chart-5"),
    hotkey: z.string().optional().describe("Combo that picks this class, e.g. \"1\" or \"shift+t\""),
    parent: z.string().optional().describe("Parent class id, for hierarchies"),
    allowedGeometries: z.array(z.string()).optional().describe("Geometry types this class may be drawn as"),
    attributes: z.record(z.string(), AttributeSchema).optional(),
  })
  .meta({ id: "LabelClass" });

export const LabelGroupSchema = z
  .object({
    name: z.string().min(1),
    control: z.string().describe("Label control id, e.g. Labels, RectangleLabels, PolygonLabels, Choices"),
    toName: z.string().optional().describe("Viewport name this group labels; defaults to the first viewport"),
    multiple: z.boolean().optional().describe("Choices only: allow several classes per item"),
    classes: z.array(LabelClassSchema),
    attributes: z.record(z.string(), AttributeSchema).optional().describe("Attributes every class in the group carries"),
  })
  .meta({ id: "LabelGroup" });

export const ViewportSpecSchema = z.object({
  name: z.string().min(1),
  renderer: z.string().describe("Renderer contribution id"),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const PanelSlotsSchema = z.object({
  left: z.array(z.string()).optional(),
  right: z.array(z.string()).optional(),
  bottom: z.array(z.string()).optional(),
  "viewport-bar": z.array(z.string()).optional(),
});

export const OverrideSchema = z.object({
  id: z.string().describe("Any contribution id in the environment"),
  disabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const KeybindingSchema = z.object({
  command: z.string().describe("Command contribution id"),
  keys: z.array(z.string()).describe("Replaces the command's default keys; [] unbinds it"),
});

/** What annotators see in the Studio (todo8 D8, set in Task setup → Annotators see). */
export const StudioViewSchema = z.object({
  showSourceLabels: z
    .boolean()
    .optional()
    .describe("Show the labels that came with the files (source labels). Unset: hidden for classification tasks (blind by default), shown elsewhere"),
  showFilePaths: z.boolean().optional().describe("Show each item's folder path (status bar, hover card). Unset: shown"),
});

export const EnvironmentSpecSchema = z
  .object({
    $schema: z.string().optional(),
    id: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    extends: z.union([z.string(), z.array(z.string())]).optional().describe("Preset id(s), e.g. preset:pathology, deep-merged first"),
    task: z.string().optional().describe("Free-form task name shown on dataset cards (classification, segmentation…)"),
    modules: z.record(z.string(), z.string()).optional().describe("Module id → semver range"),
    data: z.object({ kind: z.string().describe("Data kind contribution id") }).optional(),
    labels: z.array(LabelGroupSchema).optional(),
    viewports: z.array(ViewportSpecSchema).optional(),
    tools: z.array(z.string()).optional().describe("Tool contribution ids in toolbar order"),
    panels: PanelSlotsSchema.optional(),
    exporters: z.array(z.string()).optional(),
    reviewRules: z.array(z.string()).optional(),
    keybindings: z.array(KeybindingSchema).optional(),
    overrides: z.array(OverrideSchema).optional(),
    layout: z.unknown().optional().describe("null = auto layout from panel slots; else a dockview toJSON() document"),
    studio: StudioViewSchema.optional().describe("What annotators see in the Studio (Task setup → Annotators see)"),
  })
  .meta({ id: "EnvironmentSpec" });

export type Attribute = z.infer<typeof AttributeSchema>;
export type LabelClass = z.infer<typeof LabelClassSchema>;
export type LabelGroup = z.infer<typeof LabelGroupSchema>;
export type ViewportSpec = z.infer<typeof ViewportSpecSchema>;
export type EnvironmentSpec = z.infer<typeof EnvironmentSpecSchema>;
export type PanelSlots = z.infer<typeof PanelSlotsSchema>;
export type StudioView = z.infer<typeof StudioViewSchema>;

/**
 * Every class id across the env's label groups, in order, deduplicated (the transition from
 * `labels: string[]`; a v1 string list passes through, so raw manifest projects still work).
 */
export function labelNames(labels: readonly (LabelGroup | string)[] | undefined): string[] {
  return [...new Set((labels ?? []).flatMap((g) => (typeof g === "string" ? [g] : g.classes.map((c) => c.id))))];
}

/**
 * Class ids for drawn regions: `labelNames` without `multiple` Choices groups, whose classes
 * are item-level statements (e.g. ECG record statements), not something to draw with.
 */
export function regionLabelNames(labels: readonly (LabelGroup | string)[] | undefined): string[] {
  return labelNames((labels ?? []).filter((g) => typeof g === "string" || !(g.control === "Choices" && g.multiple)));
}

/** Flat class lookup: the first group that defines a class wins for color and hotkey. */
export function labelClasses(labels: LabelGroup[] | undefined): LabelClass[] {
  const seen = new Map<string, LabelClass>();
  for (const g of labels ?? []) for (const c of g.classes) if (!seen.has(c.id)) seen.set(c.id, c);
  return [...seen.values()];
}
