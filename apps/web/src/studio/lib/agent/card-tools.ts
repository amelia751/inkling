import type { AgentCard, DatasetSnapshot as AgentContext, ClientToolSpec } from "@studio/agent-protocol";
import { parseReorgPlan, planSummary } from "./reorg";

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
    name: "open_location",
    title: "Pointing to a place",
    description:
      "Show the user a button that opens a place in the project, e.g. 'Open Data › MRI/patient_002' or 'Review it in Explore'. You never navigate yourself; they click. Use ids from the project tools (nodeId, proposalId, taskId, datasetId), never paths.",
    input_schema: obj(
      {
        section: { type: "string", enum: ["overview", "sources", "explore", "datasets", "studio", "review", "activity"], description: "The project section." },
        label: str("Button text naming the place, e.g. 'Data › MRI/patient_002'."),
        nodeId: str("Data: a file or folder id."),
        proposalId: str("Explore: a proposal id."),
        tab: str("Explore: summary, relationships, mappings or quality."),
        taskId: str("Studio: a task id."),
        datasetId: str("Datasets: a dataset id."),
        reason: str("Optional sentence shown above the button."),
      },
      ["section", "label"],
    ),
  },
  {
    name: "propose_reorganization",
    title: "Drafting a reorganization",
    description:
      "Propose reorganizing the project's Files: new folders (mkdir), moves and renames, each with a one-line reason. Shown as a card with a before/after diff; nothing changes until the user clicks Apply, which they can undo in one step. " +
      "You can't change files yourself. Use ids from list_folder or find_files, never paths. Give each new folder a short ref (e.g. \"p1\") and use that ref as parentId to move things into it. Keep names free of dates of birth and personal names.",
    input_schema: obj({
      title: str("One line, e.g. 'Group by patient: 47 folders → patient_001…047'."),
      ops: {
        type: "array",
        description: "In order. A mkdir must come before ops that use its ref.",
        items: obj(
          {
            kind: { type: "string", enum: ["mkdir", "move", "rename"] },
            ref: str("mkdir: a short handle for the new folder (letters, digits, . _ -), used as parentId by later ops."),
            parentId: str("mkdir and move: the folder id (or a mkdir ref) it goes into."),
            name: str("mkdir and rename: the new name (no '/')."),
            nodeIds: strList("move: ids of the files or folders to move."),
            nodeId: str("rename: the id of the file or folder."),
            reason: str("One short sentence: why."),
          },
          ["kind", "reason"],
        ),
      },
    }),
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

const SECTIONS = new Set(["overview", "sources", "explore", "datasets", "studio", "review", "activity"]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
/** Studio cards act on the dataset snapshot; outside the Studio there is none. */
const NEEDS_SNAPSHOT = new Set(["show_items", "suggest_tool", "propose_review", "select_annotations"]);

/**
 * Validate a card tool call and build its card. Never throws. `ctx` is the Studio's dataset
 * snapshot; without it (Overview, Sources, Explore) only project cards work.
 */
export function runCardTool(name: string, input: Json, ctx?: AgentContext): CardResult {
  const fail = (error: string, summary: string): CardResult => ({ ok: false, output: { error }, summary });
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  if (!ctx && NEEDS_SNAPSHOT.has(name)) return fail("That acts on the Studio, which isn't open. Use open_location to offer the Studio instead.", "Needs the Studio");
  try {
    switch (name) {
      case "open_location": {
        const section = String(input.section ?? "");
        if (!SECTIONS.has(section)) return fail(`Unknown section "${section}".`, "Unknown place");
        const target: Record<string, string> & { section: string } = { section };
        for (const k of ["nodeId", "proposalId", "tab", "taskId", "datasetId"] as const) {
          const v = input[k];
          if (v === undefined || v === null || v === "") continue;
          if (typeof v !== "string" || !ID_RE.test(v)) return fail(`${k} must be an id from a project tool, not a path.`, "Bad id");
          target[k] = v;
        }
        const label = String(input.label ?? "").trim().slice(0, 80) || section[0]!.toUpperCase() + section.slice(1);
        return {
          ok: true,
          output: { shown: true },
          summary: label,
          card: { kind: "location", label, target: target as unknown as Extract<AgentCard, { kind: "location" }>["target"], reason: input.reason ? String(input.reason).slice(0, 300) : undefined },
        };
      }
      case "show_items": {
        const ids = [...new Set(list(input.itemIds).map((r) => findItem(ctx!, r)?.id).filter((x): x is string => !!x))];
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
        if (!ctx!.tools.includes(tool)) return fail(`This viewer has no "${tool}" tool. Available: ${ctx!.tools.join(", ")}.`, "Unknown tool");
        const label = input.label ? String(input.label) : undefined;
        if (label && !ctx!.project.labels.includes(label)) return fail(`"${label}" isn't in the label set: ${ctx!.project.labels.join(", ")}.`, "Unknown label");
        return { ok: true, output: { shown: true }, summary: tool, card: { kind: "tool-switch", tool, label, reason: String(input.reason ?? "") } };
      }
      case "propose_review": {
        const pending = new Set(ctx!.annotations.filter((a) => a.provenance === "ai-suggested").map((a) => a.id));
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
      case "propose_reorganization": {
        const r = parseReorgPlan(input);
        if ("error" in r) return fail(r.error, "Plan not valid");
        return { ok: true, output: { shown: true, planId: r.plan.id, ops: r.plan.ops.length }, summary: planSummary(r.plan) || r.plan.title, card: { kind: "reorg-plan", plan: r.plan } };
      }
      case "select_annotations": {
        const known = new Set(ctx!.annotations.map((a) => a.id));
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
