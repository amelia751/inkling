import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeftIcon, ChevronRightIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { EmptyState, NoResults } from "@studio/ui/ui/empty-state";
import { SegmentedControl } from "@studio/ui/ui/segmented-control";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { AppLayout, PageHeading } from "@/studio/components/layout/app-layout";
import { ErrorView } from "@/studio/app/routes/errors";
import { filesUrl, pipelinesUrl } from "@/studio/lib/routes";
import type { PipelineRunSummary, RunState } from "./contract";
import { usePipelineRuns } from "./api";
import { usePipelineEvents } from "./events";
import { definitionName, duration, runCounts, triggerLabel } from "./model";
import { Counts, RunStatus, when } from "./parts";

type Filter = "all" | "review" | "running" | "problems";
const FILTER_STATES: Record<Exclude<Filter, "all">, RunState[]> = {
  review: ["awaiting_review"],
  running: ["queued", "running", "publishing"],
  problems: ["failed", "rejected", "cancelled"],
};

/**
 * Pipeline runs (todo12 M1, docs/pipeline.md §6): every upload's implicit ingest run, newest
 * first, live from the project stream. Under Data, beside Imports: a run is what happened to
 * an import after its bytes arrived. No DAG editor (todo12 §8).
 */
export function PipelineRunsPage() {
  const { projectId = "" } = useParams();
  usePipelineEvents(projectId);
  const q = usePipelineRuns(projectId);
  const [filter, setFilter] = useState<Filter>("all");
  const runs = useMemo(() => q.data?.runs ?? [], [q.data]);
  const shown = filter === "all" ? runs : runs.filter((r) => FILTER_STATES[filter].includes(r.state));
  const count = (f: Exclude<Filter, "all">) => runs.filter((r) => FILTER_STATES[f].includes(r.state)).length;
  const label = (text: string, n: number) => (n ? <>{text} <span className="tnum ml-1 text-hint">{n}</span></> : text);
  return (
    <AppLayout>
      <div className="mx-auto w-full max-w-5xl px-4 py-5 md:px-6 md:py-6" data-testid="pipeline-runs-page">
        <PageHeading
          title="Pipeline runs"
          description="Each upload is checked, processed and proposed as a new dataset version. A reviewer approves it before it's published."
          actions={
            <Button variant="outline" size="lg" asChild>
              <Link to={filesUrl(projectId)}>
                <ArrowLeftIcon /> Files
              </Link>
            </Button>
          }
        />
        {q.isLoading && <Skeleton className="h-40 rounded-lg" />}
        {q.error && <ErrorView error={q.error} what="list of runs" variant="section" onRetry={() => void q.refetch()} />}
        {q.data && runs.length === 0 && (
          <EmptyState
            size="m"
            art="files"
            title="No pipeline runs yet"
            description="When you upload files, each upload is checked and proposed as a dataset version here."
            actions={
              <Button variant="outline" size="lg" asChild>
                <Link to={filesUrl(projectId)}>Open Files</Link>
              </Button>
            }
            data-testid="pipeline-runs-empty"
          />
        )}
        {runs.length > 0 && (
          <>
            <div className="mb-3 flex items-center gap-2">
              <SegmentedControl
                aria-label="Show runs"
                size="md"
                value={filter}
                onValueChange={setFilter}
                options={[
                  { value: "all", label: "All" },
                  { value: "review", label: label("Needs review", count("review")) },
                  { value: "running", label: label("Running", count("running")) },
                  { value: "problems", label: label("Didn't finish", count("problems")) },
                ]}
              />
            </div>
            {shown.length ? (
              <Card className="divide-y divide-border overflow-hidden" data-testid="pipeline-runs">
                {shown.map((r) => (
                  <RunRow key={r.run_id} projectId={projectId} run={r} />
                ))}
              </Card>
            ) : (
              <NoResults size="m" what="runs" onClear={() => setFilter("all")} />
            )}
            {q.data?.next_cursor && <p className="mt-3 text-sm text-muted-foreground">Showing the newest {runs.length.toLocaleString()} runs.</p>}
          </>
        )}
      </div>
    </AppLayout>
  );
}

function RunRow({ projectId, run }: { projectId: string; run: PipelineRunSummary }) {
  return (
    <Link to={pipelinesUrl(projectId, run.run_id)} className="flex items-center gap-3 px-4 py-3 hover:bg-generic" data-testid="pipeline-run-row" data-run-id={run.run_id} data-state={run.state}>
      <span className="w-28 shrink-0">
        <RunStatus state={run.state} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {triggerLabel(run)} · {when(run.created_at)}
        </p>
        <Counts counts={runCounts(run)} className="block truncate" />
      </div>
      <span className="hidden shrink-0 text-sm text-muted-foreground md:inline">{definitionName(run)}</span>
      <span className="tnum hidden w-16 shrink-0 text-right text-sm text-muted-foreground sm:inline" title="Duration">
        {duration(run.started_at, run.finished_at)}
      </span>
      <ChevronRightIcon className="size-4 shrink-0 text-hint" />
    </Link>
  );
}
