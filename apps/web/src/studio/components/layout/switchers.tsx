import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AddDataIcon, AnnotateIcon, CheckIcon, ChevronDownIcon, ProjectsIcon, SettingsIcon } from "@studio/ui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@studio/ui/ui/dropdown-menu";
import { Loader } from "@studio/ui/ui/loader";
import { useDatasets, useProjectList, useProjectSummary } from "@/studio/lib/projects-api";
import { mockSession, resetForOrg, switchOrg, useSession, type SessionOrg } from "@/studio/lib/session";
import { projectsUrl, projectUrl, studioUrl, taskSetupUrl, type ProjectSection } from "@/studio/lib/routes";
import { useShell } from "@/studio/stores/shell";
import { cn } from "@studio/ui/utils";

const TRIGGER = "press flex h-7 min-w-0 items-center gap-1 rounded-lg bg-generic py-1.5 pl-[9px] pr-1.5 text-sm text-foreground hover:bg-generic-hover data-[state=open]:bg-generic-hover [outline-offset:-2px]";

/**
 * `Workspace ▾ / Project ▾ / Section` (todo6 Phase 2.2). Both are switchers. The workspace
 * is the person's organization ("Workspace" in UI copy, todo6 D1): the menu lists the
 * session's organizations, and picking one switches the session to it (todo9 Phase 4).
 */
export function Breadcrumbs({ project, section, className }: { project?: { id: string; title: string }; section?: string; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={cn("flex min-w-0 items-center gap-1.5 text-sm", className)} data-testid="breadcrumb">
      <WorkspaceSwitcher className={cn(project && "max-md:hidden")} />
      {project && (
        <>
          <span className="text-hint max-md:hidden" aria-hidden>/</span>
          <ProjectSwitcher projectId={project.id} title={project.title} />
        </>
      )}
      {project && section && (
        <>
          <span className="text-hint max-sm:hidden" aria-hidden>/</span>
          <span className="truncate text-muted-foreground max-sm:hidden" aria-current="page">{section}</span>
        </>
      )}
    </nav>
  );
}

/** The stored name of a personal organization (apps/api `PERSONAL_ORG_NAME`). */
const PERSONAL = "Personal";

/**
 * todo14 D1: a personal organization reads "<First name>'s workspace"; a team org its own name.
 * Without a first name (dev principals, the seed-mode mock account) it stays "Personal".
 */
export function workspaceName(org: SessionOrg | undefined, firstName: string | null | undefined): string {
  if (!org) return PERSONAL;
  return org.name === PERSONAL && firstName?.trim() ? `${firstName.trim()}'s workspace` : org.name;
}

