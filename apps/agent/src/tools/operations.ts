import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { z } from "zod";
import { OPERATIONS, type Operation, operationRequest, operationToolName } from "@studio/contracts/operations";
import type { ApprovalDetail } from "@studio/agent-protocol";
import { KernelError, type KernelClient } from "./kernel.ts";
import type { Decision } from "./policy.ts";

/**
 * Project operation tools generated from the operations catalogue (todo16 D7, D8, D9).
 *
 * The assistant acts with the delegated token of the person who sent the message, so the kernel
 * applies that person's project role (a viewer's assistant gets the kernel's 403, reported as
 * the reason). Reads stay hand-written in project.ts (metadata only); this module generates the
 * write, trash and destroy tools, plus `trash_list` and `undo_turn`.
 *
 * Every write in one run (assistant turn) is journaled in `TurnJournal`, so "Undo these
 * changes" (`undo_turn`, or the chat card) reverses the whole turn: fs batches through
 * `fs/undo`, trashed things through `trash/{batchId}/restore`.
 */

/** Operations served by hand-written tools (boot_studio, patch_studio, propose_structure, reads). */
const HAND_WRITTEN = new Set(["studio.boot", "studio.patch", "structure.propose", "labels.export"]);

export const OPERATION_TOOLS: Operation[] = OPERATIONS.filter((o) => !HAND_WRITTEN.has(o.id) && (o.tier !== "read" || o.id === "trash.list"));
export const OPERATION_TOOL_NAMES = [...OPERATION_TOOLS.map((o) => operationToolName(o.id)), "undo_turn"] as const;
const BY_TOOL = new Map(OPERATION_TOOLS.map((o) => [operationToolName(o.id), o]));

export const operationForTool = (toolName: string): Operation | undefined => BY_TOOL.get(toolName);

/** What one run changed, newest last. */
export interface JournalEntry {
  opId: string;
  tier: Operation["tier"];
  batchId: string;
  /** fs batches undo through `fs/undo`; the rest restore from the Trash. */
  via: "fs" | "trash";
  summary: string;
}

export class TurnJournal {
  private readonly byRun = new Map<string, JournalEntry[]>();
  add(runId: string, e: JournalEntry): void {
    const list = this.byRun.get(runId) ?? [];
    list.push(e);
    this.byRun.set(runId, list);
  }
  entries(runId: string): JournalEntry[] {
    return [...(this.byRun.get(runId) ?? [])];
  }
  clear(runId: string): void {
    this.byRun.delete(runId);
  }
  /** The newest run with changes, other than `except` (the run asking to undo). */
  lastRunWithChanges(except?: string): string | undefined {
    return [...this.byRun.keys()].reverse().find((r) => r !== except && (this.byRun.get(r)?.length ?? 0) > 0);
  }
}

/** Facts the policy needs for a catalogue call (looked up before deciding). */
export interface OperationFacts {
  /** Files a source.trash would move (folders count their descendants). */
  files?: number;
}

const removesNoun: Record<string, string> = { dataset: "a dataset", collection: "a collection", studio: "a Studio", project: "the whole project", files: "files", trash: "Trash" };

/**
 * D8 policy for catalogue tools: read and write run; trash runs (asks first for a dataset, Studio,
 * project or more than `askOver` files); destroy always asks and says it can't be undone.
 */
export function decideOperation(op: Operation, input: Record<string, unknown>, askOver: number, facts: OperationFacts = {}): Decision {
  if (op.tier === "read" || op.tier === "write") return { kind: "allow" };
  const ids = Object.entries(input)
    .filter(([k]) => k.endsWith("Id") || k === "nodeIds")
    .flatMap(([, v]) => (Array.isArray(v) ? v : [v]))
    .map(String);
  const items = ids.slice(0, 50).map((id) => ({ kind: op.removes ?? "item", id }));
  if (op.tier === "destroy") {
    const what = op.id === "trash.empty" ? "Empty the Trash: everything in it is deleted forever" : `${op.description.replace(/ Can't be undone\.$/, "")}`;
    return {
      kind: "ask",
      summary: `${what}. This can't be undone.`,
      detail: { kind: "operation", opId: op.id, tier: "destroy", irreversible: true, impact: { items, ...(facts.files !== undefined ? { files: facts.files } : {}) } } satisfies ApprovalDetail,
    };
  }
  const files = facts.files ?? (Array.isArray(input.nodeIds) ? input.nodeIds.length : 0);
  const big = op.removes === "files" ? files > askOver : op.removes === "dataset" || op.removes === "studio" || op.removes === "project";
  if (!big) return { kind: "allow" };
  return {
    kind: "ask",
    summary: op.removes === "files" ? `Move ${files} files to the Trash (restorable for 30 days)` : `Move ${removesNoun[op.removes!]} to the Trash with everything that depends on it (restorable for 30 days)`,
    detail: { kind: "operation", opId: op.id, tier: "trash", irreversible: false, impact: { items, ...(op.removes === "files" ? { files } : {}) } } satisfies ApprovalDetail,
  };
}

