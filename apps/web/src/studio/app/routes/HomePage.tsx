import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { AddDataIcon, LicenseIcon, LockIcon, ProjectsIcon } from "@studio/ui/icons";
import { AppLayout } from "@/studio/components/layout/app-layout";
import { DropOverlay } from "@/studio/components/uploads/uploads";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { Skeleton, SkeletonText } from "@studio/ui/ui/skeleton";
import { Textarea } from "@studio/ui/ui/textarea";
import { useProjectList } from "@/studio/lib/projects-api";
import { newProjectUrl, projectsUrl, projectUrl, studioUrl } from "@/studio/lib/routes";
import { fromDataTransfer, hasFiles, type Picked } from "@/studio/lib/uploads/walk";
import type { ProjectSummary } from "@studio/contracts/types";
import { cn } from "@studio/ui/utils";

/** The chips fill the field; they don't run anything (todo6 §3.1). */
export const EXAMPLE_GOALS = ["Classify chest X-rays", "Outline the left ventricle in cardiac MRI", "Mark events in ECG recordings"];

/** What New project receives from Home: a goal sentence and/or files dropped on Home. */
export interface NewProjectState {
  goal?: string;
  picked?: Picked;
}

/**
 * Home (todo6 Phase 3.1, docs/ux.md §3): "What are you working on?", one primary action, a
 * natural-language field and the recent projects with a single Resume action each. No metrics.
 */
export function HomePage() {
  const { data: projects, isLoading, error } = useProjectList();
  const navigate = useNavigate();
  const [goal, setGoal] = useState("");
  const start = (state: NewProjectState) => navigate(newProjectUrl(), { state });
  const recent = (projects ?? []).slice(0, 6);
  const empty = !isLoading && !error && recent.length === 0;

  return (
    <AppLayout>
      <DropOverlay label="a new project" onDrop={(picked) => start({ goal, picked })} className="min-h-full">
        <div className="mx-auto w-full max-w-6xl px-4 py-8 md:px-6 md:py-10">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <h1 className="text-display-1 font-semibold">What are you working on?</h1>
            <Button size="lg" onClick={() => start({ goal })} data-testid="new-project">
              <AddDataIcon /> New project
            </Button>
          </div>

          <form
            className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-start"
            onSubmit={(e) => {
              e.preventDefault();
              if (goal.trim()) start({ goal: goal.trim() });
            }}
            onDragOver={(e) => hasFiles(e.dataTransfer) && e.preventDefault()}
            onDrop={async (e) => {
              if (!hasFiles(e.dataTransfer)) return;
              e.preventDefault();
              e.stopPropagation();
              start({ goal, picked: await fromDataTransfer(e.dataTransfer) });
            }}
          >
            <Textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && goal.trim()) {
                  e.preventDefault();
                  start({ goal: goal.trim() });
                }
              }}
              rows={2}
              placeholder="Describe what you want to build, or drop files here"
              aria-label="Describe what you want to build"
              className="min-h-[60px] flex-1 resize-none text-body-2"
              data-testid="goal"
            />
            <Button type="submit" size="xl" variant="outline" disabled={!goal.trim()}>Start</Button>
          </form>
          {(empty || !goal) && (
            <div className="mt-3 flex flex-wrap gap-2" aria-label="Examples">
              {EXAMPLE_GOALS.map((g) => (
                <button key={g} type="button" onClick={() => setGoal(g)} className="rounded-full border border-border px-3 py-1 text-sm text-muted-foreground hover:bg-generic hover:text-foreground" data-testid="goal-example">
                  {g}
                </button>
              ))}
            </div>
          )}

          {!empty && (
            <section className="mt-10" aria-labelledby="recent-heading">
              <div className="mb-3 flex items-baseline justify-between gap-4">
                <h2 id="recent-heading" className="text-body-2 font-semibold">Recent projects</h2>
                <Link to={projectsUrl()} className="text-sm text-brand hover:underline">All projects</Link>
              </div>
              {error && <p className="text-sm text-muted-foreground">Couldn't load your projects: {String(error)}</p>}
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {isLoading && [0, 1, 2].map((i) => <ProjectCardSkeleton key={i} />)}
                {recent.map((p) => (
                  <ProjectCard key={p.id} project={p} />
                ))}
              </div>
            </section>
          )}
          {empty && (
            <p className="mt-10 text-sm text-muted-foreground">
              No projects yet. Drop a folder anywhere on this page to start one with your data.
            </p>
          )}
        </div>
      </DropOverlay>
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
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {p.sample && <Badge theme="info">Sample</Badge>}
            {p.restricted && (
              <Badge theme="warning" title="The source license restricts commercial use or redistribution">
                <LockIcon />Local dev only
              </Badge>
            )}
          </div>
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
      {p.sample && p.license && (
        <div className={cn("mt-2 flex items-start gap-1.5 border-t border-border pt-2 text-xs text-muted-foreground")}>
          <LicenseIcon className="mt-0.5 size-3 shrink-0" />
          <span className="line-clamp-1">{p.license}</span>
        </div>
      )}
    </Card>
  );
}
