import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DeleteIcon, MoreIcon, ProjectsIcon, RenameIcon, SearchIcon } from "@studio/ui/icons";
import { AppLayout, PageHeading } from "@/studio/components/layout/app-layout";
import { Button } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { Dialog } from "@studio/ui/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@studio/ui/ui/dropdown-menu";
import { EmptyState, NoResults } from "@studio/ui/ui/empty-state";
import { Input } from "@studio/ui/ui/input";
import { SegmentedControl } from "@studio/ui/ui/segmented-control";
import { Skeleton, SkeletonText } from "@studio/ui/ui/skeleton";
import { isSampleTemplate, patchProject, projectKeys, useProjectList } from "@/studio/lib/projects-api";
import { CopyId, Field, invalidProps, SettingsDialog } from "@/studio/components/settings/kit";
import { DeleteProjectDialog } from "@/studio/app/routes/DeletedProjectsPage";
import { NewProjectButton } from "@/studio/app/entry/new-project-dialog";
import { TrySample } from "@/studio/app/entry/sample-picker";
import { relativeTime } from "@/studio/components/files";
import { deletedProjectsUrl, projectUrl } from "@/studio/lib/routes";
import type { DetectedKind, ProjectSummary } from "@studio/contracts/types";
import { KINDS, kindIcon } from "@/studio/lib/file-kinds";

/**
 * Projects (`/projects`, also `/`): like a folder picker. A project starts only from "New project"
 * (a name, then its Overview, where the assistant works inside it). Search and sort.
 */
export function ProjectsPage() {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"recent" | "title">("recent");
  const { data, isLoading, error } = useProjectList(q.trim() || undefined, sort);
  return (
    <AppLayout>
      <div className="mx-auto w-full max-w-6xl px-4 py-5 md:px-6 md:py-6">
        <PageHeading
          title="Projects"
          actions={<NewProjectButton size="lg" variant="default" testId="projects-new-project" />}
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
            <NoProjects />
          ))}
        {!!data?.length && (
          <p className="mt-3 text-sm">
            <Link to={deletedProjectsUrl()} className="text-muted-foreground hover:underline" data-testid="deleted-projects-link">Trash</Link>
          </p>
        )}
      </div>
    </AppLayout>
  );
}

/** No project yet: one way in, "New project". */
export function NoProjects() {
  return (
    <div className="flex flex-col items-center" data-testid="no-projects">
      <EmptyState
        variant="page"
        art="files"
        title="No projects yet"
        description="A project holds your data, its Studios and the assistant's chats."
        actions={<NewProjectButton size="lg" variant="default" />}
      />
      <TrySample className="mt-2" />
    </div>
  );
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

/** A project: the whole card opens it; its ID (copyable) and the ⋯ menu (Rename, Delete) sit on top. */
export function ProjectCard({ project: p }: { project: ProjectSummary }) {
  const [dialog, setDialog] = useState<null | "rename" | "delete">(null);
  const template = isSampleTemplate(p);
  return (
    <Card view="selection" className="relative flex min-h-[148px] flex-col p-4" data-testid="project-card" data-project-id={p.id}>
      <div className="flex items-start gap-3">
        <span className="tile-gradient flex size-10 shrink-0 items-center justify-center rounded-lg">
          <ProjectsIcon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-body-2 font-semibold" title={p.title}>
            <Link to={projectUrl(p.id)} className="after:absolute after:inset-0 after:rounded-lg">{p.title}</Link>
          </h3>
          {p.description && <p className="mt-0.5 truncate text-sm text-muted-foreground">{p.description}</p>}
          <KindTags kinds={p.kinds ?? []} />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost-secondary" size="icon" className="relative z-10 -mr-1 -mt-1 shrink-0" aria-label={`Actions for ${p.title}`} data-testid="project-card-menu">
              <MoreIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            <DropdownMenuItem disabled={template} onSelect={() => setDialog("rename")} data-testid="project-card-rename">
              <RenameIcon /> Rename…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={template} className="text-danger" onSelect={() => setDialog("delete")} data-testid="project-card-delete">
              <DeleteIcon /> Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="mt-auto flex items-center gap-2 pt-3 text-sm text-muted-foreground">
        <CopyId id={p.id} className="relative z-10 min-w-0" />
        <span className="shrink-0 text-hint">·</span>
        <span className="min-w-0 flex-1 truncate">Edited {relativeTime(p.lastActivityAt)}</span>
      </div>
      <RenameProjectDialog project={p} open={dialog === "rename"} onOpenChange={(o) => setDialog(o ? "rename" : null)} />
      <DeleteProjectDialog projectId={p.id} name={p.title} open={dialog === "delete"} onOpenChange={(o) => setDialog(o ? "delete" : null)} stay />
    </Card>
  );
}

function RenameProjectDialog({ project, open, onOpenChange }: { project: ProjectSummary; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(project.title);
  const save = useMutation({
    mutationFn: (title: string) => patchProject(project.id, { title }),
    onSuccess: () => (void qc.invalidateQueries({ queryKey: projectKeys.all }), onOpenChange(false)),
  });
  const { reset } = save;
  useEffect(() => {
    if (!open) return;
    setName(project.title);
    reset();
  }, [open, project.title, reset]);
  const trimmed = name.trim();
  const submit = () => trimmed && trimmed !== project.title && save.mutate(trimmed);
  const error = save.error ? String(save.error instanceof Error ? save.error.message : save.error) : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SettingsDialog
        title="Rename project"
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button loading={save.isPending} disabled={!trimmed || trimmed === project.title} onClick={submit} data-testid="rename-project-save">Save</Button>
          </>
        }
      >
        <Field label="Name" htmlFor="rename-project-name" error={error}>
          <Input
            id="rename-project-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), submit())}
            autoFocus
            maxLength={200}
            data-testid="rename-project-name"
            {...invalidProps("rename-project-name", error)}
          />
        </Field>
      </SettingsDialog>
    </Dialog>
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
