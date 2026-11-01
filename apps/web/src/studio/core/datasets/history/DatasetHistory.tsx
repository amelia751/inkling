import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ActivityIcon, AiIcon, BranchIcon, HumanIcon, MergeIcon, TagIcon, type IconComponent } from "@studio/ui/icons";
import { Badge } from "@studio/ui/ui/badge";
import { Card } from "@studio/ui/ui/card";
import { EmptyState } from "@studio/ui/ui/empty-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@studio/ui/ui/select";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { ErrorView } from "@/studio/app/routes/errors";
import { actorName, actorOf } from "@/studio/app/routes/ActivityPage";
import { relativeTime } from "@/studio/components/files";
import { NestedPage } from "@/studio/components/layout/app-layout";
import { fetchActivity, projectKeys } from "@/studio/lib/projects-api";
import { VersionsPage } from "@/studio/core/versioning";
import { api as versioning, type Commit } from "@/studio/core/versioning/api";
import { versioningEnabled } from "@/studio/core/versioning/session";
import type { DatasetViewProps } from "../DatasetLayout";
import { authorName, historyTitle } from "../model";

const STATES: { icon: IconComponent; title: string; body: string }[] = [
  { icon: BranchIcon, title: "Working draft", body: "Your edits. Editable, not published." },
  { icon: MergeIcon, title: "main", body: "The latest approved version. Changes reach it through a review." },
  { icon: TagIcon, title: "Release", body: "A pinned, read-only snapshot for training and audit." },
];

/** The snapshot picker's choices: the working draft, `main`, and each release (read-only). */
export interface SnapshotChoice {
  /** URL value: `draft`, `main` or `release:<tag>`. */
  value: string;
  label: string;
  /** The versioning ref to read commits from. */
  ref: string;
  readOnly: boolean;
}

export function snapshotChoices(workBranch: string | undefined, releases: { tag: string; commit_oid: string }[]): SnapshotChoice[] {
  return [
    { value: "draft", label: "Working draft", ref: workBranch ?? "main", readOnly: false },
    { value: "main", label: "main (latest approved)", ref: "main", readOnly: true },
    ...releases.map((r) => ({ value: `release:${r.tag}`, label: `Release ${r.tag}`, ref: r.commit_oid, readOnly: true })),
  ];
}

/**
 * History (docs/datasets.md §9): versioning inside the dataset, one view of six. The three kinds
 * of version are named first so a draft is never mistaken for a release; then the snapshot
 * picker and what changed, in words (§9.2), hashes only under "Technical details". The full
 * branches, reviews and releases page stays one click down for people who need it.
 */
export function DatasetHistory({ projectId, dataset }: DatasetViewProps) {
  const on = useQuery({ queryKey: ["versioning", dataset.id, "enabled"], queryFn: () => versioningEnabled(dataset.id), staleTime: Infinity });
  return (
    <div className="flex flex-col gap-5" data-testid="dataset-history">
      <ul className="grid gap-3 sm:grid-cols-3" aria-label="Kinds of version">
        {STATES.map((s) => (
          <li key={s.title} className="flex items-start gap-2.5 rounded-lg bg-generic px-3 py-2.5 text-sm">
            <s.icon className="mt-0.5 size-4 shrink-0 text-hint" />
            <span>
              <span className="block font-medium">{s.title}</span>
              <span className="text-muted-foreground">{s.body}</span>
            </span>
          </li>
        ))}
      </ul>
      {on.isLoading ? (
        <Skeleton className="h-40 rounded-lg" aria-busy />
      ) : on.data ? (
        <>
          <VersionTimeline datasetId={dataset.id} />
          <details className="group text-sm" data-testid="history-advanced">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Branches, reviews and releases</summary>
            <div className="mt-3">
              <NestedPage>
                <VersionsPage />
              </NestedPage>
            </div>
          </details>
        </>
      ) : (
        <ActivityTimeline projectId={projectId} datasetId={dataset.id} />
      )}
    </div>
  );
}

