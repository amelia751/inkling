import { Type } from "typebox";

/**
 * The four Studio tools (todo11 D10, Milestone 2 item 5), framework-neutral: typebox schemas
 * (plain JSON Schema at runtime) plus a one-line description written for a model. apps/agent
 * registers them as pi server tools; apps/mcp will expose the same schemas later.
 *
 * `projectId` is optional: the in-app agent's kernel token is bound to one project, so it never
 * needs one. An external client (MCP, Milestone 4) names the project explicitly.
 */

/** RFC 6902 operation, as the environment PATCH and the boot route take it. */
export const JsonPatchOp = Type.Object(
  {
    op: Type.Union([Type.Literal("add"), Type.Literal("remove"), Type.Literal("replace"), Type.Literal("move"), Type.Literal("copy"), Type.Literal("test")]),
    path: Type.String(),
    value: Type.Optional(Type.Unknown()),
    from: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type JsonPatchOp = Type.Static<typeof JsonPatchOp>;

const presetRef = Type.String({ pattern: "^preset:[a-z0-9-]+$", description: "From the preset index, e.g. preset:image-2d." });
const patchList = (description: string) => Type.Array(JsonPatchOp, { maxItems: 64, description });

export const BootStudioArgs = Type.Object(
  {
    projectId: Type.Optional(Type.String({ description: "Omit in the app (the session has one project)." })),
    preset: Type.Optional(presetRef),
    intent: Type.Optional(Type.String({ maxLength: 500, description: "The person's words; picks the preset if `preset` is omitted." })),
    patch: Type.Optional(patchList("JSON Patch on top of the preset: labels, title, layout.")),
    files: Type.Optional(Type.Array(Type.String(), { maxItems: 500, description: "File node ids for the task's data." })),
    folders: Type.Optional(Type.Array(Type.String(), { maxItems: 50, description: "Folder node ids for the task's data." })),
    name: Type.Optional(Type.String({ maxLength: 120, description: "Task name, e.g. 'Chest X-ray triage'." })),
    bootId: Type.Optional(Type.String({ minLength: 8, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$", description: "Idempotency key; usually omitted (derived per call)." })),
  },
  { additionalProperties: false },
);
export type BootStudioArgs = Type.Static<typeof BootStudioArgs>;

export const PatchStudioArgs = Type.Object(
  {
    taskId: Type.String(),
    patch: patchList("Small JSON Patch, one intent per call."),
    revision: Type.Integer({ minimum: 0, description: "The revision you read last." }),
  },
  { additionalProperties: false },
);
export type PatchStudioArgs = Type.Static<typeof PatchStudioArgs>;

export const GetStudioStateArgs = Type.Object(
  { taskId: Type.String() },
  { additionalProperties: false },
);
export type GetStudioStateArgs = Type.Static<typeof GetStudioStateArgs>;

export const CATALOG_KINDS = ["presets", "dataKinds", "renderers", "geometries", "tools", "commands", "panels", "inspectors", "exporters", "labelControls", "reviewRules", "modules"] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];

export const SearchCatalogArgs = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 200, description: "e.g. 'polygon tool', 'COCO export'." }),
    detail: Type.Optional(Type.Union([Type.Literal("brief"), Type.Literal("full")], { description: "full adds the example and config schema." })),
    kind: Type.Optional(Type.Union(CATALOG_KINDS.map((k) => Type.Literal(k)))),
  },
  { additionalProperties: false },
);
export type SearchCatalogArgs = Type.Static<typeof SearchCatalogArgs>;

export const OfferStudioArgs = Type.Object(
  {
    preset: presetRef,
    title: Type.String({ maxLength: 80, description: "Button text, e.g. 'Create X-ray Studio'." }),
    reason: Type.String({ maxLength: 200, description: "One sentence: what it is for." }),
  },
  { additionalProperties: false },
);
export type OfferStudioArgs = Type.Static<typeof OfferStudioArgs>;

export interface StudioToolSpec {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
}

/**
 * Fixed order (prompt caching: the tool list must be byte-identical across sessions). New tools go
 * at the end.
 */
export const STUDIO_TOOLS = [
  {
    name: "boot_studio",
    label: "Setting up Studio",
    description:
      "Create a draft Studio (task) from a preset, only when the person explicitly asks for one. Returns the task id and revision. Put labels and title in `patch`.",
    parameters: BootStudioArgs,
  },
  {
    name: "patch_studio",
    label: "Changing Studio",
    description: "Apply a small JSON Patch to a task's Studio setup at the revision you read; errors come back with paths.",
    parameters: PatchStudioArgs,
  },
  {
    name: "get_studio_state",
    label: "Reading Studio",
    description: "Read a task's Studio setup and its current revision.",
    parameters: GetStudioStateArgs,
  },
  {
    name: "search_catalog",
    label: "Searching catalogue",
    description: "Find module and contribution ids (renderers, tools, panels, exporters, label controls, presets) by words.",
    parameters: SearchCatalogArgs,
  },
  {
    name: "offer_studio",
    label: "Offering Studio",
    description: "Show a 'Create … Studio' button when the person only floats the idea; clicking it is their go-ahead. Creates nothing.",
    parameters: OfferStudioArgs,
  },
] as const satisfies readonly StudioToolSpec[];

export type StudioToolName = (typeof STUDIO_TOOLS)[number]["name"];
export const STUDIO_TOOL_NAMES: readonly StudioToolName[] = STUDIO_TOOLS.map((t) => t.name);
