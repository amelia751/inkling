import { Link, useParams, useSearchParams } from "react-router";
import { EmptyState, NoResults } from "@studio/ui/ui/empty-state";
import { ChevronRightIcon, ErrorIcon, PrivacyIcon, RelationshipIcon, ReviewIcon, WarningIcon, type IconComponent } from "@studio/ui/icons";
import { AppLayout, PageHeading } from "@/studio/components/layout/app-layout";
import { Badge } from "@studio/ui/ui/badge";
import { Card } from "@studio/ui/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@studio/ui/ui/select";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { cn } from "@studio/ui/utils";
import type { AttentionItem } from "@studio/contracts/types";
import { useDatasets, useReviewQueue, type ReviewFilters } from "@/studio/lib/projects-api";
import { projectUrl, targetUrl } from "@/studio/lib/routes";

/**
 * Review (todo6 Phase 8): one queue over everything that waits for a person — privacy holds,
 * imports that didn't fully arrive, files we can't read, unconfirmed proposals, version review
 * requests and annotation suggestions — filterable by type, severity and dataset. Each row
 * opens its exact surface. The Overview's "Needs your attention" is the top 5 of the same
 * endpoint. Below it, annotation review per task (what `/datasets/:id/review` was).
 */
export const QUEUE_TYPES: { value: AttentionItem["type"]; label: string; icon: IconComponent }[] = [
  { value: "privacy", label: "Privacy holds", icon: PrivacyIcon },
  { value: "import", label: "Import issues", icon: ErrorIcon },
  { value: "quality", label: "Unreadable files", icon: WarningIcon },
  { value: "proposal", label: "Proposals", icon: RelationshipIcon },
  { value: "version-review", label: "Version reviews", icon: ReviewIcon },
  { value: "annotations", label: "Annotation suggestions", icon: ReviewIcon },
];
const TYPE = new Map(QUEUE_TYPES.map((t) => [t.value, t]));
const SEVERITIES = [
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
] as const;
const ALL = "all";