function VersionTimeline({ datasetId }: { datasetId: string }) {
  const [params, setParams] = useSearchParams();
  const branches = useQuery({ queryKey: ["versioning", datasetId, "branches"], queryFn: () => versioning.branches(datasetId, datasetId) });
  const releases = useQuery({ queryKey: ["versioning", datasetId, "releases"], queryFn: () => versioning.releases(datasetId, datasetId) });
  const choices = snapshotChoices(branches.data?.workBranch, releases.data?.items ?? []);
  const chosen = choices.find((c) => c.value === params.get("ref")) ?? choices[0];
  const commits = useQuery({ queryKey: ["versioning", datasetId, "commits", chosen.ref], queryFn: () => versioning.commits(datasetId, datasetId, chosen.ref), enabled: !!branches.data });
  const pick = (value: string) =>
    setParams(
      (p) => {
        p.set("ref", value);
        return p;
      },
      { replace: true },
    );
  const error = branches.error ?? commits.error;
  return (
    <section aria-labelledby="history-heading" data-testid="history-timeline">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 id="history-heading" className="text-body-2 font-semibold">What changed</h2>
        <Select value={chosen.value} onValueChange={pick}>
          <SelectTrigger className="w-60" aria-label="Snapshot" data-testid="history-snapshot"><SelectValue /></SelectTrigger>
          <SelectContent>
            {choices.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
          </SelectContent>
        </Select>
        {chosen.readOnly ? <Badge theme="unknown" data-testid="history-read-only">Read-only</Badge> : <Badge theme="info">Editable, not published</Badge>}
      </div>
      {error ? (
        <ErrorView variant="section" error={error} what="this dataset's history" onRetry={() => void (branches.error ? branches.refetch() : commits.refetch())} />
      ) : commits.isLoading || branches.isLoading ? (
        <Skeleton className="h-32 rounded-lg" aria-busy />
      ) : !commits.data?.items.length ? (
        <Card>
          <EmptyState art="empty" size="m" title="No changes yet" description="Saves, approvals and releases of this snapshot appear here." data-testid="history-empty" />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ol className="divide-y divide-border" aria-label={`Changes in ${chosen.label}`}>
            {commits.data.items.map((c) => <CommitRow key={c.oid} commit={c} />)}
          </ol>
        </Card>
      )}
    </section>
  );
}

function CommitRow({ commit: c }: { commit: Commit }) {
  const Icon = c.operation === "merge" ? MergeIcon : c.author_id?.startsWith("agent:") ? AiIcon : HumanIcon;
  return (
    <li className="px-4 py-3 text-sm" data-testid="history-entry" data-operation={c.operation}>
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 size-4 shrink-0 text-hint" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{historyTitle(c)}</p>
          <p className="text-muted-foreground">
            {authorName(c.author_id)}
            {c.on_behalf_of && <> for {authorName(c.on_behalf_of)}</>} · <time dateTime={c.created_at}>{relativeTime(c.created_at)}</time>
            {c.annotation_count !== undefined && <> · {c.annotation_count.toLocaleString()} annotations</>}
            {c.sample_count !== undefined && <> · {c.sample_count.toLocaleString()} items</>}
          </p>
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Technical details</summary>
            <p className="mt-1 text-xs text-muted-foreground">
              Commit <code className="font-mono">{c.oid}</code> · {c.operation}
            </p>
          </details>
        </div>
      </div>
    </li>
  );
}

/** Without versioning, the project's activity about this dataset is its history, in words. */
function ActivityTimeline({ projectId, datasetId }: { projectId: string; datasetId: string }) {
  const feed = useQuery({ queryKey: [...projectKeys.activity(projectId), "first"], queryFn: () => fetchActivity(projectId), staleTime: 10_000 });
  const entries = (feed.data?.entries ?? []).filter((e) => e.link?.datasetId === datasetId || e.target === datasetId || e.target === `dataset:${datasetId}`);
  return (
    <section aria-labelledby="history-heading" data-testid="history-activity">
      <h2 id="history-heading" className="mb-1 text-body-2 font-semibold">What changed</h2>
      {/* `versioning-off` is the versions page's old test id (sections_test.py); kept working. */}
      <div data-testid="versioning-off">
        <p className="mb-3 text-sm text-muted-foreground" data-testid="history-versioning-off">
          Only the working draft exists here: approved versions and releases appear once versioning is turned on.
        </p>
      </div>
      {feed.error ? (
        <ErrorView variant="section" error={feed.error} what="this dataset's history" onRetry={() => void feed.refetch()} />
      ) : feed.isLoading ? (
        <Skeleton className="h-24 rounded-lg" aria-busy />
      ) : entries.length === 0 ? (
        <Card>
          <EmptyState art="empty" size="m" title="Nothing has changed yet" description="Edits, added files and published Studios appear here." data-testid="history-empty" />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ol className="divide-y divide-border" aria-label="Changes in the working draft">
            {entries.map((e) => {
              const who = e.who ?? actorOf(e.actor, e.onBehalfOf);
              const Icon = who.kind === "assistant" ? AiIcon : who.kind === "person" ? HumanIcon : ActivityIcon;
              return (
                <li key={e.id} className="flex items-center gap-3 px-4 py-2.5 text-sm" data-testid="history-entry">
                  <Icon className="size-4 shrink-0 text-hint" aria-hidden />
                  <p className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{actorName(who)}</span> {e.label}
                  </p>
                  <time className="tnum shrink-0 text-muted-foreground" dateTime={e.at ?? undefined}>{relativeTime(e.at)}</time>
                </li>
              );
            })}
          </ol>
        </Card>
      )}
    </section>
  );
}
