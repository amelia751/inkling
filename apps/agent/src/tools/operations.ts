import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { StudioToolDefinition } from "./define.ts";
import { Type } from "typebox";
import { z } from "zod";
import { OPERATIONS, type Operation, operationRequest, operationToolName } from "@studio/contracts/operations";
import type { ApprovalDetail } from "@studio/agent-protocol";
import { KernelError, type KernelClient } from "./kernel.ts";
import type { Decision } from "./policy.ts";
import { approvalToken, operationTargets } from "./approval-token.ts";

/**
 * Project operation tools generated from the operations catalogue (todo16 D7, D8, D9).
 *
 * The assistant acts with the delegated token of the person who sent the message, so the kernel
 * applies that person's project role (a viewer's assistant gets the kernel's 403, reported as
 * the reason). Reads stay hand-written in project.ts (metadata only); this module generates the
 * write, trash and destroy tools, plus `trash_list` and `undo_turn`.
 *
 * The kernel journals every write of a run (assistant turn): the kernel client sends the run id
 * as `X-Turn-Id` and each `fs_batches` row records it (todo16 D9). "Undo these changes"
 * (`undo_turn`, or the chat card) asks the kernel to undo the whole turn
 * (`POST /projects/{pid}/turns/{turnId}/undo`); nothing is kept in this process.
 */

/** Operations served by hand-written tools (boot_studio, patch_studio, propose_structure, reads). */
const HAND_WRITTEN = new Set(["studio.boot", "studio.patch", "structure.propose", "labels.export"]);

export const OPERATION_TOOLS: Operation[] = OPERATIONS.filter((o) => !HAND_WRITTEN.has(o.id) && (o.tier !== "read" || o.id === "trash.list"));
export const OPERATION_TOOL_NAMES = [...OPERATION_TOOLS.map((o) => operationToolName(o.id)), "undo_turn"] as const;
const BY_TOOL = new Map(OPERATION_TOOLS.map((o) => [operationToolName(o.id), o]));

export const operationForTool = (toolName: string): Operation | undefined => BY_TOOL.get(toolName);

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
  const ids = operationTargets(input);
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
  /** The approval id the person gave for this tool call (set by the policy extension). */
  approvalFor: (toolCallId: string) => string | undefined;
  /** The person's delegated kernel token and the key approvals are signed with (todo16 D8). */
  kernelToken: () => string | undefined;
  approvalSecret: string;
}

function batchOf(res: unknown): string | undefined {
  const r = res as { batchId?: unknown } | null;
  return r && typeof r.batchId === "string" ? r.batchId : undefined;
}

const PAST_VERB: Record<string, string> = {
  list: "Listed", search: "Searched", mkdir: "Made a folder in", rename: "Renamed", move: "Moved", copy: "Copied", trash: "Trashed",
  restore: "Restored", purge: "Deleted forever", versions_restore: "Restored a version of", star: "Starred", unstar: "Unstarred",
  undo: "Undid a change to", cancel: "Cancelled", retry: "Retried", create: "Created", add_files: "Added files to", delete: "Deleted",
  propose: "Proposed", boot: "Opened", patch: "Changed", publish: "Published", export: "Exported", update: "Updated", merge: "Merged",
  overview: "Read", describe: "Described", empty: "Emptied", destroy: "Deleted forever",
};
const OP_NOUN: Record<string, string> = {
  source: "files", import: "an import", dataset: "a dataset", collection: "a collection", structure: "a structure", studio: "a Studio",
  labels: "labels", rules: "review rules", project: "the project", trash: "the Trash",
};

/** todo29 D6: an operation's tool row once done, from its id: "source.rename" → "Renamed files". */
export function operationPastLabel(opId: string): string {
  const [noun = "", verb = ""] = opId.split(".");
  const v = PAST_VERB[verb];
  return v ? `${v} ${OP_NOUN[noun] ?? noun}` : `Ran ${opId}`;
}

export function createOperationTools(d: OperationToolDeps): ToolDefinition<any, any, any>[] {
  const tools: StudioToolDefinition[] = OPERATION_TOOLS.map((op) => {
    const name = operationToolName(op.id);
    const schema = z.toJSONSchema(op.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    const tierNote =
      op.tier === "trash" ? " Goes to the Trash; say so and that it can be undone." : op.tier === "destroy" ? " Permanent: the person is always asked first." : "";
    return {
      name,
      label: op.id,
      pastLabel: operationPastLabel(op.id),
      promptSnippet: op.description.slice(0, 200),
      description: `${op.description}${tierNote}`,
      parameters: Type.Unsafe<Record<string, unknown>>(schema),
      async execute(callId: string, params: Record<string, unknown>, signal: AbortSignal | undefined) {
        const parsed = op.input.safeParse(params ?? {});
        if (!parsed.success) throw new Error(`invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
        const req = operationRequest(op, d.projectId, parsed.data as Record<string, unknown>);
        const qs = req.query ? `?${new URLSearchParams(req.query)}` : "";
        const approvalId = d.approvalFor(callId);
        const kernelToken = d.kernelToken();
        // Destroys carry a signed approval the api verifies (person, operation, targets, expiry, once).
        const approval =
          approvalId && op.tier === "destroy" && kernelToken
            ? approvalToken({ approvalId, kernelToken, opId: op.id, projectId: d.projectId, targets: operationTargets(parsed.data as Record<string, unknown>), secret: d.approvalSecret })
            : approvalId;
        let res: unknown;
        try {
          res = await d.kernel.request(req.method, `${req.path}${qs}`, { json: req.body, signal, headers: approval ? { "X-Approval-Id": approval } : undefined });
        } catch (e) {
          if (e instanceof KernelError && e.status === 403) throw new Error(`Refused: ${e.message}`);
          throw e;
        }
        const batchId = batchOf(res);
        if (op.tier === "trash")
          return text({ movedToTrash: true, batchId, result: res, note: "Tell the person it went to the Trash and can be undone (Undo or Open Trash)." }, "Moved to Trash", { card: "trash", batchId, opId: op.id });
        if (op.tier === "destroy") return text({ deletedForever: true, result: res }, "Deleted forever", { opId: op.id });
        return text(res, "Done", { opId: op.id, ...(batchId ? { batchId } : {}) });
      },
    } satisfies StudioToolDefinition;
  });
  tools.push({
    name: "undo_turn",
    label: "Undo these changes",
    pastLabel: "Undid these changes",
    promptSnippet: "Undo everything you changed in the previous turn",
    description: "Undo every change you made in one turn (default: your previous turn that changed something): restores what you trashed and reverses renames, moves and new folders.",
    parameters: Type.Object({ runId: Type.Optional(Type.String()) }),
    async execute(_callId: string, params: { runId?: string }, signal: AbortSignal | undefined) {
      // "latest": the kernel picks this person's newest turn other than the one asking.
      const turn = encodeURIComponent(params.runId ?? "latest");
      let res: { undone?: number };
      try {
        res = await d.kernel.request("POST", `/projects/${encodeURIComponent(d.projectId)}/turns/${turn}/undo`, { json: {}, signal });
      } catch (e) {
        if (e instanceof KernelError && e.status === 404) return text({ undone: 0, note: "Nothing to undo." }, "Nothing to undo");
        if (e instanceof KernelError && e.status === 409) throw new Error(`Can't undo: ${e.message}`);
        throw e;
      }
      const n = res?.undone ?? 0;
      return text(res, `Undid ${n} change${n === 1 ? "" : "s"}`);
    },
  } satisfies StudioToolDefinition);
  return tools;
}
