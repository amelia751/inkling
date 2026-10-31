import type { ReorgOp, ReorgPlan } from "@studio/agent-protocol";
import type { FsConflictError, FsOp, FsOpsRequest, FsOpsResult, FsUndoResult } from "@studio/contracts/types";
import { ApiError, FsConflictApiError, NeedsApiError, postFsOps, postUndo } from "@/studio/lib/files/api";

/** `ReorgDiff`'s shapes (components/files/reorg-diff.tsx), restated so this module stays React-free. */
export type DiffOp =
  | { kind: "mkdir"; id: string; parentId: string; name: string; reason: string }
  | { kind: "move"; nodeIds: string[]; parentId: string; reason: string }
  | { kind: "rename"; nodeId: string; name: string; reason: string };
export interface DiffTreeNode {
  id: string;
  name: string;
  kind: "folder" | "file" | "sequence";
  children?: DiffTreeNode[];
}

/**
 * Reorganization plans (todo7 Phase 8): the assistant's `propose_reorganization` becomes a card;
 * the person approves it and the web sends **one** `fs/ops` batch as them, so one ⌘Z (`fs/undo`)
 * reverts the whole plan. The agent never writes the namespace: its kernel token gets 403 from
 * `fs/ops`. Pure helpers here, plus the two calls the card makes.
 */

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const MAX_OPS = 2000;
const MAX_IDS = 10_000;

/** D10 name rules, as the kernel applies them (it has the last word: 422 with a sentence). */
export function nameProblem(raw: string): string | null {
  const name = raw.replace(/[ .]+$/, "");
  if (!name.trim()) return "A name can't be empty.";
  if (name === "." || name === "..") return `"${name}" isn't a valid name.`;
  if (name.includes("/")) return `"${name}" contains "/".`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return "A name can't contain control characters.";
  if (new TextEncoder().encode(name).length > 255) return "A name can be at most 255 bytes.";
  return null;
}

const cleanName = (raw: unknown) => String(raw ?? "").replace(/[ .]+$/, "");
const reason = (raw: unknown) => String(raw ?? "").trim().slice(0, 200);

function newPlanId(): string {
  const c = globalThis.crypto;
  return `plan-${c?.randomUUID ? c.randomUUID().replace(/-/g, "").slice(0, 16) : Math.random().toString(36).slice(2, 18)}`;
}

/**
 * Validate the model's `propose_reorganization` input into a plan. Refs for new folders are
 * normalised to `new:<handle>` (the model may write either form); every `parentId` must be an id
 * or a ref made by an earlier `mkdir`. Returns a sentence the model can act on when it's wrong.
 */
