import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useNavigate, useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AppLayout, NestedPage, PageHeading } from "@/studio/components/layout/app-layout";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@studio/ui/ui/alert-dialog";
import { Alert } from "@studio/ui/ui/alert";
import { Button } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { Input } from "@studio/ui/ui/input";
import { Label } from "@studio/ui/ui/label";
import { RadioGroup, RadioGroupItem } from "@studio/ui/ui/radio-group";
import { Skeleton, SkeletonText } from "@studio/ui/ui/skeleton";
import { Textarea } from "@studio/ui/ui/textarea";
import { cn } from "@studio/ui/utils";
import type { ProjectSummary } from "@studio/contracts/types";
import { isSampleTemplate, NeedsApiError, patchProject, projectKeys, useProjectDetail } from "@/studio/lib/projects-api";
import { projectsUrl, settingsUrl } from "@/studio/lib/routes";
import { PluginsPage } from "./PluginsPage";
import { ProjectMembers } from "./settings/ProjectMembers";
import { RulesEditor } from "./settings/RulesEditor";
import { DeleteProjectDialog } from "./DeletedProjectsPage";

type SettingsTab = "general" | "members" | "rules" | "plugins";

/**
 * Project settings (todo6 Phase 8, D10): General (title, description, visibility, archive),
 * Members (project Team & Access, mocked until WorkOS: todo/todo9.md), Rules (todo17 D3) and Plugins (what used
 * to be the dataset's Plugins page).
 */
export function ProjectSettingsPage() {
  const { projectId = "", tab = "general" } = useParams();
  const current: SettingsTab = tab === "plugins" || tab === "members" || tab === "rules" ? tab : "general";
  return (
    <AppLayout>
      <div className="mx-auto w-full max-w-5xl px-4 py-5 md:px-6 md:py-6" data-testid="settings-page" data-tab={current}>
        <PageHeading title="Settings" />
        <nav className="mb-5 flex items-end gap-6 overflow-x-auto shadow-[inset_0_-1px_0_0_var(--g-line)] hide-scrollbar" aria-label="Settings sections">
          <TabLink to={settingsUrl(projectId, "general")}>General</TabLink>
          <TabLink to={settingsUrl(projectId, "members")}>Members</TabLink>
          <TabLink to={settingsUrl(projectId, "rules")}>Rules</TabLink>
          <TabLink to={settingsUrl(projectId, "plugins")}>Plugins</TabLink>
        </nav>
        {current === "general" ? (
          <General projectId={projectId} />
        ) : current === "members" ? (
          <ProjectMembers projectId={projectId} />
        ) : current === "rules" ? (
          <RulesEditor projectId={projectId} />
        ) : (
          <NestedPage>
            <PluginsPage />
          </NestedPage>
        )}
      </div>
    </AppLayout>
  );
}

function TabLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <NavLink to={to} className={({ isActive }) => cn("flex h-9 shrink-0 items-center whitespace-nowrap border-b-2 pt-0.5 text-sm transition-colors hover:text-foreground", isActive ? "border-brand text-foreground" : "border-transparent text-muted-foreground")}>
      {children}
    </NavLink>
  );
}

function General({ projectId }: { projectId: string }) {
  const project = useProjectDetail(projectId);
  if (project.isLoading)
    return (
      <Card className="p-4" aria-busy data-testid="settings-general-skeleton">
        <div className="flex max-w-xl flex-col gap-4">
          {["h-9", "h-20", "h-14"].map((h, i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <SkeletonText className="w-24" />
              <Skeleton className={`${h} w-full rounded-md`} />
            </div>
          ))}
          <Skeleton className="h-9 w-20 rounded-md" />
        </div>
      </Card>
    );
  if (project.error || !project.data) return <p className="text-sm text-muted-foreground">Couldn't load the project: {String(project.error)}</p>;
  return <GeneralForm project={project.data} />;
}