export function WorkspaceSwitcher({ className }: { className?: string }) {
  const { organization, organizations, user } = useSession();
  // The mock account (seed mode, dev without sessions) isn't a person: keep its org "Personal".
  const first = user.id === mockSession().user.id ? null : user.firstName;
  const name = workspaceName(organization, first);
  const client = useQueryClient();
  const navigate = useNavigate();
  const [switching, setSwitching] = useState<string | null>(null);
  const pick = async (id: string) => {
    if (id === organization.id || switching) return;
    setSwitching(id);
    try {
      const { redirect } = await switchOrg(id);
      // The organization needs its own sign-in (SSO, MFA): the API comes back here after it.
      if (redirect) return window.location.assign(redirect);
      await resetForOrg(client);
      navigate("/");
    } catch (e) {
      toast.error("Couldn't switch workspace", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSwitching(null);
    }
  };
  // Ours first, then the rest by name.
  const orgs = [organization, ...organizations.filter((o) => o.id !== organization.id).sort((a, b) => a.name.localeCompare(b.name))];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={cn(TRIGGER, "max-w-[180px]", className)} aria-label={`Workspace: ${name}. Switch workspace`} data-testid="workspace-switcher">
        <span className="truncate">{name}</span>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[240px]">
        <DropdownMenuLabel className="font-normal text-hint">Workspaces</DropdownMenuLabel>
        {orgs.map((o) => {
          const current = o.id === organization.id;
          return (
            <DropdownMenuItem key={o.id} disabled={!!switching} onSelect={() => void pick(o.id)} data-testid={`switch-org-${o.id}`} aria-current={current || undefined}>
              <span className="min-w-0 flex-1 truncate">{workspaceName(o, first)}</span>
              {switching === o.id ? <Loader size="s" /> : current && <CheckIcon className="text-brand-heavy" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Names the open project and switches to another one, staying on the same section. */
export function ProjectSwitcher({ projectId, title, className }: { projectId: string; title: string; className?: string }) {
  const { data: projects } = useProjectList();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const setNewProject = useShell((s) => s.setNewProject);
  const section = (/^\/projects\/[^/]+\/([^/]+)/.exec(pathname)?.[1] ?? "overview") as ProjectSection;

  return (
    // Keyed by project: switching mounts a fresh menu, so the old one's closing animation (whose
    // dismiss layer is still live) can't swallow the next click on the trigger and close it again.
    <DropdownMenu key={projectId}>
      <DropdownMenuTrigger className={cn(TRIGGER, "max-w-[min(280px,40vw)]", className)} aria-label={`Project: ${title}. Switch project`} data-testid="project-switcher">
        <span className="truncate">{title}</span>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[280px]">
        <DropdownMenuLabel className="font-normal text-hint">Projects</DropdownMenuLabel>
        {projects?.slice(0, 12).map((p) => {
          const current = p.id === projectId;
          return (
            // Same section in the other project, never a deep id (its nodes and tasks differ).
            <DropdownMenuItem key={p.id} onSelect={() => !current && navigate(projectUrl(p.id, section))} data-testid={`switch-project-${p.id}`}>
              <ProjectsIcon className="text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{p.title}</span>
              {current && <CheckIcon className="text-brand-heavy" />}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to={projectsUrl()}>
            <ProjectsIcon className="text-muted-foreground" /> All projects
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setNewProject(true)} data-testid="switcher-new-project">
          <AddDataIcon className="text-muted-foreground" /> New project
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The Studio header's task switcher (todo8 D1): names the open task and lists the project's
 * other tasks with their progress, plus "Task setup…". The preset's title (`2D image`) is the
 * subtitle of the current task here, not a header status. With `compact` (the task has the
 * project's title, which the header already shows) the trigger is the chevron alone.
 */
export function TaskSwitcher({ projectId, taskId, title, subtitle, compact = false, className }: { projectId: string; taskId: string; title: string; subtitle?: string; compact?: boolean; className?: string }) {
  const navigate = useNavigate();
  // The project's tasks, from its datasets (the same lists Overview and Datasets read).
  // Only for a listed project: a Studio opened on a bare environment (no project) has no datasets.
  const listed = !!useProjectSummary(projectId).data;
  const { data: datasets } = useDatasets(projectId, { enabled: listed });
  // Progress is items with at least one annotation (a dataset's file count isn't its item count:
  // a CT study is one item and hundreds of files).
  const tasks: { id: string; title: string; annotatedItems?: number }[] = datasets?.flatMap((d) => d.tasks) ?? [];
  if (!tasks.some((t) => t.id === taskId)) tasks.unshift({ id: taskId, title });

  return (
    <DropdownMenu key={taskId}>
      <DropdownMenuTrigger
        className={cn(compact ? "press flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-generic-hover data-[state=open]:bg-generic-hover [outline-offset:-2px]" : cn(TRIGGER, "max-w-[min(280px,32cqw)] bg-transparent"), className)}
        aria-label={`Task: ${title}. Switch task`}
        data-testid="task-switcher"
      >
        {!compact && <span className="truncate">{title}</span>}
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[300px]">
        <DropdownMenuLabel className="font-normal text-hint">Tasks</DropdownMenuLabel>
        {tasks.slice(0, 20).map((t) => {
          const current = t.id === taskId;
          return (
            <DropdownMenuItem key={t.id} onSelect={() => !current && navigate(studioUrl(projectId, t.id))} data-testid={`switch-task-${t.id}`} className="items-start">
              <AnnotateIcon className="mt-0.5 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{t.title}</span>
                {current && subtitle && <span className="block truncate text-xs text-muted-foreground" data-testid="task-subtitle">{subtitle}</span>}
              </span>
              {t.annotatedItems !== undefined && (
                <span className="tnum shrink-0 text-xs text-muted-foreground" data-testid="task-progress">
                  {t.annotatedItems} done
                </span>
              )}
              {current && <CheckIcon className="text-brand-heavy" />}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to={taskSetupUrl(projectId, taskId)} data-testid="switcher-task-setup">
            <SettingsIcon className="text-muted-foreground" /> Task setup…
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
