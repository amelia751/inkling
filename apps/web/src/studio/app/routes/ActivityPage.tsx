import { Link, useParams } from "react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ActivityIcon, AiIcon, ChevronRightIcon, HumanIcon } from "@studio/ui/icons";
import { AppLayout, PageHeading } from "@/studio/components/layout/app-layout";
import { Button } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { Skeleton } from "@studio/ui/ui/skeleton";
import type { ActivityActor, ActivityEntry } from "@studio/contracts/types";
import { fetchActivity, projectKeys } from "@/studio/lib/projects-api";
import { targetUrl } from "@/studio/lib/routes";

/**
 * Activity (todo6 Phase 8): who changed what, newest first and grouped by day. Read from the
 * audit log (imports, proposals, datasets, tasks, privacy decisions, version commits and
 * merges, plugins) plus Studio setup revisions. The assistant is always named with the
 * person it acted for (SessionDelegation).
 */
export function ActivityPage() {
  const { projectId = "" } = useParams();
  const feed = useInfiniteQuery({
    queryKey: projectKeys.activity(projectId),
    queryFn: ({ pageParam }) => fetchActivity(projectId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 5_000,
  });
  const entries = feed.data?.pages.flatMap((p) => p.entries) ?? [];
  const days = groupByDay(entries);
  return (
    <AppLayout>
      <div className="mx-auto w-full max-w-4xl px-4 py-5 md:px-6 md:py-6" data-testid="activity-page">
        <PageHeading title="Activity" description="Who changed what, and when." />
        {feed.isLoading && <Skeleton className="h-48 rounded-lg" />}
        {feed.error && <p className="text-sm text-muted-foreground">Couldn't load activity: {String(feed.error)}</p>}
        {feed.data && !entries.length && <p className="text-sm text-muted-foreground" data-testid="activity-empty">Nothing has happened here yet.</p>}
        <div className="flex flex-col gap-6">
          {days.map(([day, list]) => (
            <section key={day} aria-label={day} data-testid="activity-day">
              <h2 className="mb-2 text-sm font-medium text-muted-foreground">{day}</h2>
              <Card className="divide-y divide-border overflow-hidden">
                {list.map((e) => <Entry key={e.id} projectId={projectId} entry={e} />)}
              </Card>
            </section>
          ))}
        </div>
        {feed.hasNextPage && (
          <Button variant="outline" className="mt-4" onClick={() => void feed.fetchNextPage()} disabled={feed.isFetchingNextPage}>
            Show older
          </Button>
        )}
      </div>
    </AppLayout>
  );
}

function Entry({ projectId, entry: e }: { projectId: string; entry: ActivityEntry }) {
  const who = e.who ?? actorOf(e.actor, e.onBehalfOf);
  const Icon = who.kind === "assistant" ? AiIcon : who.kind === "person" ? HumanIcon : ActivityIcon;
  const body = (
    <>
      <Icon className={who.kind === "assistant" ? "size-4 shrink-0 text-ai-text" : "size-4 shrink-0 text-hint"} />
      <p className="min-w-0 flex-1 text-sm">
        <span className="font-medium" data-testid="activity-actor">{actorName(who)}</span> <span data-testid="activity-label">{e.label}</span>
        {e.subject && <span className="text-muted-foreground"> · {e.subject}</span>}
      </p>
      <time className="tnum shrink-0 text-sm text-muted-foreground" dateTime={e.at ?? undefined}>{e.at ? new Date(e.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : ""}</time>
      {e.link && <ChevronRightIcon className="size-4 shrink-0 text-hint" />}
    </>
  );
  const common = { className: "flex items-center gap-3 px-4 py-2.5", "data-testid": "activity-entry", "data-action": e.action, "data-actor-kind": who.kind } as const;
  return e.link ? (
    <Link to={targetUrl(projectId, e.link)} {...common} className={`${common.className} hover:bg-generic`}>
      {body}
    </Link>
  ) : (
    <div {...common}>{body}</div>
  );
}

/** "Ana", "Assistant for Ana", or Inkling's own parts ("Inspection", "Sample data"). */
export function actorName(who: ActivityActor): string {
  if (who.kind === "assistant") return who.onBehalfOf ? `Assistant for ${who.onBehalfOf}` : "Assistant";
  return who.name;
}

/** For entries without `who` (older servers, the seed stand-in). */
function actorOf(actor: string | null, onBehalfOf?: string | null): ActivityActor {
  const [kind, name] = (actor ?? "").includes(":") ? (actor ?? "").split(":", 2) : ["user", actor ?? "someone"];
  const person = onBehalfOf?.split(":").at(-1) ?? null;
  if (kind === "agent") return { kind: "assistant", name: "Assistant", onBehalfOf: person };
  if (kind === "user") return { kind: "person", name: name || "someone", onBehalfOf: null };
  return { kind: "system", name: actor === "system:seed" ? "Sample data" : name || kind, onBehalfOf: person };
}

/** Day headings in local time: "Today", "Yesterday", else the date. */
export function groupByDay(entries: ActivityEntry[], now = new Date()): [string, ActivityEntry[]][] {
  const key = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const today = key(now);
  const yesterday = key(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const out = new Map<string, ActivityEntry[]>();
  for (const e of entries) {
    const d = e.at ? new Date(e.at) : null;
    const k = !d || Number.isNaN(d.getTime()) ? "Earlier" : key(d) === today ? "Today" : key(d) === yesterday ? "Yesterday" : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
    out.set(k, [...(out.get(k) ?? []), e]);
  }
  return [...out.entries()];
}
