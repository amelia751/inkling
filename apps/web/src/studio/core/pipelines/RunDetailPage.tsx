import { useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeftIcon, BranchIcon, CheckIcon, ErrorIcon, WarningIcon } from "@studio/ui/icons";
import { Alert } from "@studio/ui/ui/alert";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { EmptyState } from "@studio/ui/ui/empty-state";
import { SegmentedControl } from "@studio/ui/ui/segmented-control";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { cn } from "@studio/ui/utils";
import { AppLayout, PageHeading } from "@/studio/components/layout/app-layout";
import { ErrorView } from "@/studio/app/routes/errors";
import { notify } from "@/studio/lib/files/announce";
import { formatBytes } from "@/studio/lib/format";
import { ApiError } from "@/studio/lib/projects-api";
import { datasetUrl, filesUrl, pipelinesUrl, versionReviewUrl } from "@/studio/lib/routes";
import type { ItemReport, PipelineRun, StepExecution } from "./contract";
import { useApproveRun, usePipelineRun } from "./api";
import { usePipelineEvents } from "./events";
import { canApprove, definitionName, duration, ITEM_LABEL, ITEM_THEME, reportRows, runCounts, shortDigest, stepName, triggerLabel, type ItemFilter } from "./model";
import { Counts, RunStatus, StepIcon, when } from "./parts";

/**
 * One pipeline run: its state, the steps, the candidate version and, for a reviewer, Approve
 * (bound to the candidate's digest, docs/pipeline.md §13), then the per-file report with
 * quarantined files first. Live from the project stream.
 */
export function PipelineRunPage() {
  const { projectId = "", runId = "" } = useParams();
  usePipelineEvents(projectId);
  const q = usePipelineRun(runId);
  const run = q.data;
  return (
    <AppLayout>
      <div className="mx-auto w-full max-w-5xl px-4 py-5 md:px-6 md:py-6" data-testid="pipeline-run-page" data-run-id={runId} data-state={run?.state}>
        {q.isLoading && <Skeleton className="h-48 rounded-lg" />}
        {q.error && <ErrorView error={q.error} what="run" onRetry={() => void q.refetch()} />}
        {run && <RunBody projectId={projectId} run={run} />}
      </div>
    </AppLayout>
  );
}

