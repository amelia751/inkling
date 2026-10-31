import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import type { ReorgPlan } from "@studio/agent-protocol";
import type { FsOp, FsOpsResult } from "@studio/contracts/types";
import { FolderIcon } from "@studio/ui/icons";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { Checkbox } from "@studio/ui/ui/checkbox";
import { NEEDS_FULL_STACK, ReasonButton } from "@/studio/components/files";
import { planNodeIds, planSummary, planToFsOps } from "@/studio/lib/agent/reorg";
import { fetchNode, projectKeys } from "@/studio/lib/projects-api";
import type { RunOptions } from "./ops";

/**
 * An assistant's reorganization plan opened in Files (todo7 Phase 8 "Edit", `?plan=<id>`): every
 * op is a checkbox; **Apply selected** sends the checked ops as one `fs/ops` batch through the
 * page's `run` (so a name conflict opens the conflict dialog, and Undo undoes the whole batch).
 * Leaving out a new folder that a checked move needs is said in words, not sent.
 */
export function PlanPanel({ plan, writable, run, onClose }: { plan: ReorgPlan; writable: boolean; run: (ops: FsOp[], opts?: RunOptions) => Promise<FsOpsResult | undefined>; onClose: () => void }) {
  const [include, setInclude] = useState<Set<number>>(() => new Set(plan.ops.map((_, i) => i)));
  const [busy, setBusy] = useState(false);
  const ids = useMemo(() => planNodeIds(plan).slice(0, 60), [plan]);
  const lookups = useQueries({ queries: ids.map((id) => ({ queryKey: projectKeys.node(id), queryFn: () => fetchNode(id), staleTime: 30_000, retry: false })) });
  const names = new Map(ids.map((id, i) => [id, lookups[i]?.data?.name] as const));
  const newName = new Map(plan.ops.flatMap((o) => (o.kind === "mkdir" ? [[o.ref, o.name] as const] : [])));
  const where = (id: string) => newName.get(id) ?? names.get(id) ?? "a folder";
  let problem: string | null = null;
  try {
    planToFsOps(plan, { include, newId: () => "x" });
  } catch (e) {
    problem = e instanceof Error ? e.message : String(e);
  }
  const apply = async () => {
    setBusy(true);
    try {
      const res = await run(planToFsOps(plan, { include }).ops, { fallback: plan.title });
      if (res) onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="shrink-0 border-b border-border bg-generic px-4 py-3 text-sm" aria-label="Reorganization plan" data-testid="files-plan">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <FolderIcon className="size-4 text-hint" aria-hidden />
        <h2 className="min-w-0 flex-1 truncate font-semibold">{plan.title}</h2>
        <span className="text-xs text-muted-foreground">{planSummary(plan)}</span>
      </div>
      <ul className="thin-scrollbar max-h-48 space-y-1 overflow-y-auto">
        {plan.ops.map((o, i) => (
          <li key={i} className="flex items-start gap-2" data-testid="files-plan-op" data-kind={o.kind}>
            <Checkbox
              checked={include.has(i)}
              onCheckedChange={(v) =>
                setInclude((s) => {
                  const n = new Set(s);
                  if (v === true) n.add(i);
                  else n.delete(i);
                  return n;
                })
              }
              aria-label={`Include step ${i + 1}`}
              className="mt-0.5"
            />
            <div className="min-w-0">
              <span className="break-words">
                {o.kind === "mkdir" && (
                  <>
                    <Badge theme="info">New</Badge> <b>{o.name}</b> in {where(o.parentId)}
                  </>
                )}
                {o.kind === "move" && (
                  <>
                    {o.nodeIds.length <= 3 ? o.nodeIds.map((id) => names.get(id) ?? "…").join(", ") : `${o.nodeIds.length} items`} → <b>{where(o.parentId)}</b>
                  </>
                )}
                {o.kind === "rename" && (
                  <>
                    {names.get(o.nodeId) ?? "…"} → <b>{o.name}</b>
                  </>
                )}
              </span>
              {o.reason && <span className="text-muted-foreground"> · {o.reason}</span>}
            </div>
          </li>
        ))}
      </ul>
      {problem && include.size > 0 && (
        <p className="mt-2 text-danger" role="alert" data-testid="files-plan-problem">
          {problem}
        </p>
      )}
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        <Button variant="ghost-secondary" size="sm" onClick={onClose} data-testid="files-plan-discard">
          Discard
        </Button>
        <ReasonButton size="sm" loading={busy} reason={!writable ? NEEDS_FULL_STACK : problem} onClick={() => void apply()} data-testid="files-plan-apply">
          Apply {include.size === plan.ops.length ? "all" : `${include.size} of ${plan.ops.length}`}
        </ReasonButton>
      </div>
    </section>
  );
}
