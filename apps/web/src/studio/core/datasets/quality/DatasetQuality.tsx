import { useState } from "react";
import { Link } from "react-router";
import type { DatasetIssue, DatasetProfile } from "@studio/contracts/types";
import { ErrorIcon, InfoIcon, ReviewIcon, WarningIcon } from "@studio/ui/icons";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { EmptyState } from "@studio/ui/ui/empty-state";
import { SegmentedControl } from "@studio/ui/ui/segmented-control";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { cn } from "@studio/ui/utils";
import { ErrorView } from "@/studio/app/routes/errors";
import { projectUrl, targetUrl } from "@/studio/lib/routes";
import type { DatasetViewProps } from "../DatasetLayout";
import { useDatasetAttention, usePipelineProblems } from "../api";
import { groupIssues, pipelineAttention, rankAttention } from "../model";
import { AttentionLine, DatasetInspector, Facts, InspectorSection, SelectableRow, Workspace } from "../shared";

/**
 * Quality (docs/datasets.md §8): grouped issues with severity, impact and the next action, not a
 * scorecard. Severity and blocking are separate words; colour never carries either alone.
 */
export function DatasetQuality({ projectId, dataset, profile }: DatasetViewProps) {
  const [only, setOnly] = useState<"all" | "blocking">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const attention = useDatasetAttention(projectId, dataset.id);
  const pipeline = usePipelineProblems(projectId);
  // Beyond inspection: drop plans still waiting for a decision, and todo12's pipeline validation.
  const extra = rankAttention([...(attention.data?.items ?? []).filter((i) => i.kind === "plan"), ...pipelineAttention(pipeline.data, dataset.id)]);
  if (profile.error) return <ErrorView variant="section" error={profile.error} what="quality checks" onRetry={() => void profile.refetch()} />;
  const p = profile.data;
  if (!p)
    return (
      <div className="flex flex-col gap-3" aria-busy>
        {[0, 1].map((i) => <Skeleton key={i} className="h-28 rounded-lg" />)}
      </div>
    );
  const issues = only === "blocking" ? p.issues.filter((i) => i.blocking) : p.issues;
  const pick = p.issues.find((i) => i.id === selected) ?? null;
  return (
    <Workspace inspectorTitle={pick?.title ?? "Issue"} onCloseInspector={() => setSelected(null)} inspector={pick && <IssueInspector projectId={projectId} datasetId={dataset.id} issue={pick} profile={p} onClose={() => setSelected(null)} />}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">Checks run on every file this dataset pins. Severity says how much an issue matters; “Blocks release” says whether it stops publishing.</p>
        {p.issues.length > 0 && (
          <SegmentedControl
            value={only}
            onValueChange={setOnly}
            options={[
              { value: "all", label: "All issues" },
              { value: "blocking", label: "Blocking" },
            ]}
            aria-label="Show"
          />
        )}
      </div>
      {extra.length > 0 && (
        <section aria-labelledby="q-extra" className="mb-5" data-testid="quality-extra">
          <h2 id="q-extra" className="mb-2 text-sm font-medium text-muted-foreground">From drops and pipeline runs</h2>
          <Card className="divide-y divide-border overflow-hidden">
            {extra.map((i) => <AttentionLine key={i.id} projectId={projectId} item={i} />)}
          </Card>
        </section>
      )}
      {p.issues.length === 0 && extra.length === 0 ? (
        <Card>
          <EmptyState art="success" title="No problems found" description="Every file this dataset pins passed inspection." data-testid="quality-clean" />
        </Card>
      ) : p.issues.length === 0 ? null : issues.length === 0 ? (
        <Card>
          <EmptyState art="success" size="m" title="Nothing blocks a release" description="The issues left are worth a look but don't stop publishing." />
        </Card>
      ) : (
        <div className="flex flex-col gap-5" data-testid="quality-groups">
          {groupIssues(issues).map((g) => (
            <section key={g.category} aria-labelledby={`q-${g.category}`} data-testid="quality-group" data-category={g.category}>
              <h2 id={`q-${g.category}`} className="mb-2 text-sm font-medium text-muted-foreground">{g.title}</h2>
              <Card className="divide-y divide-border overflow-hidden">
                {g.issues.map((i) => (
                  <SelectableRow key={i.id} selected={selected === i.id} onSelect={() => setSelected(i.id)} data-testid="quality-issue" data-issue={i.id}>
                    <IssueLine issue={i} />
                  </SelectableRow>
                ))}
              </Card>
            </section>
          ))}
        </div>
      )}
    </Workspace>
  );
}

const SEVERITY = {
  high: { icon: ErrorIcon, className: "text-danger", label: "High" },
  medium: { icon: WarningIcon, className: "text-warning", label: "Medium" },
  low: { icon: InfoIcon, className: "text-hint", label: "Low" },
} as const;

/** One issue in a row: severity icon and word, title, detail, and whether it blocks a release. */
export function IssueLine({ issue: i }: { issue: DatasetIssue }) {
  const s = SEVERITY[i.severity];
  return (
    <>
      <s.icon className={cn("size-4 shrink-0", s.className)} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{i.title}</span>
        {i.detail && <span className="block truncate text-muted-foreground">{i.detail}</span>}
      </span>
      <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{s.label}</span>
      {i.blocking && <Badge theme="danger" size="xs">Blocks release</Badge>}
    </>
  );
}

function IssueInspector({ projectId, datasetId, issue: i, profile, onClose }: { projectId: string; datasetId: string; issue: DatasetIssue; profile: DatasetProfile; onClose: () => void }) {
  const collection = profile.collections.find((c) => c.id === i.collectionId);
  return (
    <DatasetInspector title={i.title} onClose={onClose}>
      <p className="text-muted-foreground">{i.detail}</p>
      <InspectorSection title="Impact" testid="issue-impact">
        <Facts
          rows={[
            ["Severity", SEVERITY[i.severity].label],
            ["Release", i.blocking ? "Blocks publishing" : "Doesn't block publishing"],
            ["Affected", `${i.count.toLocaleString()} ${i.count === 1 ? "item" : "items"}`],
            ...(collection ? ([["Collection", collection.name]] as [string, string][]) : []),
          ]}
        />
      </InspectorSection>
      <InspectorSection title="Next step">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" asChild>
            <Link to={targetUrl(projectId, i.action.target)} data-testid="issue-action">{i.action.label}</Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to={`${projectUrl(projectId, "review")}?dataset=${encodeURIComponent(datasetId)}`}>
              <ReviewIcon /> Open in Review
            </Link>
          </Button>
        </div>
      </InspectorSection>
      <InspectorSection title="Where this comes from" testid="issue-attribution">
        <Facts
          rows={[
            ["Rule", <code key="r" className="font-mono text-xs">{i.ruleId}</code>],
            ["Snapshot", profile.snapshot.label],
            ["Checked", "When the files were inspected"],
          ]}
        />
      </InspectorSection>
    </DatasetInspector>
  );
}
