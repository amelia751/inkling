import type { AgentCard, AgentContext } from "@/studio/lib/agent/protocol";

/**
 * Agent tools. All of them run against the text snapshot the panel sends, so
 * none can read pixels or change the dataset. Tools that would change work
 * return a card instead; the expert applies it (or not) in the panel.
 */

type Json = Record<string, unknown>;
export interface ToolOutcome {
  /** What the model sees. */
  output: Json;
  /** One line for the tool row in the panel. */
  summary: string;
  card?: AgentCard;
}
interface ToolDef {
  name: string;
  /** Shown while the tool runs, e.g. "Checking validation". */
  title: string;
  description: string;
  parameters: Json;
  run: (args: Json, ctx: AgentContext) => ToolOutcome;
}

const obj = (properties: Json, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description: string) => ({ type: "string", description });
const nullable = (schema: Json) => ({ ...schema, type: [schema.type as string, "null"] });
const strList = (description: string) => ({ type: "array", items: { type: "string" }, description });

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function index(ctx: AgentContext) {
  const byItem = new Map<string, AgentContext["annotations"]>();
  for (const a of ctx.annotations) byItem.set(a.itemId, [...(byItem.get(a.itemId) ?? []), a]);
  const classOf = (itemId: string) => byItem.get(itemId)?.find((a) => a.type === "class")?.label;
  return { byItem, classOf };
}

function findItem(ctx: AgentContext, ref: string) {
  const r = ref.trim().toLowerCase();
  return ctx.items.find((i) => i.id.toLowerCase() === r || i.name.toLowerCase() === r) ?? ctx.items.find((i) => i.name.toLowerCase().includes(r));
}

