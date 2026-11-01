import { type ToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DatasetSnapshot } from "@studio/agent-protocol";

/**
 * Server tools over the text-only dataset snapshot (ported from the old apps/web/dev/agent/tools.ts).
 * None can read pixels or change the dataset. The principal (project) comes from the session record
 * the server created, never from tool arguments: a `projectId` argument naming another project is
 * an error.
 */

export class ProjectScopeError extends Error {
  override name = "ProjectScopeError";
}

export interface DatasetSource {
  /** The project this session is scoped to. */
  readonly projectId: string;
  snapshot(signal?: AbortSignal): Promise<DatasetSnapshot>;
}

/** The latest snapshot the Studio sent; falls back to `fallback` (the seed API) when none arrived yet. */
export class SessionDatasetSource implements DatasetSource {
  private latest: DatasetSnapshot | undefined;

  constructor(
    readonly projectId: string,
    private readonly fallback?: DatasetSource,
  ) {}

  update(s: DatasetSnapshot): void {
    if (s.project.id !== this.projectId) throw new ProjectScopeError(`snapshot is for project ${s.project.id}, this session is scoped to ${this.projectId}`);
    this.latest = s;
  }

  async snapshot(signal?: AbortSignal): Promise<DatasetSnapshot> {
    if (this.latest) return this.latest;
    if (this.fallback) return this.fallback.snapshot(signal);
    throw new Error("The Studio hasn't shared a dataset snapshot in this session.");
  }
}

interface SeedProject {
  id: string;
  title: string;
  viewer?: string;
  task?: string;
  labels?: (string | { classes?: { id: string }[] })[];
  license?: string;
  source?: string;
  restricted?: boolean;
  environment?: { extends?: string | string[]; labels?: { classes?: { id: string }[] }[] };
  assets?: { path: string; label?: string }[];
}

/**
 * Dev seed API (`/seed/manifest.json`, `/api/annotations/:id` on the Vite dev server). Items are
 * approximated by seed assets, so ids are asset paths; the Studio's own snapshot is preferred.
 * Moves to apps/api once it exists.
 */
