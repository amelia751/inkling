import { Link, useLocation, useNavigate } from "react-router";
import { AddDataIcon, CheckIcon, ChevronDownIcon, ProjectsIcon } from "@studio/ui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@studio/ui/ui/dropdown-menu";
import { useProjectList } from "@/studio/lib/projects-api";
import { projectsUrl, projectUrl, type ProjectSection } from "@/studio/lib/routes";
import { useShell } from "@/studio/stores/shell";
import { cn } from "@studio/ui/utils";

const TRIGGER = "press flex h-7 min-w-0 items-center gap-1 rounded-lg bg-generic py-1.5 pl-[9px] pr-1.5 text-sm text-foreground hover:bg-generic-hover data-[state=open]:bg-generic-hover [outline-offset:-2px]";

/**
 * `Workspace ▾ / Project ▾ / Section` (todo6 Phase 2.2). Both are switchers. The workspace
 * is the person's organization ("Workspace" in UI copy, todo6 D1); one personal workspace
 * for now, so its menu only names it.
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

export function WorkspaceSwitcher({ className }: { className?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={cn(TRIGGER, "max-w-[180px]", className)} aria-label="Workspace: Personal. Switch workspace" data-testid="workspace-switcher">
        <span className="truncate">Personal</span>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[240px]">
        <DropdownMenuLabel className="font-normal text-hint">Workspaces</DropdownMenuLabel>
        <DropdownMenuItem>
          <span className="min-w-0 flex-1 truncate">Personal</span>
          <CheckIcon className="text-brand-heavy" />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-xs text-muted-foreground">Team workspaces arrive with members and roles.</p>
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
    <DropdownMenu>
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