function GeneralForm({ project }: { project: ProjectSummary }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [title, setTitle] = useState(project.title);
  const [description, setDescription] = useState(project.description);
  const [visibility, setVisibility] = useState(project.visibility);
  const [saved, setSaved] = useState(false);
  useEffect(() => setSaved(false), [title, description, visibility]);
  const refresh = () => void qc.invalidateQueries({ queryKey: projectKeys.all });
  const save = useMutation({
    mutationFn: () => patchProject(project.id, { title: title.trim(), description, visibility }),
    onSuccess: (p) => {
      qc.setQueryData(projectKeys.one(project.id), p);
      refresh();
      setSaved(true);
    },
  });
  const archive = useMutation({
    mutationFn: (archived: boolean) => patchProject(project.id, { archived }),
    onSuccess: (p) => {
      qc.setQueryData(projectKeys.one(project.id), p);
      refresh();
      if (p.archived) navigate(projectsUrl());
    },
  });
  const dirty = title.trim() !== project.title || description !== project.description || visibility !== project.visibility;
  // A template is read-only (todo14 D7); a person's copy of one is theirs to change.
  const readOnly = isSampleTemplate(project);
  const error = save.error ?? archive.error;

  return (
    <div className="flex flex-col gap-4">
      {readOnly && <p className="rounded-md bg-info-tint px-3 py-2 text-sm" data-testid="sample-readonly">This is a sample project: its details can't be changed.</p>}
      <Card className="p-4">
        <form
          className="flex max-w-xl flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty && title.trim()) save.mutate();
          }}
          data-testid="settings-general"
        >
          <div className="grid gap-1.5">
            <Label htmlFor="project-title">Name</Label>
            <Input id="project-title" value={title} onChange={(e) => setTitle(e.target.value)} disabled={readOnly} required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="project-description">Description</Label>
            <Textarea id="project-description" value={description} onChange={(e) => setDescription(e.target.value)} disabled={readOnly} rows={3} placeholder="What this project is for" />
          </div>
          <fieldset className="grid gap-2" disabled={readOnly}>
            <legend className="mb-1 text-sm font-medium">Visibility</legend>
            <RadioGroup value={visibility} onValueChange={(v) => setVisibility(v as ProjectSummary["visibility"])}>
              <label className="flex items-start gap-2 text-sm">
                <RadioGroupItem value="private" className="mt-0.5" data-testid="visibility-private" />
                <span>
                  Private <span className="block text-muted-foreground">Only you.</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <RadioGroupItem value="shared" className="mt-0.5" data-testid="visibility-shared" />
                <span>
                  Shared <span className="block text-muted-foreground">Everyone in your workspace can open it.</span>
                </span>
              </label>
            </RadioGroup>
          </fieldset>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={readOnly || !dirty || !title.trim() || save.isPending} data-testid="save-settings">Save changes</Button>
            {saved && !dirty && <span className="text-sm text-muted-foreground" data-testid="settings-saved">Saved.</span>}
          </div>
        </form>
      </Card>

      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="max-w-xl">
          <h2 className="text-sm font-medium">{project.archived ? "Archived" : "Archive this project"}</h2>
          <p className="text-sm text-muted-foreground">
            {project.archived ? "It's hidden from Home and Projects. Restore it to work on it again." : "Hides it from Home and Projects. Nothing is deleted, and you can restore it here."}
          </p>
        </div>
        {project.archived ? (
          <Button variant="outline" disabled={readOnly || archive.isPending} onClick={() => archive.mutate(false)} data-testid="unarchive-project">Restore</Button>
        ) : (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" disabled={readOnly || archive.isPending} data-testid="archive-project">Archive</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Archive {project.title}?</AlertDialogTitle>
                <AlertDialogDescription>It disappears from Home and Projects. Its sources, datasets and annotations stay as they are.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => archive.mutate(true)} data-testid="confirm-archive">Archive</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </Card>
      <DangerZone projectId={project.id} name={project.title} disabled={readOnly} />
      {error && (
        <Alert theme="danger">
          {error instanceof NeedsApiError ? "Changing a project needs the full stack: see docs/running.md" : error.message}
        </Alert>
      )}
    </div>
  );
}

/** Settings › Danger zone (todo16 D6): Delete project moves it to Deleted projects for 30 days. */
function DangerZone({ projectId, name, disabled }: { projectId: string; name: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3 border-danger/40 p-4" data-testid="danger-zone">
      <div className="max-w-xl">
        <h2 className="text-sm font-medium">Delete this project</h2>
        <p className="text-sm text-muted-foreground">Moves it to Deleted projects for 30 days, with its sources, datasets, Studios and annotations. Then it's gone.</p>
      </div>
      <Button variant="destructive" disabled={disabled} onClick={() => setOpen(true)} data-testid="delete-project">Delete project</Button>
      <DeleteProjectDialog projectId={projectId} name={name} open={open} onOpenChange={setOpen} />
    </Card>
  );
}
