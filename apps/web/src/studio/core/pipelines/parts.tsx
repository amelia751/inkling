import { CloseIcon, DoneIcon, ErrorIcon, QueuedIcon, WarningIcon } from "@studio/ui/icons";
import { Badge } from "@studio/ui/ui/badge";
import { Spinner } from "@studio/ui/ui/spinner";
import { cn } from "@studio/ui/utils";
import type { RunState, StepState } from "./contract";
import { RUN_LABEL, RUN_THEME, STEP_LABEL, type RunCounts } from "./model";

/** The run's state as a label (colour plus a word, never a bare dot). `pipeline-run-status` is a regression contract. */
export function RunStatus({ state, size = "xs" }: { state: RunState; size?: "xs" | "sm" }) {
  return (
    <Badge theme={RUN_THEME[state]} size={size} running={state === "running" || state === "publishing"} data-testid="pipeline-run-status" data-state={state}>
      {RUN_LABEL[state]}
    </Badge>
  );
}

export function StepIcon({ state, className }: { state: StepState; className?: string }) {
  const c = cn("size-4 shrink-0", className);
  if (state === "running") return <Spinner className={c} aria-label={STEP_LABEL[state]} />;
  if (state === "succeeded") return <DoneIcon className={cn(c, "text-positive")} aria-label={STEP_LABEL[state]} />;
  if (state === "failed") return <ErrorIcon className={cn(c, "text-danger")} aria-label={STEP_LABEL[state]} />;
  if (state === "cancelled" || state === "skipped") return <CloseIcon className={cn(c, "text-hint")} aria-label={STEP_LABEL[state]} />;
  return <QueuedIcon className={cn(c, "text-hint")} aria-label={STEP_LABEL[state]} />;
}

/** "10 files · 8 ok · 2 quarantined", with the problems coloured. */
export function Counts({ counts, className }: { counts: RunCounts; className?: string }) {
  return (
    <span className={cn("tnum text-sm text-muted-foreground", className)} data-testid="pipeline-run-counts">
      {counts.total.toLocaleString()} {counts.total === 1 ? "file" : "files"}
      {counts.ok > 0 && <> · {counts.ok.toLocaleString()} ok</>}
      {counts.quarantined > 0 && (
        <span className="text-warning">
          {" · "}
          <WarningIcon className="inline size-3.5 align-[-2px]" aria-hidden /> {counts.quarantined.toLocaleString()} quarantined
        </span>
      )}
      {counts.rejected > 0 && <span className="text-danger"> · {counts.rejected.toLocaleString()} rejected</span>}
    </span>
  );
}

export const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