export class SeedApiDatasetSource implements DatasetSource {
  constructor(
    readonly projectId: string,
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async snapshot(signal?: AbortSignal): Promise<DatasetSnapshot> {
    const get = async (path: string) => {
      const res = await this.fetchImpl(new URL(path, this.baseUrl), { signal });
      if (!res.ok) throw new Error(`Studio API ${path} returned ${res.status}`);
      return res.json() as Promise<any>;
    };
    const manifest = (await get("/seed/manifest.json")) as { projects: SeedProject[] };
    const p = manifest.projects.find((x) => x.id === this.projectId);
    if (!p) throw new Error(`No project "${this.projectId}" in the seed manifest.`);
    const doc = (await get(`/api/annotations/${encodeURIComponent(this.projectId)}`)) as { annotations?: any[] };
    const labelIds = (groups: SeedProject["labels"]) =>
      [...new Set((groups ?? []).flatMap((g) => (typeof g === "string" ? [g] : (g.classes ?? []).map((c) => c.id))))];
    return {
      project: {
        id: p.id,
        title: p.title,
        viewer: p.viewer ?? String(p.environment?.extends ?? "unknown"),
        task: p.task,
        labels: labelIds(p.environment?.labels ?? p.labels),
        license: p.license ?? "",
        source: p.source ?? "",
        restricted: !!p.restricted,
      },
      items: (p.assets ?? []).map((a) => ({
        id: a.path,
        name: a.path.split("/").pop() ?? a.path,
        group: a.path.split("/").slice(1, -1).join("/") || "/",
        sourceLabel: a.label,
      })),
      annotations: (doc.annotations ?? []).map((a) => ({
        id: String(a.id),
        itemId: String(a.itemId),
        label: String(a.label),
        type: String(a.geometry?.type ?? "unknown"),
        provenance: a.provenance ?? "human-created",
        summary: String(a.geometry?.type ?? ""),
      })),
      selectedIds: [],
      tools: [],
      unsavedChanges: false,
    };
  }
}

type Snapshot = DatasetSnapshot;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function index(ctx: Snapshot) {
  const byItem = new Map<string, Snapshot["annotations"]>();
  for (const a of ctx.annotations) byItem.set(a.itemId, [...(byItem.get(a.itemId) ?? []), a]);
  const classOf = (itemId: string) => byItem.get(itemId)?.find((a) => a.type === "class")?.label;
  return { byItem, classOf };
}

export function findItem(ctx: Snapshot, ref: string) {
  const r = ref.trim().toLowerCase();
  return ctx.items.find((i) => i.id.toLowerCase() === r || i.name.toLowerCase() === r) ?? ctx.items.find((i) => i.name.toLowerCase().includes(r));
}

export function validationIssues(ctx: Snapshot) {
  const { byItem, classOf } = index(ctx);
  const issues: { severity: "warning" | "info"; code: string; message: string; itemIds: string[]; annotationIds: string[] }[] = [];
  const unannotated = ctx.items.filter((i) => !byItem.has(i.id));
  if (unannotated.length)
    issues.push({ severity: "warning", code: "unannotated-items", message: `${unannotated.length} of ${ctx.items.length} items have no annotations yet.`, itemIds: unannotated.map((i) => i.id), annotationIds: [] });
  const pending = ctx.annotations.filter((a) => a.provenance === "ai-suggested");
  if (pending.length)
    issues.push({ severity: "warning", code: "unreviewed-ai", message: `${plural(pending.length, "AI suggestion")} still need a human decision (accept or reject).`, itemIds: [...new Set(pending.map((a) => a.itemId))], annotationIds: pending.map((a) => a.id) });
  const unknown = ctx.annotations.filter((a) => ctx.project.labels.length && !ctx.project.labels.includes(a.label) && a.type !== "rhythm" && a.type !== "beat");
  if (unknown.length)
    issues.push({ severity: "warning", code: "unknown-label", message: `${plural(unknown.length, "annotation")} use labels outside the dataset's label set.`, itemIds: [...new Set(unknown.map((a) => a.itemId))], annotationIds: unknown.map((a) => a.id) });
  if (ctx.project.task === "classification") {
    const mismatch = ctx.items.filter((i) => i.sourceLabel && classOf(i.id) && classOf(i.id)!.toLowerCase() !== i.sourceLabel.toLowerCase());
    if (mismatch.length)
      issues.push({ severity: "info", code: "source-label-mismatch", message: `${plural(mismatch.length, "item")} are labelled differently from the source dataset's label. Worth a second look, not necessarily wrong.`, itemIds: mismatch.map((i) => i.id), annotationIds: [] });
  }
  if (ctx.unsavedChanges) issues.push({ severity: "info", code: "unsaved", message: "There are unsaved edits; exports use the last saved revision.", itemIds: [], annotationIds: [] });
  return issues;
}

const projectIdParam = Type.Optional(Type.String({ description: "Optional. Must be the current project's id if given." }));

const result = (output: unknown, summary: string) => ({
  content: [{ type: "text" as const, text: JSON.stringify(output) }],
  details: { summary },
});

export function createDatasetTools(source: DatasetSource): ToolDefinition<any, any, any>[] {
  const load = async (args: { projectId?: string }, signal?: AbortSignal) => {
    if (args.projectId !== undefined && args.projectId !== source.projectId)
      throw new ProjectScopeError(`This session is scoped to project "${source.projectId}"; "${args.projectId}" is not accessible.`);
    return source.snapshot(signal);
  };

  const overview = defineTool({
    name: "dataset_overview",
    label: "Reading dataset overview",
    description:
      "Dataset title, data type, task, label set, licence, item count, annotation progress per label and provenance, and the item open in the viewer.",
    promptSnippet: "Overview of the open dataset and annotation progress",
    parameters: Type.Object({ projectId: projectIdParam }),
    async execute(_id, args, signal) {
      const ctx = await load(args, signal);
      const { byItem } = index(ctx);
      const perLabel: Record<string, number> = {};
      const perProvenance: Record<string, number> = {};
      for (const a of ctx.annotations) {
        perLabel[a.label] = (perLabel[a.label] ?? 0) + 1;
        perProvenance[a.provenance] = (perProvenance[a.provenance] ?? 0) + 1;
      }
      const current = ctx.items.find((i) => i.id === ctx.currentItemId);
      return result(
        {
          project: ctx.project,
          items: ctx.items.length,
          groups: [...new Set(ctx.items.map((i) => i.group))].slice(0, 100),
          itemsAnnotated: byItem.size,
          annotations: ctx.annotations.length,
          perLabel,
          perProvenance,
          currentItem: current ? { ...current, annotations: byItem.get(current.id)?.length ?? 0 } : null,
          selectedAnnotations: ctx.selectedIds.length,
          viewerTools: ctx.tools,
        },
        `${plural(ctx.items.length, "item")} · ${plural(ctx.annotations.length, "annotation")}`,
      );
    },
  });

  const listItems = defineTool({
    name: "list_items",
    label: "Listing items",
    description: "List items (images, subjects, recordings…) filtered by annotation state. Returns ids, names, groups and annotation counts.",
    promptSnippet: "List dataset items by annotation state",
    parameters: Type.Object({
      filter: Type.Union(
        ["all", "unannotated", "annotated", "has_ai_suggestions", "source_label_mismatch"].map((v) => Type.Literal(v)),
        { description: "Which items to return." },
      ),
      group: Type.Optional(Type.String({ description: "Only items in this group (as shown in the file tree)." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Max items to return (default 50)." })),
      projectId: projectIdParam,
    }),
    async execute(_id, args, signal) {
      const ctx = await load(args, signal);
      const { byItem, classOf } = index(ctx);
      const filter = String(args.filter);
      let list = ctx.items.filter((i) => {
        const anns = byItem.get(i.id) ?? [];
        if (filter === "unannotated") return anns.length === 0;
        if (filter === "annotated") return anns.length > 0;
        if (filter === "has_ai_suggestions") return anns.some((a) => a.provenance === "ai-suggested");
        if (filter === "source_label_mismatch") return !!i.sourceLabel && !!classOf(i.id) && classOf(i.id)!.toLowerCase() !== i.sourceLabel.toLowerCase();
        return true;
      });
      if (args.group) list = list.filter((i) => i.group.toLowerCase() === String(args.group).toLowerCase());
      const total = list.length;
      list = list.slice(0, args.limit ?? 50);
      return result(
        { total, items: list.map((i) => ({ ...i, annotations: byItem.get(i.id)?.length ?? 0, class: classOf(i.id) ?? null })) },
        `${plural(total, "item")} ${filter === "all" ? "" : filter.replace(/_/g, " ")}`.trim(),
      );
    },
  });

  const itemAnnotations = defineTool({
    name: "get_item_annotations",
    label: "Reading annotations",
    description: "Annotations on one item: label, shape summary and provenance. Accepts an item id or name.",
    promptSnippet: "Annotations on one item",
    parameters: Type.Object({ item: Type.String({ description: "Item id or name." }), projectId: projectIdParam }),
    async execute(_id, args, signal) {
      const ctx = await load(args, signal);
      const item = findItem(ctx, String(args.item));
      if (!item) throw new Error(`No item matches "${args.item}".`);
      const anns = ctx.annotations.filter((a) => a.itemId === item.id);
      return result({ item, annotations: anns.slice(0, 500), total: anns.length }, `${item.name} · ${plural(anns.length, "annotation")}`);
    },
  });

  const runValidation = defineTool({
    name: "run_validation",
    label: "Checking validation",
    description: "Run the dataset's validation checks: unannotated items, unreviewed AI suggestions, unknown labels, disagreements with source labels, unsaved edits.",
    promptSnippet: "Run dataset validation checks",
    parameters: Type.Object({ projectId: projectIdParam }),
    async execute(_id, args, signal) {
      const issues = validationIssues(await load(args, signal));
      return result(
        { issues: issues.map((i) => ({ ...i, itemIds: i.itemIds.slice(0, 40), annotationIds: i.annotationIds.slice(0, 40) })) },
        issues.length ? plural(issues.length, "issue") : "No issues",
      );
    },
  });

  return [overview, listItems, itemAnnotations, runValidation];
}

export const DATASET_TOOL_NAMES = ["dataset_overview", "list_items", "get_item_annotations", "run_validation"] as const;