export function ProjectReviewPage() {
  const { projectId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const filters: ReviewFilters = { type: params.get("type") ?? undefined, severity: params.get("severity") ?? undefined, dataset: params.get("dataset") ?? undefined };
  const queue = useReviewQueue(projectId, filters);
  const datasets = useDatasets(projectId);
  const facets = queue.data?.facets;
  const setFilter = (key: keyof ReviewFilters, value: string) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (value === ALL) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );
  const filtered = !!(filters.type || filters.severity || filters.dataset);
  const tasks = (datasets.data ?? []).flatMap((d) => d.tasks.map((t) => ({ ...t, datasetTitle: d.title })));

  return (
    <AppLayout>
      <div className="mx-auto w-full max-w-6xl px-4 py-5 md:px-6 md:py-6" data-testid="review-page">
        <PageHeading title="Review" description="Everything waiting for a decision from you, most important first." />

        <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="review-filters">
          <FilterSelect label="Type" value={filters.type} onChange={(v) => setFilter("type", v)} testId="filter-type" options={QUEUE_TYPES.map((t) => ({ value: t.value, label: t.label, count: facets?.types[t.value] }))} />
          <FilterSelect label="Severity" value={filters.severity} onChange={(v) => setFilter("severity", v)} testId="filter-severity" options={SEVERITIES.map((s) => ({ value: s.value, label: s.label, count: facets?.severities[s.value] }))} />
          <FilterSelect
            label="Dataset"
            value={filters.dataset}
            onChange={(v) => setFilter("dataset", v)}
            testId="filter-dataset"
            options={(datasets.data ?? []).map((d) => ({ value: d.id, label: d.title, count: facets?.datasets.find((x) => x.id === d.id)?.count }))}
          />
          {filtered && (
            <button type="button" className="text-sm text-brand hover:underline" onClick={() => setParams({}, { replace: true })}>
              Clear filters
            </button>
          )}
        </div>

        {queue.isLoading && <Skeleton className="h-40 rounded-lg" />}
        {queue.error && <p className="text-sm text-muted-foreground">Couldn't load the review queue: {String(queue.error)}</p>}
        {queue.data &&
          (queue.data.items.length ? (
            <Card className="divide-y divide-border overflow-hidden" data-testid="review-queue">
              {queue.data.items.map((i) => (
                <QueueRow key={i.id} projectId={projectId} item={i} datasetTitle={datasets.data?.find((d) => d.id === i.datasetId)?.title} />
              ))}
            </Card>
          ) : (
            filtered ? (
              <NoResults size="m" data-testid="review-empty" />
            ) : (
              <EmptyState size="m" art="success" title="You're all caught up" description="Nothing is waiting for a decision from you." data-testid="review-empty" />
            )
          ))}

        <section className="mt-8" aria-labelledby="annotation-review-heading">
          <h2 id="annotation-review-heading" className="mb-1 text-body-2 font-semibold">Annotation review</h2>
          <p className="mb-3 text-sm text-muted-foreground">Saved annotations per task, with the Studio setup's review rules.</p>
          {datasets.isLoading && <Skeleton className="h-16 rounded-lg" />}
          {datasets.data && !tasks.length && <EmptyState size="m" art="task" title="No tasks yet" description="Add a task to a dataset to start annotating. Its saved work is reviewed here." />}
          {tasks.length > 0 && (
            <Card className="divide-y divide-border overflow-hidden" data-testid="annotation-review">
              {tasks
                .filter((t) => !filters.dataset || t.datasetId === filters.dataset)
                .map((t) => (
                  <Link key={t.id} to={`${projectUrl(projectId, "review")}/${encodeURIComponent(t.id)}`} className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-generic" data-testid="annotation-review-task" data-task-id={t.id}>
                    <ReviewIcon className="size-4 shrink-0 text-hint" />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{t.title}</span>
                      {t.datasetTitle !== t.title && <span className="text-muted-foreground"> · {t.datasetTitle}</span>}
                    </span>
                    <span className="tnum shrink-0 text-muted-foreground">
                      {t.annotationCount} {t.annotationCount === 1 ? "annotation" : "annotations"}
                    </span>
                    <ChevronRightIcon className="size-4 shrink-0 text-hint" />
                  </Link>
                ))}
            </Card>
          )}
        </section>
      </div>
    </AppLayout>
  );
}

function QueueRow({ projectId, item, datasetTitle }: { projectId: string; item: AttentionItem; datasetTitle?: string }) {
  const t = TYPE.get(item.type);
  const Icon = t?.icon ?? WarningIcon;
  return (
    <Link to={targetUrl(projectId, item.target)} className="flex items-center gap-3 px-4 py-3 hover:bg-generic" data-testid="review-row" data-type={item.type} data-severity={item.severity}>
      <Icon className={cn("size-4 shrink-0", item.severity === "high" ? "text-warning" : "text-hint")} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{item.title}</p>
        {item.detail && <p className="truncate text-sm text-muted-foreground">{item.detail}</p>}
      </div>
      <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">{t?.label}</span>
      {datasetTitle && <Badge theme="unknown" size="xs" className="hidden md:inline-flex">{datasetTitle}</Badge>}
      {item.severity === "high" && <Badge theme="warning" size="xs">High</Badge>}
      <ChevronRightIcon className="size-4 shrink-0 text-hint" />
    </Link>
  );
}

function FilterSelect({ label, value, onChange, options, testId }: { label: string; value?: string; onChange: (v: string) => void; options: { value: string; label: string; count?: number }[]; testId: string }) {
  return (
    <Select value={value ?? ALL} onValueChange={onChange}>
      <SelectTrigger className="h-8 w-auto min-w-36 gap-2" aria-label={label} data-testid={testId}>
        <span className="text-muted-foreground">{label}:</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
            {o.count ? <span className="tnum ml-1 text-hint">{o.count}</span> : null}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