export function parseReorgPlan(input: Record<string, unknown>, id = newPlanId()): { plan: ReorgPlan } | { error: string } {
  const title = String(input.title ?? "").trim().slice(0, 160);
  if (!title) return { error: "Give the plan a one-line title." };
  const raw = Array.isArray(input.ops) ? (input.ops as Record<string, unknown>[]) : [];
  if (!raw.length) return { error: "The plan has no ops." };
  if (raw.length > MAX_OPS) return { error: `At most ${MAX_OPS} ops per plan; split it.` };
  const refs = new Set<string>();
  const asRef = (v: string) => (v.startsWith("new:") ? v : `new:${v}`);
  const parent = (v: unknown, at: number): string | { error: string } => {
    const s = String(v ?? "");
    if (refs.has(asRef(s))) return asRef(s);
    if (s.startsWith("new:")) return { error: `Op ${at + 1}: ${s} isn't made by an earlier mkdir.` };
    if (!ID_RE.test(s)) return { error: `Op ${at + 1}: parentId must be a folder id from list_folder or find_files (or a mkdir ref), not a path.` };
    return s;
  };
  const id_ = (v: unknown, at: number): string | { error: string } => {
    const s = String(v ?? "");
    return ID_RE.test(s) && !s.startsWith("new:") ? s : { error: `Op ${at + 1}: "${s.slice(0, 60)}" isn't a node id from list_folder or find_files.` };
  };
  const ops: ReorgOp[] = [];
  let ids = 0;
  for (const [at, op] of raw.entries()) {
    const kind = op?.kind;
    if (kind === "mkdir") {
      const handle = String(op.ref ?? "").replace(/^new:/, "");
      if (!REF_RE.test(handle)) return { error: `Op ${at + 1}: mkdir needs a short ref (letters, digits, . _ -), e.g. "p1".` };
      if (refs.has(`new:${handle}`)) return { error: `Op ${at + 1}: ref ${handle} is used twice.` };
      const p = parent(op.parentId, at);
      if (typeof p !== "string") return p;
      const name = cleanName(op.name);
      const bad = nameProblem(name);
      if (bad) return { error: `Op ${at + 1}: ${bad}` };
      refs.add(`new:${handle}`);
      ops.push({ kind: "mkdir", ref: `new:${handle}`, parentId: p, name, reason: reason(op.reason) });
    } else if (kind === "move") {
      const list = Array.isArray(op.nodeIds) ? op.nodeIds : [];
      if (!list.length) return { error: `Op ${at + 1}: move needs nodeIds.` };
      const nodeIds: string[] = [];
      for (const v of list) {
        const n = id_(v, at);
        if (typeof n !== "string") return n;
        if (!nodeIds.includes(n)) nodeIds.push(n);
      }
      ids += nodeIds.length;
      if (ids > MAX_IDS) return { error: `At most ${MAX_IDS} items per plan; split it.` };
      const p = parent(op.parentId, at);
      if (typeof p !== "string") return p;
      if (nodeIds.includes(p)) return { error: `Op ${at + 1}: can't move a folder into itself.` };
      ops.push({ kind: "move", nodeIds, parentId: p, reason: reason(op.reason) });
    } else if (kind === "rename") {
      const n = id_(op.nodeId, at);
      if (typeof n !== "string") return n;
      const name = cleanName(op.name);
      const bad = nameProblem(name);
      if (bad) return { error: `Op ${at + 1}: ${bad}` };
      ops.push({ kind: "rename", nodeId: n, name, reason: reason(op.reason) });
    } else {
      return { error: `Op ${at + 1}: kind must be mkdir, move or rename.` };
    }
  }
  return { plan: { id, title, ops } };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** "2 new folders · 6 items moved · 1 rename". */
export function planSummary(plan: ReorgPlan): string {
  const folders = plan.ops.filter((o) => o.kind === "mkdir").length;
  const moved = plan.ops.reduce((n, o) => n + (o.kind === "move" ? o.nodeIds.length : 0), 0);
  const renames = plan.ops.filter((o) => o.kind === "rename").length;
  return [folders && plural(folders, "new folder"), moved && `${plural(moved, "item")} moved`, renames && plural(renames, "rename")].filter(Boolean).join(" · ");
}

/** Existing node ids the plan touches (to look up their current names for the diff). */
export function planNodeIds(plan: ReorgPlan): string[] {
  const out = new Set<string>();
  for (const o of plan.ops) {
    if (o.kind === "move") o.nodeIds.forEach((id) => out.add(id));
    if (o.kind === "rename") out.add(o.nodeId);
    if ((o.kind === "move" || o.kind === "mkdir") && !o.parentId.startsWith("new:")) out.add(o.parentId);
  }
  return [...out];
}

const newNodeId = () => `nod-${(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^0-9a-f]/gi, "").slice(0, 32)}`;

/**
 * The plan as one `fs/ops` request. `include` (op indexes) is Files' "Edit" with a checkbox per
 * op; an included op whose new folder was left out is an error, said in words. New folders get
 * client-chosen `nod-<uuid>` ids (the contract's `mkdir.id`), so later moves can name them.
 */
export function planToFsOps(plan: ReorgPlan, opts: { include?: ReadonlySet<number>; newId?: () => string } = {}): FsOpsRequest {
  const make = opts.newId ?? newNodeId;
  const real = new Map<string, string>();
  const ops: FsOp[] = [];
  const resolve = (parentId: string, at: number) => {
    if (!parentId.startsWith("new:")) return parentId;
    const id = real.get(parentId);
    if (!id) throw new Error(`Step ${at + 1} needs the new folder it goes into; include that folder too.`);
    return id;
  };
  plan.ops.forEach((o, at) => {
    if (opts.include && !opts.include.has(at)) return;
    if (o.kind === "mkdir") {
      const id = make();
      ops.push({ kind: "mkdir", parentId: resolve(o.parentId, at), name: o.name, id });
      real.set(o.ref, id);
    } else if (o.kind === "move") ops.push({ kind: "move", nodeIds: o.nodeIds, parentId: resolve(o.parentId, at) });
    else ops.push({ kind: "rename", nodeId: o.nodeId, name: o.name });
  });
  if (!ops.length) throw new Error("Nothing selected to apply.");
  return { ops };
}

/** Apply as the signed-in person (the browser's own credentials, never the agent's token), through the Files API. */
export async function applyReorgPlan(projectId: string, plan: ReorgPlan, include?: ReadonlySet<number>): Promise<FsOpsResult> {
  try {
    return await postFsOps(projectId, planToFsOps(plan, { include }));
  } catch (e) {
    throw reorgError(e);
  }
}

/** The Files API's typed error as the card's sentence (409 names the conflicts). */
export function reorgError(e: unknown): Error {
  if (e instanceof FsConflictApiError) return new ApiError(409, applyErrorText(409, { message: e.message, conflicts: e.conflicts }));
  if (e instanceof NeedsApiError) return new ApiError(501, applyErrorText(501, null));
  if (e instanceof ApiError) return new ApiError(e.status, applyErrorText(e.status, (e.body as { detail?: unknown } | undefined)?.detail ?? e.message));
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * The plan as `ReorgDiff` input: the agent protocol's mkdir ops name their folder by
 * `ref: "new:<handle>"`; the diff wants an `id`. The ref is unique within the plan, so it serves
 * as the stable client id (later moves already use it as their `parentId`). Wire types unchanged.
 */
export function planToDiffOps(plan: ReorgPlan): DiffOp[] {
  return plan.ops.map((o): DiffOp => (o.kind === "mkdir" ? { kind: "mkdir", id: o.ref, parentId: o.parentId, name: o.name, reason: o.reason } : o.kind === "move" ? { kind: "move", nodeIds: o.nodeIds, parentId: o.parentId, reason: o.reason } : { kind: "rename", nodeId: o.nodeId, name: o.name, reason: o.reason }));
}

/** What the diff needs to know about an existing node (from its detail). */
export interface DiffNodeInfo {
  id: string;
  name: string;
  kind: "folder" | "file" | "sequence";
  parentId: string | null;
}

/**
 * A snapshot tree for the diff from the nodes the plan touches: each node under its parent when
 * the parent is known, else under a "Files" root. Enough for before/after of what moves.
 */
export function planSnapshot(nodes: DiffNodeInfo[]): DiffTreeNode {
  const root: DiffTreeNode = { id: "__root__", name: "Files", kind: "folder", children: [] };
  const byId = new Map<string, DiffTreeNode>(nodes.map((n) => [n.id, { id: n.id, name: n.name, kind: n.kind, ...(n.kind === "file" ? {} : { children: [] }) }]));
  for (const n of nodes) {
    const me = byId.get(n.id)!;
    const parent = (n.parentId && byId.get(n.parentId)) || root;
    if (parent === me) continue;
    (parent.children ??= []).push(me);
  }
  return root;
}

/** A sentence for the card: 409 names the conflicts (a plan has no conflict dialog; Edit in Files does). */
export function applyErrorText(status: number, detail: unknown): string {
  if (status === 409 && detail && typeof detail === "object" && Array.isArray((detail as FsConflictError).conflicts)) {
    const c = (detail as FsConflictError).conflicts;
    const names = c.slice(0, 3).map((x) => `"${x.name}" in ${x.parentName}`).join(", ");
    return `${c.length === 1 ? "An item named" : "Items named"} ${names}${c.length > 3 ? ` and ${c.length - 3} more` : ""} already ${c.length === 1 ? "exists" : "exist"}. Edit the plan in Files to decide.`;
  }
  if (status === 403) return "You can't change files in this project.";
  if (status === 501) return "Changing files needs the full stack.";
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object" && typeof (detail as { message?: unknown }).message === "string") return (detail as { message: string }).message;
  return `The plan couldn't be applied (${status}).`;
}

/** Undo exactly that batch (the server refuses, 409 with a sentence, when something changed since). */
export const undoReorgBatch = (projectId: string, batchId: string): Promise<FsUndoResult> => postUndo(projectId, batchId).catch((e: unknown) => Promise.reject(reorgError(e)));
