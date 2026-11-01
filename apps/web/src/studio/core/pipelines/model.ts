import type { ItemReport, ItemState, PipelineEventPayload, PipelineEventType, PipelineRun, PipelineRunSummary, RunState, StepExecution, StepState } from "./contract";

/**
 * Pure view logic for pipeline runs: plain-language labels (docs/ux.md §10: no engine words),
 * badge themes, counts and how an SSE event moves a cached run before the refetch lands.
 */

export type Theme = "normal" | "info" | "success" | "warning" | "danger" | "unknown";

export const RUN_LABEL: Record<RunState, string> = {
  queued: "Queued",
  running: "Running",
  awaiting_review: "Needs review",
  publishing: "Publishing",
  published: "Published",
  rejected: "Rejected",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const RUN_THEME: Record<RunState, Theme> = {
  queued: "unknown",
  running: "info",
  awaiting_review: "warning",
  publishing: "info",
  published: "success",
  rejected: "danger",
  failed: "danger",
  cancelled: "unknown",
};

export const STEP_LABEL: Record<StepState, string> = {
  pending: "Waiting",
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
};

export const ITEM_LABEL: Record<ItemState, string> = {
  discovered: "Found",
  staged: "Staged",
  validated: "Checked",
  quarantined: "Quarantined",
  processed: "Processed",
  proposed: "In candidate",
  rejected: "Rejected",
};

export const ITEM_THEME: Record<ItemState, Theme> = {
  discovered: "unknown",
  staged: "unknown",
  validated: "info",
  quarantined: "warning",
  processed: "info",
  proposed: "success",
  rejected: "danger",
};

const TERMINAL: ReadonlySet<RunState> = new Set(["published", "rejected", "failed", "cancelled"]);
/** Moving on its own (not waiting for a person, not finished). */
export const isLive = (s: RunState) => s === "queued" || s === "running" || s === "publishing";
export const isTerminal = (s: RunState) => TERMINAL.has(s);

/** Show the approve button: the run waits for review, has a candidate, and the server says this person may approve it. */
export function canApprove(run: PipelineRun | undefined): boolean {
  return !!run && run.state === "awaiting_review" && !!run.candidate?.output_manifest_digest && !!run.review?.can_approve;
}

export interface RunCounts {
  total: number;
  /** In the candidate or on the way there. */
  ok: number;
  quarantined: number;
  rejected: number;
  pending: number;
}

/** Counts for a run row: from `item_counts`, or the items of a detail response. */
export function runCounts(run: PipelineRunSummary & { items?: ItemReport[] }): RunCounts {
  const c: Partial<Record<ItemState, number>> = run.item_counts ?? {};
  const by = run.items && !run.item_counts ? countItems(run.items) : c;
  const n = (s: ItemState) => by[s] ?? 0;
  const ok = n("validated") + n("processed") + n("proposed");
  const pending = n("discovered") + n("staged");
  const sum = ok + pending + n("quarantined") + n("rejected");
  return { total: run.item_total ?? sum, ok, quarantined: n("quarantined"), rejected: n("rejected"), pending };
}

export function countItems(items: ItemReport[]): Partial<Record<ItemState, number>> {
  const out: Partial<Record<ItemState, number>> = {};
  for (const i of items) out[i.state] = (out[i.state] ?? 0) + 1;
  return out;
}

export type ItemFilter = "all" | "problems" | "ok";
export const isProblem = (i: ItemReport) => i.state === "quarantined" || i.state === "rejected";

/** The per-file report: problems first (quarantined, then rejected), then by path, so nothing that needs a look is below the fold. */
export function reportRows(items: ItemReport[], filter: ItemFilter = "all"): ItemReport[] {
  const rank = (i: ItemReport) => (i.state === "quarantined" ? 0 : i.state === "rejected" ? 1 : 2);
  return items
    .filter((i) => filter === "all" || (filter === "problems" ? isProblem(i) : !isProblem(i)))
    .slice()
    .sort((a, b) => rank(a) - rank(b) || a.rel_path.localeCompare(b.rel_path, undefined, { numeric: true }));
}

/** "4s", "2m 05s", "1h 12m"; "—" before it starts. Running runs count to `now`. */
export function duration(start?: string | null, end?: string | null, now = Date.now()): string {
  if (!start) return "—";
  const a = Date.parse(start);
  const b = end ? Date.parse(end) : now;
  if (Number.isNaN(a) || Number.isNaN(b)) return "—";
  const s = Math.max(0, Math.round((b - a) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export const shortDigest = (d?: string | null) => (d ? d.replace(/^sha256:/, "").slice(0, 10) : "—");

/** "Upload", "Manual run"… for the run's trigger. */
export function triggerLabel(run: PipelineRunSummary): string {
  switch (run.trigger?.kind) {
    case "upload":
      return "Upload";
    case "connector":
      return "Bucket sync";
    case "schedule":
      return "Scheduled";
    case "backfill":
      return "Backfill";
    case "manual":
      return "Manual run";
    default:
      return "Run";
  }
}

export const definitionName = (run: PipelineRunSummary) => run.definition_name || run.definition_id;

/** Step label, falling back to a readable id ("derive_thumbs" → "Derive thumbs"). */
export function stepName(s: StepExecution): string {
  if (s.label) return s.label;
  const w = s.step_id.replace(/[_-]+/g, " ").trim();
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/**
 * What an event says about a run before the refetch confirms it. Returns the patched run,
 * or the same object when the event doesn't change anything we show. Never moves a finished
 * run backwards (events are at-least-once and may arrive out of order, P§15).
 */
export function applyEvent<T extends PipelineRunSummary & { steps?: StepExecution[] }>(run: T, type: PipelineEventType, p: PipelineEventPayload): T {
  if (!p.run_id || p.run_id !== run.run_id) return run;
  const next = nextState(run.state, type, p);
  let out: T = run;
  if (next && RANK[next] > RANK[run.state]) out = { ...out, state: next };
  if (type.startsWith("pipeline.step.") && p.step_id && run.steps) {
    const stepState: StepState = p.step_state ?? (type === "pipeline.step.started" ? "running" : type === "pipeline.step.completed" ? "succeeded" : "failed");
    const steps = run.steps.map((s) => (s.step_id === p.step_id && s.state !== stepState ? { ...s, state: stepState, attempts: p.attempt ?? s.attempts } : s));
    if (steps.some((s, i) => s !== run.steps![i])) out = { ...out, steps };
  }
  return out;
}

/** Lifecycle order: an event only moves a run forward; every finished state ranks last. */
const RANK: Record<RunState, number> = { queued: 0, running: 1, awaiting_review: 2, publishing: 3, published: 4, rejected: 4, failed: 4, cancelled: 4 };

function nextState(cur: RunState, type: PipelineEventType, p: PipelineEventPayload): RunState | null {
  if (p.state) return p.state;
  switch (type) {
    case "pipeline.run.started":
    case "pipeline.step.started":
      return cur === "queued" ? "running" : null;
    case "pipeline.run.failed":
      return "failed";
    case "review.requested":
      return "awaiting_review";
    case "review.approved":
      return cur === "awaiting_review" ? "publishing" : null;
    default:
      return null;
  }
}
