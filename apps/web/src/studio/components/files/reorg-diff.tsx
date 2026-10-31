import { useMemo, useState } from "react";
import type { FsOp } from "@studio/contracts/types";
import { ChevronDownIcon, ChevronRightIcon, FileSequenceIcon, FolderIcon, UnknownFileIcon, WarningIcon } from "@studio/ui/icons";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { cn } from "@studio/ui/utils";
import { plural, ReasonButton } from "./shared";

/**
 * The assistant's reorganization plan (todo7 Phase 8), as the body of its approval card: a
 * before / after tree of the folders the plan touches, with moved rows dashed, new folders
 * marked and file counts per folder, then the steps with their one-line reasons, then Apply /
 * Edit / Dismiss. Apply sends one `fs/ops` batch as the user; that's the caller's job.
 *
 * `applyPlanToTree(tree, ops)` is the pure part: it plays the ops on a snapshot of the folder
 * and returns both annotated trees plus the ops it couldn't play (and why).
 */

/** A snapshot of the folder the plan works on (what `list_folder` saw), files included. */
export interface ReorgTreeNode {
  id: string;
  name: string;
  kind: "folder" | "file" | "sequence";
  children?: ReorgTreeNode[];
  /** Numbered runs: how many files the row stands for. */
  count?: number;
}

type WithReason<T> = T & { /** One line, shown next to the step ("Group by patient"). */ reason: string };
/** One step of a plan: the `fs/ops` shapes for mkdir (with its client id, so later moves can name it), move and rename. */
export type ReorgOp =
  | WithReason<Extract<FsOp, { kind: "mkdir" }> & { id: string }>
  | WithReason<Extract<FsOp, { kind: "move" }>>
  | WithReason<Extract<FsOp, { kind: "rename" }>>;

export interface DiffNode extends ReorgTreeNode {
  children?: DiffNode[];
  /** After: a folder the plan creates. */
  isNew?: boolean;
  /** After: the node is somewhere else now. Before: the node will leave this place. */
  moved?: boolean;
  /** After: the name it had. */
  previousName?: string;
  /** Before: the name it will get. */
  nextName?: string;
}