function RunBody({ projectId, run }: { projectId: string; run: PipelineRun }) {
  const approve = useApproveRun(run);
  const [approveError, setApproveError] = useState<string | null>(null);
  const counts = runCounts(run);
  const quarantined = run.items.filter((i) => i.state === "quarantined");
  const mayApprove = canApprove(run);
  const onApprove = () =>
    approve.mutate(undefined, {
      onSuccess: () => {
        setApproveError(null);
        notify("Approved. Publishing the new version", { tone: "success", group: "pipelines" });
      },
      onError: (e) => setApproveError(approveMessage(e)),
    });
  return (
    <>
      <PageHeading
        title={`${triggerLabel(run)} · ${when(run.created_at)}`}
        description={
          <span>
            {definitionName(run)}
            {run.definition_revision && <span className="font-mono text-xs"> · {shortDigest(run.definition_revision)}</span>}
            {run.trigger?.actor && <> · by {run.trigger.actor.split(":").at(-1)}</>}
          </span>
        }
        actions={
          <>
            <Button variant="outline" size="lg" asChild>
              <Link to={pipelinesUrl(projectId)}>
                <ArrowLeftIcon /> All runs
              </Link>
            </Button>
            {mayApprove && (
              <Button size="lg" disabled={approve.isPending} onClick={onApprove} data-testid="pipeline-approve">
                <CheckIcon /> Approve and publish
              </Button>
            )}
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
        <RunStatus state={run.state} size="sm" />
        <span className="text-sm text-muted-foreground">
          <Counts counts={counts} />
          <span className="tnum"> · {duration(run.started_at, run.finished_at)}</span>
        </span>
      </div>

      {approveError && <Alert theme="danger" className="mb-3" data-testid="pipeline-approve-error">{approveError}</Alert>}
      {run.error && (
        <Alert theme="danger" className="mb-3" title="The run didn't finish" data-testid="pipeline-run-error">
          {run.error.message}
          {run.error.retryable && " Files that were checked are kept; the run can be retried."}
        </Alert>
      )}
      {run.state === "awaiting_review" && (
        <Alert theme={mayApprove ? "warning" : "info"} className="mb-4" title={mayApprove ? "Review required" : "Waiting for a reviewer"} data-testid="pipeline-review-note">
          {counts.ok.toLocaleString()} {counts.ok === 1 ? "file goes" : "files go"} into the new version
          {counts.quarantined + counts.rejected > 0 && `; ${(counts.quarantined + counts.rejected).toLocaleString()} ${counts.quarantined + counts.rejected === 1 ? "stays" : "stay"} out and ${counts.quarantined + counts.rejected === 1 ? "is" : "are"} listed below`}.
          {!mayApprove && " A reviewer who didn't start this run approves it before it's published."}
        </Alert>
      )}

      {run.candidate && <CandidateCard projectId={projectId} run={run} />}

      <h2 className="mb-2 text-body-2 font-semibold">Steps</h2>
      <Card className="mb-6 divide-y divide-border overflow-hidden" data-testid="pipeline-steps">
        {run.steps.map((s) => (
          <StepRow key={s.step_id} step={s} />
        ))}
        {run.steps.length === 0 && <p className="px-4 py-3 text-sm text-muted-foreground">Steps appear when the run starts.</p>}
      </Card>

      {quarantined.length > 0 && (
        <>
          <h2 className="mb-1 flex items-center gap-2 text-body-2 font-semibold">
            <WarningIcon className="size-4 text-warning" /> Quarantined
          </h2>
          <p className="mb-2 text-sm text-muted-foreground">Kept as uploaded and left out of the new version. Fix or replace them, then run again.</p>
          <Card className="mb-6 divide-y divide-border overflow-hidden" data-testid="pipeline-quarantined">
            {quarantined.map((i) => (
              <FileRow key={i.item_id} projectId={projectId} item={i} testid="pipeline-quarantined-row" />
            ))}
          </Card>
        </>
      )}

      <FileReport projectId={projectId} run={run} />
    </>
  );
}

function approveMessage(e: unknown): string {
  if (e instanceof ApiError && e.status === 409) return "The candidate changed after you opened it. Reload the page and review the new one.";
  if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return "You can't approve this run. Someone else must review it.";
  return `Couldn't approve: ${e instanceof Error ? e.message : String(e)}`;
}

function CandidateCard({ projectId, run }: { projectId: string; run: PipelineRun }) {
  const c = run.candidate!;
  const to = run.review ? versionReviewUrl(projectId, c.dataset_id, run.review.review_id) : datasetUrl(projectId, c.dataset_id, "versions");
  return (
    <>
      <h2 className="mb-2 text-body-2 font-semibold">Candidate version</h2>
      <Card className="mb-6 flex flex-wrap items-center gap-3 px-4 py-3 text-sm" data-testid="pipeline-candidate">
        <BranchIcon className="size-4 shrink-0 text-hint" />
        <div className="min-w-0 flex-1">
          <Link to={to} className="font-medium text-brand hover:underline" data-testid="pipeline-candidate-link">
            {run.review ? "Open the review" : "Open versions"} · <code className="font-mono text-xs">{c.commit.slice(0, 10)}</code>
          </Link>
          <p className="truncate text-xs text-muted-foreground">
            <code className="font-mono">{c.branch}</code> · content {shortDigest(c.output_manifest_digest)}
            {c.item_count != null && <> · {c.item_count.toLocaleString()} items</>}
          </p>
        </div>
        {run.review && (
          <Badge theme={run.review.status === "MERGED" ? "success" : "unknown"} data-testid="pipeline-review-status">
            {run.review.approved_by ? `Approved by ${run.review.approved_by.split(":").at(-1)}` : run.review.status.toLowerCase()}
          </Badge>
        )}
      </Card>
    </>
  );
}

function StepRow({ step: s }: { step: StepExecution }) {
  return (
    <div className="px-4 py-2.5" data-testid="pipeline-step-row" data-step-id={s.step_id} data-state={s.state}>
      <div className="flex items-center gap-3 text-sm">
        <StepIcon state={s.state} />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{stepName(s)}</span>
          {s.plugin && <span className="font-mono text-xs text-muted-foreground"> · {s.plugin}</span>}
        </span>
        {(s.attempts ?? 0) > 1 && (
          <span className="shrink-0 text-xs text-warning">
            attempt {s.attempts}
            {s.max_attempts ? ` of ${s.max_attempts}` : ""}
          </span>
        )}
        {s.items_in != null && (
          <span className="tnum hidden shrink-0 text-xs text-muted-foreground sm:inline">
            {s.items_in.toLocaleString()} in{s.items_out != null && ` · ${s.items_out.toLocaleString()} out`}
          </span>
        )}
        <span className="tnum w-16 shrink-0 text-right text-xs text-muted-foreground">{s.state === "pending" ? "" : duration(s.started_at, s.finished_at)}</span>
      </div>
      {s.error && <p className="ml-7 mt-0.5 text-sm text-danger">{s.error.message}</p>}
    </div>
  );
}

function FileReport({ projectId, run }: { projectId: string; run: PipelineRun }) {
  const [filter, setFilter] = useState<ItemFilter>("all");
  const rows = reportRows(run.items, filter);
  const problems = run.items.filter((i) => i.state === "quarantined" || i.state === "rejected").length;
  return (
    <section aria-labelledby="pipeline-files-heading" data-testid="pipeline-file-report">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <h2 id="pipeline-files-heading" className="text-body-2 font-semibold">Files</h2>
        {run.items.length > 0 && (
          <SegmentedControl
            aria-label="Show files"
            value={filter}
            onValueChange={setFilter}
            options={[
              { value: "all", label: `All ${run.items.length}` },
              { value: "problems", label: `Problems ${problems}` },
              { value: "ok", label: `OK ${run.items.length - problems}` },
            ]}
          />
        )}
      </div>
      {run.items.length === 0 ? (
        <EmptyState size="m" art="files" title="No files yet" description="Files appear here as the run finds them." />
      ) : (
        <Card className="divide-y divide-border overflow-hidden">
          {rows.map((i) => (
            <FileRow key={i.item_id} projectId={projectId} item={i} testid="pipeline-file-row" />
          ))}
          {rows.length === 0 && <p className="px-4 py-3 text-sm text-muted-foreground">No files in this view.</p>}
        </Card>
      )}
      {run.items_truncated && <p className="mt-2 text-sm text-muted-foreground">Showing the first {run.items.length.toLocaleString()} files, problems first.</p>}
    </section>
  );
}

function FileRow({ projectId, item: i, testid }: { projectId: string; item: ItemReport; testid: string }) {
  const bad = i.state === "quarantined" || i.state === "rejected";
  const why = i.reason ?? i.diagnostics?.find((d) => d.severity === "error")?.message;
  return (
    <div className="flex items-start gap-3 px-4 py-2 text-sm" data-testid={testid} data-item-id={i.item_id} data-state={i.state}>
      {bad ? <ErrorIcon className={cn("mt-0.5 size-3.5 shrink-0", i.state === "rejected" ? "text-danger" : "text-warning")} aria-hidden /> : <span className="size-3.5 shrink-0" aria-hidden />}
      <div className="min-w-0 flex-1">
        {i.node_id ? (
          <Link to={filesUrl(projectId, i.node_id)} className="block truncate hover:underline" title={i.rel_path}>
            {i.rel_path}
          </Link>
        ) : (
          <span className="block truncate" title={i.rel_path}>{i.rel_path}</span>
        )}
        {bad && why && <p className={cn("text-xs", i.state === "rejected" ? "text-danger" : "text-warning")} data-testid="pipeline-file-reason">{why}</p>}
        {bad && i.diagnostics && i.diagnostics.length > 1 && (
          <ul className="mt-0.5 text-xs text-muted-foreground">
            {i.diagnostics.slice(0, 5).map((d, k) => (
              <li key={k}>
                <code className="font-mono">{d.code}</code> {d.message}
              </li>
            ))}
          </ul>
        )}
      </div>
      {i.kind && <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">{i.kind}</span>}
      {i.size != null && <span className="tnum hidden w-16 shrink-0 text-right text-xs text-muted-foreground sm:inline">{formatBytes(i.size)}</span>}
      <Badge theme={ITEM_THEME[i.state]} className="shrink-0">{ITEM_LABEL[i.state]}</Badge>
    </div>
  );
}
