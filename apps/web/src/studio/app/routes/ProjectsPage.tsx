import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { AddDataIcon, CloseIcon, SearchIcon } from "@studio/ui/icons";
import { AppLayout, PageHeading } from "@/studio/components/layout/app-layout";
import { DropZone, useRefreshProject } from "@/studio/components/uploads/uploads";
import { Button } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { Input } from "@studio/ui/ui/input";
import { Label } from "@studio/ui/ui/label";
import { SegmentedControl } from "@studio/ui/ui/segmented-control";
import { Textarea } from "@studio/ui/ui/textarea";
import { api, NeedsApiError, projectKeys, useProjectList } from "@/studio/lib/projects-api";
import { newProjectUrl, projectUrl } from "@/studio/lib/routes";
import { useUploads } from "@/studio/stores/uploads";
import type { Picked } from "@/studio/lib/uploads/walk";
import type { ProjectSummary } from "@studio/contracts/types";
import { EXAMPLE_GOALS, ProjectCard, ProjectCardSkeleton, type NewProjectState } from "./HomePage";

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
        {data && !data.length && <p className="text-sm text-muted-foreground">{q ? "No project matches." : "No projects yet."}</p>}
      </div>
    </AppLayout>
  );
}

/** A title from a goal sentence: "Help me classify chest X-rays." → "Classify chest X-rays". */
export function titleFromGoal(goal: string): string {
  const s = goal
    .trim()
    .replace(/^(please\s+)?(help me( to)?|i want to|i'd like to|i would like to|we want to|let's|lets)\s+/i, "")
    .replace(/[.!?]+$/, "")
    .split(/\n/)[0];
  const t = s.length > 60 ? `${s.slice(0, 57).replace(/\s+\S*$/, "")}…` : s;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Create project (`/projects/new`, docs/ux.md §3): a name or a goal sentence, an optional
 * description and the drop area. Create works with no files at all; attached files ask for
 * the rights attestation, then upload while Overview opens.
 */
export function NewProjectPage() {
  const state = (useLocation().state ?? {}) as NewProjectState;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const add = useUploads((s) => s.add);
  const refresh = useRefreshProject();
  const [title, setTitle] = useState(() => (state.goal ? titleFromGoal(state.goal) : ""));
  const [description, setDescription] = useState(() => (state.goal && titleFromGoal(state.goal) !== state.goal ? state.goal : ""));
  const [picked, setPicked] = useState<Picked | undefined>(state.picked);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [title]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await api<ProjectSummary>("/projects", { method: "POST", json: { title: title.trim(), description: description.trim() } });
      void qc.invalidateQueries({ queryKey: projectKeys.all });
      navigate(projectUrl(p.id));
      // The tray keeps uploading while Overview opens; the attestation dialog comes first.
      if (picked?.files.length) void add(p.id, picked, { onChanged: refresh });
    } catch (e) {
      setError(e instanceof NeedsApiError ? "Creating projects needs the full stack (the API): see docs/running.md" : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppLayout>
      <div className="mx-auto w-full max-w-2xl px-4 py-5 md:px-6 md:py-8">
        <PageHeading title="New project" description="Name it, or say what you're trying to build. You can add data now or later." />
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) void create();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-title">Name or goal</Label>
            <Input id="project-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={EXAMPLE_GOALS[0]} autoFocus data-testid="project-title-input" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-description">Description <span className="text-hint">(optional)</span></Label>
            <Textarea id="project-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="What the data is, and what you want from it" />
          </div>
          {picked?.files.length ? (
            <Card className="flex items-center gap-3 px-4 py-3 text-sm" data-testid="attached">
              <AddDataIcon className="size-4 text-hint" />
              <span className="min-w-0 flex-1">
                {picked.files.length.toLocaleString()} {picked.files.length === 1 ? "file" : "files"} attached
                {picked.skipped > 0 && <span className="text-muted-foreground"> · {picked.skipped} system {picked.skipped === 1 ? "file" : "files"} skipped</span>}
              </span>
              <Button type="button" variant="ghost-secondary" size="icon" onClick={() => setPicked(undefined)} aria-label="Remove attached files">
                <CloseIcon />
              </Button>
            </Card>
          ) : (
            <DropZone onPick={setPicked} title="Drop files or folders here" hint="Optional. Originals are kept exactly as they are; Inkling reads them to find out what's there." />
          )}
          {error && <p className="text-sm text-danger" role="alert">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="lg" onClick={() => navigate(-1)}>Cancel</Button>
            <Button type="submit" size="lg" disabled={!title.trim()} loading={busy} data-testid="create-project">Create</Button>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
