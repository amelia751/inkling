import { useState } from "react";
import { NoResults } from "@studio/ui/ui/empty-state";
import { Link, useLocation, useNavigate } from "react-router";
import { AddDataIcon, SearchIcon } from "@studio/ui/icons";
import { AppLayout, PageHeading } from "@/studio/components/layout/app-layout";
import { NewProjectForm, type NewProjectState } from "@/studio/components/projects/new-project";
import { Button } from "@studio/ui/ui/button";
import { Input } from "@studio/ui/ui/input";
import { SegmentedControl } from "@studio/ui/ui/segmented-control";
import { useProjectList } from "@/studio/lib/projects-api";
import { newProjectUrl } from "@/studio/lib/routes";
import { ProjectCard, ProjectCardSkeleton } from "./HomePage";
import { HomeComposer } from "@/studio/app/entry/HomeComposer";
import { TrySample } from "@/studio/app/entry/sample-picker";

/** All projects (`/projects`): search and sort, in the same cards as Home. */
export function ProjectsPage() {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"recent" | "title">("recent");
  const { data, isLoading, error } = useProjectList(q.trim() || undefined, sort);
  return (
    <AppLayout>
      <div className="mx-auto w-full max-w-6xl px-4 py-5 md:px-6 md:py-6">
        <PageHeading
          title="Projects"
          actions={
            <Button size="lg" asChild>
              <Link to={newProjectUrl()}><AddDataIcon /> New project</Link>
            </Button>
          }
        />
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="relative min-w-[240px] flex-1">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-hint" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects" className="pl-8" aria-label="Search projects" />
          </div>
          <SegmentedControl
            value={sort}
            onValueChange={(v) => setSort(v as "recent" | "title")}
            options={[
              { value: "recent", label: "Recent" },
              { value: "title", label: "Name" },
            ]}
            aria-label="Sort"
          />
        </div>
        {error && <p className="text-sm text-muted-foreground">Couldn't load projects: {String(error)}</p>}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {isLoading && [0, 1, 2].map((i) => <ProjectCardSkeleton key={i} />)}
          {data?.map((p) => <ProjectCard key={p.id} project={p} />)}
        </div>
        {data && !data.length &&
          (q.trim() ? (
            <NoResults what="projects" onClear={() => setQ("")} />
          ) : (
            // todo13 §3.1: the same composer as Home, not a second, different empty state.
            <>
              <HomeComposer projects={data} surface="projects" className="mt-2" />
              <TrySample className="mt-4" />
            </>
          ))}
      </div>
    </AppLayout>
  );
}

/** Create project as a page (`/projects/new`): Home hands it a goal sentence and dropped files. */
export function NewProjectPage() {
  const state = (useLocation().state ?? {}) as NewProjectState;
  const navigate = useNavigate();
  return (
    <AppLayout>
      <div className="mx-auto w-full max-w-2xl px-4 py-5 md:px-6 md:py-8">
        <PageHeading title="New project" description="Name it, or say what you're trying to build. You can add data now or later." />
        <NewProjectForm initial={state} onCancel={() => navigate(-1)} />
      </div>
    </AppLayout>
  );
}