export interface PlanResult {
  before: DiffNode;
  after: DiffNode;
  /** One sentence per op (or part of one) that couldn't be played; the rest still were. */
  errors: string[];
  stats: { newFolders: number; moved: number; renamed: number };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const byKindThenName = (a: ReorgTreeNode, b: ReorgTreeNode) => Number(a.kind !== "folder") - Number(b.kind !== "folder") || collator.compare(a.name, b.name);

/** Files under a node: a file is 1, a numbered run its `count`, a folder the sum below. */
export function fileCount(n: ReorgTreeNode): number {
  if (n.kind === "file") return 1;
  if (n.kind === "sequence") return n.count ?? n.children?.length ?? 0;
  return (n.children ?? []).reduce((s, c) => s + fileCount(c), 0);
}

function clone(n: ReorgTreeNode): DiffNode {
  return { ...n, children: n.children?.map(clone) };
}

/** Plays `ops` on `tree` (never mutated). Invalid parts are skipped and reported. */
export function applyPlanToTree(tree: ReorgTreeNode, ops: ReorgOp[]): PlanResult {
  const after = clone(tree);
  const byId = new Map<string, DiffNode>();
  const parentOf = new Map<string, DiffNode>();
  const index = (n: DiffNode, parent?: DiffNode) => {
    byId.set(n.id, n);
    if (parent) parentOf.set(n.id, parent);
    n.children?.forEach((c) => index(c, n));
  };
  index(after);
  const originalName = new Map<string, string>();
  const originalParent = new Map<string, string | undefined>();
  byId.forEach((n, id) => {
    originalName.set(id, n.name);
    originalParent.set(id, parentOf.get(id)?.id);
  });

  const errors: string[] = [];
  const isInside = (id: string, ancestorId: string): boolean => {
    for (let p: DiffNode | undefined = byId.get(id); p; p = parentOf.get(p.id)) if (p.id === ancestorId) return true;
    return false;
  };
  const folder = (id: string, step: number): DiffNode | null => {
    const f = byId.get(id);
    if (!f) errors.push(`Step ${step}: the destination folder isn't there.`);
    else if (f.kind !== "folder") errors.push(`Step ${step}: “${f.name}” isn't a folder.`);
    else return f;
    return null;
  };

  ops.forEach((op, i) => {
    const step = i + 1;
    if (op.kind === "mkdir") {
      const parent = folder(op.parentId, step);
      if (!parent) return;
      if (byId.has(op.id)) return void errors.push(`Step ${step}: “${op.name}” is already in the plan.`);
      const n: DiffNode = { id: op.id, name: op.name, kind: "folder", children: [], isNew: true };
      (parent.children ??= []).push(n);
      byId.set(n.id, n);
      parentOf.set(n.id, parent);
    } else if (op.kind === "move") {
      const target = folder(op.parentId, step);
      if (!target) return;
      for (const id of op.nodeIds) {
        const n = byId.get(id);
        const from = parentOf.get(id);
        if (!n) errors.push(`Step ${step}: an item to move isn't there.`);
        else if (!from) errors.push(`Step ${step}: the top folder can't be moved.`);
        else if (isInside(target.id, id)) errors.push(`Step ${step}: can't move “${n.name}” into itself.`);
        else {
          from.children = from.children!.filter((c) => c.id !== id);
          (target.children ??= []).push(n);
          parentOf.set(id, target);
          n.moved = !n.isNew && originalParent.get(id) !== target.id;
        }
      }
    } else {
      const n = byId.get(op.nodeId);
      if (!n) return void errors.push(`Step ${step}: the item to rename isn't there.`);
      const was = originalName.get(n.id);
      n.name = op.name;
      n.previousName = !n.isNew && was !== undefined && was !== op.name ? was : undefined;
    }
  });

  const sortDeep = (n: DiffNode) => {
    n.children?.sort(byKindThenName);
    n.children?.forEach(sortDeep);
  };
  sortDeep(after);

  // The before tree, marked with what will happen to each row.
  let moved = 0;
  let renamed = 0;
  let newFolders = 0;
  byId.forEach((n) => {
    if (n.isNew) newFolders++;
    if (n.moved) moved++;
    if (n.previousName !== undefined) renamed++;
  });
  const mark = (n: ReorgTreeNode): DiffNode => {
    const a = byId.get(n.id);
    return {
      ...n,
      children: n.children?.map(mark),
      moved: a?.moved || undefined,
      nextName: a?.previousName !== undefined ? a.name : undefined,
    };
  };
  const before = mark(tree);
  sortDeep(before);
  return { before, after, errors, stats: { newFolders, moved, renamed } };
}

const changed = (n: DiffNode) => !!(n.isNew || n.moved || n.previousName !== undefined || n.nextName !== undefined);

/** Rows to draw: changed nodes, their ancestors, everything in a new folder; the rest as "N unchanged". */
interface Row {
  n: DiffNode;
  depth: number;
  hidden?: number;
}
function rowsOf(root: DiffNode): Row[] {
  const out: Row[] = [];
  const shows = new Map<string, boolean>();
  const visit = (n: DiffNode, inNew: boolean): boolean => {
    let any = changed(n) || inNew;
    for (const c of n.children ?? []) any = visit(c, inNew || !!n.isNew) || any;
    shows.set(n.id, any);
    return any;
  };
  visit(root, false);
  const walk = (n: DiffNode, depth: number) => {
    out.push({ n, depth });
    const kids = n.children ?? [];
    const shown = kids.filter((c) => shows.get(c.id));
    shown.forEach((c) => walk(c, depth + 1));
    const hidden = kids.length - shown.length;
    if (hidden > 0) out.push({ n, depth: depth + 1, hidden });
  };
  walk(root, 0);
  return out;
}

const MAX_ROWS = 300;

export interface ReorgDiffProps {
  /** The current snapshot of the folder the plan works on. */
  tree: ReorgTreeNode;
  ops: ReorgOp[];
  /** The plan's headline, e.g. "Group by patient: 47 folders → patient_001…047". */
  summary?: string;
  onApply: () => void;
  /** Opens the plan in Files with every op as a checkbox. */
  onEdit?: () => void;
  onDismiss: () => void;
  applying?: boolean;
  /** Set: Apply is inert with this reason (e.g. "Needs the full stack", or the plan has errors). */
  applyDisabledReason?: string | null;
}

export function ReorgDiff({ tree, ops, summary, onApply, onEdit, onDismiss, applying, applyDisabledReason }: ReorgDiffProps) {
  const plan = useMemo(() => applyPlanToTree(tree, ops), [tree, ops]);
  const [stepsOpen, setStepsOpen] = useState(false);
  const { stats } = plan;
  const counts = [stats.newFolders && plural(stats.newFolders, "new folder"), stats.moved && plural(stats.moved, "move"), stats.renamed && plural(stats.renamed, "rename")].filter(Boolean).join(" · ");
  return (
    <div className="flex min-w-0 flex-col gap-3 text-sm" data-testid="reorg-diff">
      {(summary || counts) && (
        <div className="min-w-0">
          {summary && <p className="font-semibold">{summary}</p>}
          {counts && <p className="text-xs text-muted-foreground" data-testid="reorg-counts">{counts}</p>}
        </div>
      )}
      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        <TreePane title="Before" root={plan.before} side="before" />
        <TreePane title="After" root={plan.after} side="after" />
      </div>
      {plan.errors.length > 0 && (
        <ul className="space-y-0.5 rounded-md bg-warning-tint px-3 py-2 text-xs" data-testid="reorg-errors">
          {plan.errors.map((e, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <WarningIcon className="mt-0.5 size-3 shrink-0 text-warning" aria-hidden />
              {e}
            </li>
          ))}
        </ul>
      )}
      <div>
        <button type="button" className="flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground" aria-expanded={stepsOpen} onClick={() => setStepsOpen((o) => !o)} data-testid="reorg-steps-toggle">
          {stepsOpen ? <ChevronDownIcon className="size-3" aria-hidden /> : <ChevronRightIcon className="size-3" aria-hidden />}
          {plural(ops.length, "step")}
        </button>
        {stepsOpen && (
          <ol className="mt-1 space-y-1 pl-4 text-xs" data-testid="reorg-steps">
            {ops.map((op, i) => (
              <li key={i} className="list-decimal">
                <span>{describeOp(op, tree, ops)}</span>
                {op.reason && <span className="text-muted-foreground"> · {op.reason}</span>}
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost-secondary" onClick={onDismiss} data-testid="reorg-dismiss">Dismiss</Button>
        {onEdit && <Button variant="outline" onClick={onEdit} data-testid="reorg-edit">Edit</Button>}
        <ReasonButton reason={applyDisabledReason} loading={applying} onClick={onApply} data-testid="reorg-apply">Apply</ReasonButton>
      </div>
    </div>
  );
}

function describeOp(op: ReorgOp, tree: ReorgTreeNode, ops: ReorgOp[]): string {
  const names = new Map<string, string>();
  const walk = (n: ReorgTreeNode) => {
    names.set(n.id, n.name);
    n.children?.forEach(walk);
  };
  walk(tree);
  for (const o of ops) if (o.kind === "mkdir") names.set(o.id, o.name);
  const name = (id: string) => names.get(id) ?? "an item";
  if (op.kind === "mkdir") return `New folder “${op.name}” in ${name(op.parentId)}`;
  if (op.kind === "rename") return `Rename “${name(op.nodeId)}” to “${op.name}”`;
  return `Move ${op.nodeIds.length === 1 ? `“${name(op.nodeIds[0])}”` : plural(op.nodeIds.length, "item")} to ${name(op.parentId)}`;
}

function TreePane({ title, root, side }: { title: string; root: DiffNode; side: "before" | "after" }) {
  const rows = useMemo(() => rowsOf(root), [root]);
  const shown = rows.slice(0, MAX_ROWS);
  return (
    <section className="min-w-0 rounded-md border border-border" aria-label={title} data-testid={`reorg-${side}`}>
      <h4 className="border-b border-border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-hint">{title}</h4>
      <ul className="thin-scrollbar max-h-72 overflow-y-auto p-1">
        {shown.map((r, i) =>
          r.hidden ? (
            <li key={`h${r.n.id}${i}`} className="flex h-6 items-center text-xs text-hint" style={{ paddingLeft: 8 + r.depth * 14 }}>
              {plural(r.hidden, "other item")}
            </li>
          ) : (
            <DiffRow key={r.n.id} n={r.n} depth={r.depth} side={side} />
          ),
        )}
        {rows.length > MAX_ROWS && <li className="px-2 py-1 text-xs text-hint">and {plural(rows.length - MAX_ROWS, "more row")}</li>}
      </ul>
    </section>
  );
}

function DiffRow({ n, depth, side }: { n: DiffNode; depth: number; side: "before" | "after" }) {
  const Icon = n.kind === "folder" ? FolderIcon : n.kind === "sequence" ? FileSequenceIcon : UnknownFileIcon;
  const count = n.kind === "folder" ? fileCount(n) : n.kind === "sequence" ? fileCount(n) : null;
  return (
    <li
      className={cn(
        "flex h-6 min-w-0 items-center gap-1.5 rounded-sm border border-transparent pr-2 text-xs",
        n.moved && "border-dashed border-border-hover",
        n.moved && side === "before" && "text-muted-foreground",
      )}
      style={{ paddingLeft: 4 + depth * 14 }}
      data-testid="reorg-row"
      data-node-id={n.id}
      data-change={n.isNew ? "new" : n.moved ? "moved" : n.previousName !== undefined || n.nextName !== undefined ? "renamed" : undefined}
    >
      <Icon className={cn("size-3.5 shrink-0", n.isNew ? "text-brand" : "text-hint")} aria-hidden />
      <span className="min-w-0 truncate" title={n.name}>
        {side === "after" && n.previousName !== undefined ? (
          <>
            <span className="text-hint line-through">{n.previousName}</span> → {n.name}
          </>
        ) : side === "before" && n.nextName !== undefined ? (
          <>
            {n.name} <span className="text-hint">→ {n.nextName}</span>
          </>
        ) : (
          n.name
        )}
      </span>
      {n.isNew && (
        <Badge theme="info" className="shrink-0">
          New
        </Badge>
      )}
      {n.moved && <span className="sr-only">{side === "before" ? "(moves)" : "(moved here)"}</span>}
      {count !== null && <span className="tnum ml-auto shrink-0 text-hint">{count.toLocaleString()}</span>}
    </li>
  );
}