const text = (value: unknown, summary: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: { summary, ...details } });

export interface OperationToolDeps {
  kernel: KernelClient;
  projectId: string;
  journal: TurnJournal;
  runId: () => string | undefined;
  /** The approval id the person gave for this tool call (set by the policy extension). */
  approvalFor: (toolCallId: string) => string | undefined;
}

function batchOf(res: unknown): string | undefined {
  const r = res as { batchId?: unknown } | null;
  return r && typeof r.batchId === "string" ? r.batchId : undefined;
}

export function createOperationTools(d: OperationToolDeps): ToolDefinition<any, any, any>[] {
  const tools: ToolDefinition<any, any, any>[] = OPERATION_TOOLS.map((op) => {
    const name = operationToolName(op.id);
    const schema = z.toJSONSchema(op.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    const tierNote =
      op.tier === "trash" ? " Goes to the Trash; say so and that it can be undone." : op.tier === "destroy" ? " Permanent: the person is always asked first." : "";
    return {
      name,
      label: op.id,
      promptSnippet: op.description.slice(0, 200),
      description: `${op.description}${tierNote}`,
      parameters: Type.Unsafe<Record<string, unknown>>(schema),
      async execute(callId: string, params: Record<string, unknown>, signal: AbortSignal | undefined) {
        const parsed = op.input.safeParse(params ?? {});
        if (!parsed.success) throw new Error(`invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
        const req = operationRequest(op, d.projectId, parsed.data as Record<string, unknown>);
        const qs = req.query ? `?${new URLSearchParams(req.query)}` : "";
        const approval = d.approvalFor(callId);
        let res: unknown;
        try {
          res = await d.kernel.request(req.method, `${req.path}${qs}`, { json: req.body, signal, headers: approval ? { "X-Approval-Id": approval } : undefined });
        } catch (e) {
          if (e instanceof KernelError && e.status === 403) throw new Error(`Refused: ${e.message}`);
          throw e;
        }
        const batchId = batchOf(res);
        const runId = d.runId();
        if (batchId && runId && (op.tier === "write" || op.tier === "trash") && op.id !== "source.undo" && op.id !== "trash.restore")
          d.journal.add(runId, { opId: op.id, tier: op.tier, batchId, via: op.fsOp ? "fs" : "trash", summary: op.description });
        if (op.tier === "trash")
          return text({ movedToTrash: true, batchId, result: res, note: "Tell the person it went to the Trash and can be undone (Undo or Open Trash)." }, "Moved to Trash", { card: "trash", batchId, opId: op.id });
        if (op.tier === "destroy") return text({ deletedForever: true, result: res }, "Deleted forever", { opId: op.id });
        return text(res, "Done", { opId: op.id, ...(batchId ? { batchId } : {}) });
      },
    } satisfies ToolDefinition<any, any, any>;
  });
  tools.push({
    name: "undo_turn",
    label: "Undo these changes",
    promptSnippet: "Undo everything you changed in the previous turn",
    description: "Undo every change you made in one turn (default: your previous turn that changed something): restores what you trashed and reverses renames, moves and new folders.",
    parameters: Type.Object({ runId: Type.Optional(Type.String()) }),
    async execute(_callId: string, params: { runId?: string }, signal: AbortSignal | undefined) {
      const runId = params.runId ?? d.journal.lastRunWithChanges(d.runId());
      if (!runId) return text({ undone: 0, note: "Nothing to undo." }, "Nothing to undo");
      const entries = d.journal.entries(runId).reverse();
      for (const e of entries) {
        if (e.via === "fs") await d.kernel.request("POST", `/projects/${encodeURIComponent(d.projectId)}/fs/undo`, { json: { batchId: e.batchId }, signal });
        else await d.kernel.request("POST", `/projects/${encodeURIComponent(d.projectId)}/trash/${encodeURIComponent(e.batchId)}/restore`, { json: {}, signal });
      }
      d.journal.clear(runId);
      return text({ undone: entries.length }, `Undid ${entries.length} change${entries.length === 1 ? "" : "s"}`);
    },
  } satisfies ToolDefinition<any, any, any>);
  return tools;
}
