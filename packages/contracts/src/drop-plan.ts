import * as z from "zod";

/**
 * What happens to a drop (todo13 D5, D6, §3.3, §5 contracts). After inspection the kernel
 * classifies a drop's files into groups (`drop.classified {dropId, groups}`) and gives each group
 * one action; the plan (`drop.planned {dropId, plan, auto}`) is shown as a card in chat. Actions
 * that only touch the person's own drafts apply on their own, with Undo; anything touching a
 * published dataset, or anything ambiguous, waits for the person (`needsPerson`).
 *
 * The contract fields (`dropId`, `actions[].{groupId, type, datasetId?, collectionId?, name?,
 * preset?, nodeIds}`, `needsPerson`) are fixed (change only through the integrator). The
 * optional fields after them are additive: what the card needs to word an action without
 * another round trip. None carries a file name, a cell value or a content-derived value.
 */

export const DROP_ACTION_TYPES = ["add_to_collection", "new_collection", "new_dataset", "unpack", "keep_reference", "keep_unsupported", "link_existing"] as const;
export const DropActionType = z.enum(DROP_ACTION_TYPES);
export type DropActionType = z.infer<typeof DropActionType>;

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const Kind = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

/** A group's shape: technical facts only (modality, columns are names of a table's columns). */
export const DropGroupShape = z
  .object({
    modality: z.string().max(16).optional(),
    columns: z.number().int().nonnegative().optional(),
    nameColumns: z.number().int().nonnegative().optional(),
    series: z.number().int().nonnegative().optional(),
  })
  .strict();

export const DropGroup = z
  .object({
    groupId: Id,
    kind: Kind,
    count: z.number().int().nonnegative(),
    shape: DropGroupShape.optional(),
    suggestedAction: DropActionType,
    nodeIds: z.array(Id),
    /** Files with a privacy hold (burned-in text, identifiers): normal action plus a notice. */
    held: z.number().int().nonnegative().optional(),
    /** Files whose bytes were already in Files (same SHA-256). */
    existing: z.number().int().nonnegative().optional(),
    /** Files whose extension says another kind than their content ("Looks like a ZIP"). */
    spoofed: z.number().int().nonnegative().optional(),
    /**
     * todo20 D9: files (also in `nodeIds`) that are a slot of another file's item, not items:
     * a subject's `_seg` is its `reference` slot, a WFDB `.mat`/`.dat` its header's `signal`.
     */
    parts: z.array(z.object({ nodeId: Id, of: Id, slot: z.enum(["reference", "signal", "sidecar"]) }).strict()).optional(),
  })
  .strict()
  .meta({ id: "DropGroup" });
export type DropGroup = z.infer<typeof DropGroup>;

/** What the card asks or offers for one action, beyond Apply. */
export const DropActionAsk = z.enum(["labels_table", "tabular_collection", "attach_documentation", "find_plugin", "which_dataset"]);

/** todo19 D5: one viewable group inside a drop's one `new_dataset` action (it gets a collection
 * in the dataset, and its kind a profile in the dataset's one Studio). */
export const DropMember = z
  .object({
    groupId: Id,
    kind: Kind,
    count: z.number().int().nonnegative(),
    nodeIds: z.array(Id),
    name: z.string().min(1).max(200).optional(),
    preset: z
      .string()
      .regex(/^preset:[A-Za-z0-9._-]+$/)
      .optional(),
    held: z.number().int().nonnegative().optional(),
  })
  .strict()
  .meta({ id: "DropMember" });
export type DropMember = z.infer<typeof DropMember>;

export const DropAction = z
  .object({
    groupId: Id,
    type: DropActionType,
    datasetId: Id.optional(),
    collectionId: Id.optional(),
    name: z.string().min(1).max(200).optional(),
    preset: z
      .string()
      .regex(/^preset:[A-Za-z0-9._-]+$/)
      .optional(),
    nodeIds: z.array(Id),
    // ---- additive (not in the §5 contract) ----
    kind: Kind.optional(),
    count: z.number().int().nonnegative().optional(),
    /** This action waits for the person (published dataset, someone else's, a question). */
    asks: DropActionAsk.optional(),
    /** `labels_table`: the collection the table would describe. */
    relatesTo: Id.optional(),
    /** Files held for privacy review in this group. */
    held: z.number().int().nonnegative().optional(),
    /** The kind to search plugins for (`keep_unsupported`). */
    findPluginKind: Kind.optional(),
    /** todo19 D5 (`new_dataset`): the viewable groups the one dataset and its one Studio hold. */
    members: z.array(DropMember).optional(),
    /** The kinds of `members`, in order; the Studio accepts them. */
    kinds: z.array(Kind).optional(),
    /** One profile preset per kind present (the Studio's `extends`). */
    presets: z
      .array(z.string().regex(/^preset:[A-Za-z0-9._-]+$/))
      .optional(),
  })
  .strict()
  .meta({ id: "DropAction" });
export type DropAction = z.infer<typeof DropAction>;

export const DropPlan = z
  .object({
    dropId: Id,
    actions: z.array(DropAction),
    needsPerson: z.boolean(),
  })
  .strict()
  .meta({ id: "DropPlan" });
export type DropPlan = z.infer<typeof DropPlan>;

/** `GET /api/v1/drops/{id}/plan` (and the apply / undo answers): the plan and where it stands. */
export interface DropPlanState {
  dropId: string;
  projectId: string;
  state: "planned" | "applying" | "applied" | "undone" | "failed";
  plan: DropPlan;
  groups: DropGroup[];
  /** Applied without a click (D6). */
  auto: boolean;
  /** Applied through the fast path (principle 3). */
  fastPath?: boolean;
  datasetId?: string | null;
  taskIds: string[];
  collectionIds: string[];
  /** ISO time until which Undo works; null when it can't be undone. */
  undoUntil: string | null;
  /** Pipeline runs the apply started (D9, after todo12 Milestone 1). */
  pipelineRunIds?: string[];
  /** todo20 D4: the apply made the project's default Studio, or added to an existing one. */
  outcome?: DropApplyOutcome | null;
  /** todo20 D4: the Studio the drop's files are in (the new default, or the one added to). */
  studioTaskId?: string | null;
  /** todo20 D5: files this apply put into the Studio, and files it already had. */
  new?: number;
  alreadyHere?: number;
  error?: { step: string; errorClass: string; message?: string };
}

export type DropApplyOutcome = "new_default_studio" | "add_to_studio";

/** Event payloads (project SSE; kernel outbox envelope). `drop.*` events are typed in `drops.ts`. */
export interface DropClassifiedEvent {
  dropId: string;
  groups: Omit<DropGroup, "nodeIds">[];
}
export interface DropPlannedEvent {
  dropId: string;
  plan: DropPlan;
  auto: boolean;
}
export interface DropAppliedEvent {
  dropId: string;
  datasetId?: string;
  taskIds: string[];
  undoUntil: string | null;
  collectionIds?: string[];
  pipelineRunIds?: string[];
  outcome?: DropApplyOutcome | null;
  studioTaskId?: string | null;
  new?: number;
  alreadyHere?: number;
  /** The apply was reverted (Undo) — same event type, so the card follows one stream. */
  undone?: boolean;
}
