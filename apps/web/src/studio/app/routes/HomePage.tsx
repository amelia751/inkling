import { Link } from "react-router";
import { problemMessage } from "@/studio/lib/problem";
import { ProjectsIcon } from "@studio/ui/icons";
import { AppLayout } from "@/studio/components/layout/app-layout";
import { Button } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { Skeleton, SkeletonText } from "@studio/ui/ui/skeleton";
import { useProjectList } from "@/studio/lib/projects-api";
import { TrySample } from "@/studio/app/entry/sample-picker";
import { projectsUrl, projectUrl, studioUrl, deletedProjectsUrl } from "@/studio/lib/routes";
import { HomeComposer, NewProjectButton } from "@/studio/app/entry/HomeComposer";
import type { DetectedKind, ProjectSummary } from "@studio/contracts/types";
import { KINDS, kindIcon } from "@/studio/lib/file-kinds";

/**
 * Home (todo6 Phase 3.1, todo13 D1 and §3.1): "What are you working on?" as the composer. A
 * send or a drop (anywhere on the page) starts a new project (todo20 D1) and opens it with the
 * assistant; "New project" asks for a name. Below it, the recent projects with a single Resume action each. No
 * metrics. There is no form: this composer is how a project starts.
 */
export function HomePage() {
  const { data: projects, isLoading, error } = useProjectList();
  const recent = (projects ?? []).slice(0, 6);
  const empty = !isLoading && !error && recent.length === 0;

  return (
    <AppLayout>
      <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-4 py-8 md:px-6 md:py-10">
        <HomeComposer
          projects={projects}
          className="flex-1"
        >
          {/* todo14 §4.1: one quiet line instead of Recent projects, only when the api offers samples. */}
          {empty && <TrySample className="mt-6" />}
          {!empty && (
            <section className="mt-6" aria-labelledby="recent-heading">
              <div className="mb-3 flex items-baseline justify-between gap-4">
                <h2 id="recent-heading" className="text-body-2 font-semibold">Recent projects</h2>
                <span className="flex items-center gap-3">
                  <NewProjectButton />
                  <Link to={projectsUrl()} className="text-sm text-brand hover:underline">All projects</Link>
                </span>
              </div>
              {error && <p className="text-sm text-danger" role="alert" data-testid="home-projects-error">Couldn't load your projects: {problemMessage(error)}</p>}
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {isLoading && [0, 1, 2].map((i) => <ProjectCardSkeleton key={i} />)}
                {recent.map((p) => (
                  <ProjectCard key={p.id} project={p} />
                ))}
              </div>
              <p className="mt-3 text-sm">
                <Link to={deletedProjectsUrl()} className="text-muted-foreground hover:underline" data-testid="deleted-projects-link">Deleted projects</Link>
              </p>
            </section>
          )}
        </HomeComposer>
      </div>
    </AppLayout>
  );
}

/** "2 h ago", "yesterday", "Oct 30". */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  const s = Math.round((Date.now() - then) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86400) return "yesterday";
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Same frame as ProjectCard so the grid doesn't jump when projects arrive. */
export function ProjectCardSkeleton() {
  return (
    <Card className="flex h-[148px] flex-col p-4" aria-busy>
      <div className="flex items-start gap-3">
        <Skeleton className="size-10 shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1">
          <SkeletonText variant="subheader" className="w-3/5" />
          <SkeletonText className="mt-1 w-4/5" />
        </div>
      </div>
      <SkeletonText className="mt-auto w-1/3" />
    </Card>
  );
}

export function ProjectCard({ project: p }: { project: ProjectSummary }) {
  return (
    <Card view="selection" className="relative flex min-h-[148px] flex-col p-4" data-testid="project-card">
      <div className="flex items-start gap-3">
        <span className="tile-gradient flex size-10 shrink-0 items-center justify-center rounded-lg">
          <ProjectsIcon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-body-2 font-semibold" title={p.title}>
            {/* The whole card opens the project; Resume is its own control on top. */}
            <Link to={projectUrl(p.id)} className="after:absolute after:inset-0 after:rounded-lg">{p.title}</Link>
          </h3>
          {p.description && <p className="mt-0.5 truncate text-sm text-muted-foreground">{p.description}</p>}
          <KindTags kinds={p.kinds ?? []} />
        </div>
      </div>
      <div className="mt-auto flex items-center gap-2 pt-3">
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">Edited {relativeTime(p.lastActivityAt)}</span>
        {p.resume && (
          <Button size="sm" variant="outline" asChild className="relative z-10">
            <Link to={studioUrl(p.id, p.resume.taskId)} state={{ resume: true }} data-testid="resume">Resume</Link>
          </Button>
        )}
      </div>
    </Card>
  );
}

const MAX_TAGS = 3;

/** "12 Images · 5 3D volumes · +2": the first few kinds; the rest are named in the "+N" tooltip. */
function KindTags({ kinds }: { kinds: { kind: DetectedKind; count: number }[] }) {
  if (kinds.length === 0) return null;
  const word = (k: { kind: DetectedKind; count: number }) => `${k.count.toLocaleString()} ${k.count === 1 ? KINDS[k.kind].label : KINDS[k.kind].plural}`;
  const shown = kinds.length > MAX_TAGS ? kinds.slice(0, MAX_TAGS - 1) : kinds;
  const rest = kinds.slice(shown.length);
  return (
    <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5" data-testid="project-kinds">
      {shown.map((k) => {
        const Icon = kindIcon(k.kind);
        return (
          <span key={k.kind} className="inline-flex items-center gap-1 rounded-md bg-generic px-1.5 py-0.5 text-xs text-muted-foreground" data-testid="project-kind">
            <Icon className="size-3 shrink-0" aria-hidden />
            {word(k)}
          </span>
        );
      })}
      {rest.length > 0 && (
        <span className="rounded-md bg-generic px-1.5 py-0.5 text-xs text-muted-foreground" title={rest.map(word).join(", ")}>
          +{rest.length}
        </span>
      )}
    </div>
  );
}