function validation(ctx: AgentContext) {
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

const TOOLS: ToolDef[] = [
  {
    name: "get_dataset_overview",
    title: "Reading dataset overview",
    description: "Dataset title, data type, task, label set, license, item count, annotation progress per label and provenance, and the item open in the viewer.",
    parameters: obj({}),
    run: (_, ctx) => {
      const { byItem } = index(ctx);
      const perLabel: Record<string, number> = {};
      const perProvenance: Record<string, number> = {};
      for (const a of ctx.annotations) {
        perLabel[a.label] = (perLabel[a.label] ?? 0) + 1;
        perProvenance[a.provenance] = (perProvenance[a.provenance] ?? 0) + 1;
      }
      const current = ctx.items.find((i) => i.id === ctx.currentItemId);
      return {
        output: {
          project: ctx.project,
          items: ctx.items.length,
          groups: [...new Set(ctx.items.map((i) => i.group))],
          itemsAnnotated: byItem.size,
          annotations: ctx.annotations.length,
          perLabel,
          perProvenance,
          currentItem: current ? { ...current, annotations: byItem.get(current.id)?.length ?? 0 } : null,
          selectedAnnotations: ctx.selectedIds.length,
          viewerTools: ctx.tools,
        },
        summary: `${plural(ctx.items.length, "item")} · ${plural(ctx.annotations.length, "annotation")}`,
      };
    },
  },
  {
    name: "list_items",
    title: "Listing items",
    description: "List items (images, subjects, recordings…) filtered by annotation state. Returns ids, names, groups and annotation counts.",
    parameters: obj({
      filter: { type: "string", enum: ["all", "unannotated", "annotated", "has_ai_suggestions", "source_label_mismatch"], description: "Which items to return." },
      group: nullable(str("Only items in this group (as shown in the file tree), or null for all.")),
      limit: nullable({ type: "integer", description: "Max items to return (default 50)." }),
    }),
    run: (args, ctx) => {
      const { byItem, classOf } = index(ctx);
      const filter = args.filter as string;
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
      list = list.slice(0, (args.limit as number | null) ?? 50);
      return {
        output: { total, items: list.map((i) => ({ ...i, annotations: byItem.get(i.id)?.length ?? 0, class: classOf(i.id) ?? null })) },
        summary: `${plural(total, "item")} ${filter === "all" ? "" : filter.replace(/_/g, " ")}`.trim(),
      };
    },
  },
  {
    name: "get_item_annotations",
    title: "Reading annotations",
    description: "Annotations on one item: label, shape summary and provenance. Accepts an item id or name.",
    parameters: obj({ item: str("Item id or name.") }),
    run: (args, ctx) => {
      const item = findItem(ctx, String(args.item));
      if (!item) return { output: { error: `No item matches "${args.item}".` }, summary: "Item not found" };
      const anns = ctx.annotations.filter((a) => a.itemId === item.id);
      return { output: { item, annotations: anns }, summary: `${item.name} · ${plural(anns.length, "annotation")}` };
    },
  },
  {
    name: "run_validation",
    title: "Checking validation",
    description: "Run the dataset's validation checks: unannotated items, unreviewed AI suggestions, unknown labels, disagreements with source labels, unsaved edits.",
    parameters: obj({}),
    run: (_, ctx) => {
      const issues = validation(ctx);
      return {
        output: { issues: issues.map((i) => ({ ...i, itemIds: i.itemIds.slice(0, 40), annotationIds: i.annotationIds.slice(0, 40) })) },
        summary: issues.length ? plural(issues.length, "issue") : "No issues",
      };
    },
  },
  {
    name: "show_items",
    title: "Preparing item list",
    description: "Show the expert a clickable list of items (e.g. unannotated scans) so they can jump to each one. Use after list_items or run_validation.",
    parameters: obj({ title: str("Short heading, e.g. 'Unannotated scans'."), itemIds: strList("Item ids to list, in order.") }),
    run: (args, ctx) => {
      const ids = (args.itemIds as string[]).map((r) => findItem(ctx, r)?.id).filter((x): x is string => !!x);
      if (!ids.length) return { output: { error: "None of those item ids exist." }, summary: "No matching items" };
      return { output: { shown: ids.length }, summary: `Listed ${plural(ids.length, "item")}`, card: { kind: "items", title: String(args.title), itemIds: [...new Set(ids)] } };
    },
  },
  {
    name: "propose_label_schema",
    title: "Drafting label set",
    description: "Propose a label set (classes with plain-language definitions). Shown as a card the expert can review and copy; it does not change the dataset.",
    parameters: obj({
      title: str("Short heading."),
      labels: { type: "array", items: obj({ name: str("Class name."), description: str("One-sentence, plain-language definition and when to use it."), color: nullable(str("Optional hex colour.")) }) },
    }),
    run: (args) => {
      const labels = (args.labels as { name: string; description: string; color: string | null }[]).map((l) => ({ name: l.name, description: l.description, color: l.color ?? undefined }));
      return { output: { shown: true, note: "Shown as a card. The expert decides whether to adopt it." }, summary: plural(labels.length, "label"), card: { kind: "label-schema", title: String(args.title), labels } };
    },
  },
  {
    name: "draft_document",
    title: "Writing document",
    description: "Write a markdown document (dataset card, annotation guideline, review notes). Shown as a card the expert can copy or download.",
    parameters: obj({ title: str("Document title."), filename: str("Suggested filename ending in .md."), markdown: str("The full document in GitHub-flavoured markdown.") }),
    run: (args) => ({
      output: { shown: true },
      summary: String(args.filename),
      card: { kind: "document", title: String(args.title), filename: String(args.filename).replace(/[^\w.-]+/g, "-"), markdown: String(args.markdown) },
    }),
  },
  {
    name: "suggest_tool",
    title: "Picking a tool",
    description: "Suggest the expert switch to one of the viewer's annotation tools (optionally with a label active). Use this instead of inventing geometry: you cannot see the image.",
    parameters: obj({ tool: str("A tool id from viewerTools."), label: nullable(str("Label to make active, from the label set, or null.")), reason: str("One sentence on how to use it for this task.") }),
    run: (args, ctx) => {
      const tool = String(args.tool);
      if (!ctx.tools.includes(tool)) return { output: { error: `This viewer has no "${tool}" tool. Available: ${ctx.tools.join(", ")}.` }, summary: "Unknown tool" };
      const label = args.label ? String(args.label) : undefined;
      if (label && !ctx.project.labels.includes(label)) return { output: { error: `"${label}" isn't in the label set: ${ctx.project.labels.join(", ")}.` }, summary: "Unknown label" };
      return { output: { shown: true }, summary: tool, card: { kind: "tool-switch", tool, label, reason: String(args.reason) } };
    },
  },
  {
    name: "propose_review",
    title: "Preparing review action",
    description: "Propose accepting or rejecting specific AI-suggested annotations. Nothing changes until the expert approves the card.",
    parameters: obj({ action: { type: "string", enum: ["accept", "reject"] }, annotationIds: strList("Ids of ai-suggested annotations."), reason: str("Why, in one sentence.") }),
    run: (args, ctx) => {
      const ids = new Set(ctx.annotations.filter((a) => a.provenance === "ai-suggested").map((a) => a.id));
      const chosen = (args.annotationIds as string[]).filter((id) => ids.has(id));
      if (!chosen.length) return { output: { error: "None of those ids are pending AI suggestions." }, summary: "Nothing to review" };
      return {
        output: { shown: true, count: chosen.length, note: "Awaiting the expert's approval." },
        summary: `${args.action === "accept" ? "Accept" : "Reject"} ${plural(chosen.length, "suggestion")}`,
        card: { kind: "review-suggestions", action: args.action as "accept" | "reject", annotationIds: chosen, reason: String(args.reason) },
      };
    },
  },
  {
    name: "select_annotations",
    title: "Finding annotations",
    description: "Offer to select and reveal specific annotations in the viewer (e.g. the ones a validation issue refers to).",
    parameters: obj({ annotationIds: strList("Annotation ids."), reason: str("What they have in common.") }),
    run: (args, ctx) => {
      const known = new Set(ctx.annotations.map((a) => a.id));
      const ids = (args.annotationIds as string[]).filter((id) => known.has(id));
      if (!ids.length) return { output: { error: "None of those annotation ids exist." }, summary: "No matches" };
      return { output: { shown: true }, summary: plural(ids.length, "annotation"), card: { kind: "select-annotations", annotationIds: ids, reason: String(args.reason) } };
    },
  },
];

export const toolSpecs = TOOLS.map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.parameters, strict: true }));
export const toolTitle = (name: string) => TOOLS.find((t) => t.name === name)?.title ?? name;

export function runTool(name: string, rawArgs: string, ctx: AgentContext): ToolOutcome & { input: unknown; ok: boolean } {
  const tool = TOOLS.find((t) => t.name === name);
  let input: Json = {};
  try {
    input = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { input: rawArgs, ok: false, output: { error: "Arguments were not valid JSON." }, summary: "Invalid arguments" };
  }
  if (!tool) return { input, ok: false, output: { error: `Unknown tool ${name}.` }, summary: "Unknown tool" };
  try {
    const r = tool.run(input, ctx);
    return { ...r, input, ok: !("error" in r.output) };
  } catch (e) {
    return { input, ok: false, output: { error: String(e) }, summary: "Tool failed" };
  }
}
