import type { AgentCard, DatasetSnapshot as AgentContext, ClientToolSpec } from "@studio/agent-protocol";

/**
 * Card tools: the agent proposes, the expert decides. They run in the browser against the same
 * text snapshot the model sees, validate ids, and become cards that only act on a click. The
 * service returns `{ shown: true }` to the model straight away (apps/agent tools/client.ts).
 */

type Json = Record<string, unknown>;
const obj = (properties: Json, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description: string) => ({ type: "string", description });
const strList = (description: string) => ({ type: "array", items: { type: "string" }, description });

export const CARD_TOOLS: ClientToolSpec[] = [
  {
    name: "show_items",
    title: "Preparing item list",
    description: "Show the expert a clickable list of items (e.g. unannotated scans) so they can jump to each one. Use after list_items or run_validation.",
    input_schema: obj({ title: str("Short heading, e.g. 'Unannotated scans'."), itemIds: strList("Item ids to list, in order.") }),
  },
  {
    name: "propose_label_schema",
    title: "Drafting label set",
    description: "Propose a label set (classes with plain-language definitions). Shown as a card the expert can review and copy; it does not change the dataset.",
    input_schema: obj({
      title: str("Short heading."),
      labels: {
        type: "array",
        items: obj({ name: str("Class name."), description: str("One-sentence, plain-language definition and when to use it."), color: str("Optional hex colour.") }, ["name", "description"]),
      },
    }),
  },
  {
    name: "draft_document",
    title: "Writing document",
    description: "Write a markdown document (dataset card, annotation guideline, review notes). Shown as a card the expert can copy or download.",
    input_schema: obj({ title: str("Document title."), filename: str("Suggested filename ending in .md."), markdown: str("The full document in GitHub-flavoured markdown.") }),
  },
  {
    name: "suggest_tool",
    title: "Picking a tool",
    description: "Suggest the expert switch to one of the viewer's annotation tools (optionally with a label active). Use this instead of inventing geometry: you cannot see the image.",
    input_schema: obj({ tool: str("A tool id from viewerTools."), label: str("Label to make active, from the label set (optional)."), reason: str("One sentence on how to use it for this task.") }, ["tool", "reason"]),
  },
  {
    name: "propose_review",
    title: "Preparing review action",
    description: "Propose accepting or rejecting specific AI-suggested annotations. Nothing changes until the expert approves the card.",
    input_schema: obj({ action: { type: "string", enum: ["accept", "reject"] }, annotationIds: strList("Ids of ai-suggested annotations."), reason: str("Why, in one sentence.") }),
  },
  {
    name: "select_annotations",
    title: "Finding annotations",
    description: "Offer to select and reveal specific annotations in the viewer (e.g. the ones a validation issue refers to).",
    input_schema: obj({ annotationIds: strList("Annotation ids."), reason: str("What they have in common.") }),
  },
];

export const CARD_TOOL_NAMES = new Set(CARD_TOOLS.map((t) => t.name));

export interface CardResult {
  ok: boolean;
  output: Json;
  summary: string;
  card?: AgentCard;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function findItem(ctx: AgentContext, ref: string) {
  const r = ref.trim().toLowerCase();
  return ctx.items.find((i) => i.id.toLowerCase() === r || i.name.toLowerCase() === r) ?? ctx.items.find((i) => i.name.toLowerCase().includes(r));
}

/** Validate a card tool call against the snapshot and build its card. Never throws. */
export function runCardTool(name: string, input: Json, ctx: AgentContext): CardResult {
  const fail = (error: string, summary: string): CardResult => ({ ok: false, output: { error }, summary });
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  try {
    switch (name) {
      case "show_items": {
        const ids = [...new Set(list(input.itemIds).map((r) => findItem(ctx, r)?.id).filter((x): x is string => !!x))];
        if (!ids.length) return fail("None of those item ids exist.", "No matching items");
        return { ok: true, output: { shown: ids.length }, summary: `Listed ${plural(ids.length, "item")}`, card: { kind: "items", title: String(input.title ?? "Items"), itemIds: ids } };
      }
      case "propose_label_schema": {
        const labels = (Array.isArray(input.labels) ? input.labels : []).map((l: Json) => ({ name: String(l.name), description: String(l.description ?? ""), color: l.color ? String(l.color) : undefined }));
        if (!labels.length) return fail("No labels given.", "Empty label set");
        return { ok: true, output: { shown: true }, summary: plural(labels.length, "label"), card: { kind: "label-schema", title: String(input.title ?? "Label set"), labels } };
      }
      case "draft_document": {
        const filename = String(input.filename ?? "document.md").replace(/[^\w.-]+/g, "-");
        return { ok: true, output: { shown: true }, summary: filename, card: { kind: "document", title: String(input.title ?? filename), filename, markdown: String(input.markdown ?? "") } };
      }
      case "suggest_tool": {
        const tool = String(input.tool ?? "");
        if (!ctx.tools.includes(tool)) return fail(`This viewer has no "${tool}" tool. Available: ${ctx.tools.join(", ")}.`, "Unknown tool");
        const label = input.label ? String(input.label) : undefined;
        if (label && !ctx.project.labels.includes(label)) return fail(`"${label}" isn't in the label set: ${ctx.project.labels.join(", ")}.`, "Unknown label");
        return { ok: true, output: { shown: true }, summary: tool, card: { kind: "tool-switch", tool, label, reason: String(input.reason ?? "") } };
      }
      case "propose_review": {
        const pending = new Set(ctx.annotations.filter((a) => a.provenance === "ai-suggested").map((a) => a.id));
        const chosen = list(input.annotationIds).filter((id) => pending.has(id));
        if (!chosen.length) return fail("None of those ids are pending AI suggestions.", "Nothing to review");
        const action = input.action === "reject" ? "reject" : "accept";
        return {
          ok: true,
          output: { shown: true, count: chosen.length },
          summary: `${action === "accept" ? "Accept" : "Reject"} ${plural(chosen.length, "suggestion")}`,
          card: { kind: "review-suggestions", action, annotationIds: chosen, reason: String(input.reason ?? "") },
        };
      }
      case "select_annotations": {
        const known = new Set(ctx.annotations.map((a) => a.id));
        const ids = list(input.annotationIds).filter((id) => known.has(id));
        if (!ids.length) return fail("None of those annotation ids exist.", "No matches");
        return { ok: true, output: { shown: true }, summary: plural(ids.length, "annotation"), card: { kind: "select-annotations", annotationIds: ids, reason: String(input.reason ?? "") } };
      }
      default:
        return fail(`Unknown card tool ${name}.`, "Unknown tool");
    }
  } catch (e) {
    return fail(String(e), "Tool failed");
  }
}
