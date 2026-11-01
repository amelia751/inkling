import { Link, useParams } from "react-router";
import { ExportIcon, MoreIcon, KeyboardIcon, ReviewIcon, SidebarIcon, AiIcon, ToolIcon, SettingsIcon, LightThemeIcon, SecurityIcon, DoneIcon } from "@studio/ui/icons";
import { toast } from "sonner";
import { kernelEnabled } from "@/extension-host/kernel";
import { markKnownGood } from "@/studio/lib/safe-mode";
import { TaskSwitcher } from "@/studio/components/layout/switchers";
import { AskButton } from "@/studio/components/ai/ask-button";
import { useCurrentProject } from "@/studio/components/layout/app-layout";
import { useShell } from "@/studio/stores/shell";
import { datasetUrl, projectUrl, settingsUrl, taskSetupUrl } from "@/studio/lib/routes";
import { Button } from "@studio/ui/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@studio/ui/ui/dropdown-menu";
import { ActionTooltipContent, Tooltip, TooltipTrigger } from "@studio/ui/ui/tooltip";
import { useTheme, type ThemePreference } from "@/studio/lib/theme";
import { envLabel } from "@/studio/lib/format";
import { useWindowWidth } from "@/studio/lib/use-media-query";
import { useStudio } from "@/studio/stores/studio";
import type { Project } from "@studio/contracts/types";
import { NAMING } from "@studio/contracts/naming";
import { BootPill } from "@/studio/components/layout/boot-status";
import { RequestReview, StaleNotice, useDraftHasChanges, useVersioning, WorkStateChip } from "@/studio/core/versioning";

/**
 * The Studio header (todo8 D1): three zones and at most 7 controls at 1440px (guarded by
 * `e2e/studio_layout_test.py`, todo8 D10). A new control replaces one or goes in ⋯.
 *
 * - **Where am I**: the left-panel toggle, the project (a link to its Overview), the task switcher.
 * - **State of my work**: the work-state chip (save state + draft / published), and the
 *   stale-head notice when someone else saved (loud, separate).
 * - **The one next step**: Request review (versioning on, draft has changes) or Export (outline),
 *   then the AI toggle and ⋯ (Export…, Task setup…, Keyboard shortcuts, Plugins, Theme, project Review).
 *
 * Sizes are container queries on the header, so it adapts to its own width: labels drop to
 * icons below 760px, and below 480px the task switcher collapses to its chevron.
 */
interface StudioTopBarProps {
  project: Project;
  onRetrySave: () => void;
  /** Set on phones, where the sidebar is a drawer. */
  onOpenSidebar?: () => void;
  onShowShortcuts: () => void;
  /** The environment has right-slot panels (the assistant) to toggle. */
  showAi?: boolean;
  /** Offer the left panel's show / hide toggle (tablet and desktop). */
  showLeftToggle?: boolean;
}

export function StudioTopBar({ project, onRetrySave, onOpenSidebar, onShowShortcuts, showAi = true, showLeftToggle = false }: StudioTopBarProps) {
  const leftOpen = useShell((s) => s.studioLeft);
  const toggleLeft = useShell((s) => s.toggleStudioLeft);
  const aiOpen = useStudio((s) => s.aiOpen);
  const env = useStudio((s) => s.env);
  const toggleAi = useStudio((s) => s.toggleAi);
  // The task's project (from the route); a seed's project, dataset and task share one id.
  const routeProject = useCurrentProject({ id: project.id, title: project.title })!;
  const datasetId = useParams().datasetId ?? project.id;
  const p = routeProject.id;
  const readOnly = useVersioning((s) => s.enabled && s.datasetId === project.id && s.readOnly);
  // The one primary action follows the stage: Request review when there is a draft to review.
  const reviewFirst = useDraftHasChanges(project.id);
  const sameTitle = project.title.trim().toLowerCase() === routeProject.title.trim().toLowerCase();

  return (
    <header className="@container flex h-12 shrink-0 items-center gap-2 border-b border-border bg-header pl-2 pr-2 text-foreground @[640px]:gap-6 @[640px]:pl-3.5 @[640px]:pr-3" data-testid="studio-header">
      {/* Where am I */}
      <div className="flex min-w-0 shrink items-center gap-1.5">
        {onOpenSidebar && (
          <Button variant="ghost-secondary" size="icon" onClick={onOpenSidebar} aria-label="Open items and labels">
            <SidebarIcon />
          </Button>
        )}
        {showLeftToggle && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost-secondary" size="icon" selected={leftOpen} onClick={toggleLeft} aria-pressed={leftOpen} aria-label="Items and labels panel" data-testid="toggle-left-panel">
                <SidebarIcon />
              </Button>
            </TooltipTrigger>
            <ActionTooltipContent title={`${leftOpen ? "Hide" : "Show"} items and labels`} shortcut="toggleSidePanel" />
          </Tooltip>
        )}
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm" data-testid="breadcrumb">
          <Link
            to={projectUrl(p)}
            className="truncate rounded-md px-1.5 py-1 font-medium text-foreground hover:bg-generic-hover [outline-offset:-2px] max-w-[min(280px,32cqw)]"
            data-testid="studio-project-link"
            title={`${routeProject.title}: project overview`}
          >
            {routeProject.title}
          </Link>
          {!sameTitle && <span className="text-hint" aria-hidden>›</span>}
          <TaskSwitcher projectId={p} taskId={project.id} title={project.title} subtitle={env ? envLabel(env) : undefined} compact={sameTitle} />
        </nav>
      </div>

      {/* The state of my work */}
      <div className="flex min-w-0 shrink-0 items-center gap-2">
        <WorkStateChip projectId={project.id} onRetry={onRetrySave} />
        <StaleNotice projectId={project.id} />
      </div>

      {/* The one next step */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <BootPill className="max-md:hidden" />
        {reviewFirst ? (
          <RequestReview projectId={project.id} />
        ) : (
          !readOnly && (
            <Button variant="outline" className="hidden @[480px]:inline-flex" asChild>
              <Link to={datasetUrl(p, datasetId, "publish")} aria-label="Export" data-testid="studio-export">
                <ExportIcon />
                <span className="hidden @[760px]:inline">Export</span>
              </Link>
            </Button>
          )
        )}
        <div className="flex items-center gap-1">
          {showAi && (
            <AskButton
              open={aiOpen}
              onToggle={toggleAi}
              labelClassName="hidden @[760px]:inline"
              tooltip={<ActionTooltipContent title={aiOpen ? "Close Assistant" : "Launch Assistant"} />}
            />
          )}
          <MoreMenu projectId={p} taskId={project.id} datasetId={datasetId} exportInMenu={reviewFirst || readOnly} onShowShortcuts={onShowShortcuts} />
        </div>
      </div>
    </header>
  );
}

/** ⋯: everything that isn't this task's next step, each in one home (todo8 D1). */
function MoreMenu({ projectId, taskId, datasetId, exportInMenu, onShowShortcuts }: { projectId: string; taskId: string; datasetId: string; exportInMenu: boolean; onShowShortcuts: () => void }) {
  const { preference, setPreference } = useTheme();
  // The menu renders in a portal, outside the header's container queries: below 480px the
  // header's Export button is hidden, so Export is always here then.
  const narrow = useWindowWidth() < 480;
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost-secondary" size="icon" aria-label="More actions" data-testid="studio-more">
              <MoreIcon />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <ActionTooltipContent title="More" />
      </Tooltip>
      <DropdownMenuContent align="end" className="w-60">
        {(exportInMenu || narrow) && (
          <DropdownMenuItem asChild>
            <Link to={datasetUrl(projectId, datasetId, "publish")} data-testid="menu-export">
              <ExportIcon /> Export…
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <Link to={taskSetupUrl(projectId, taskId)} data-testid="menu-task-setup">
            <SettingsIcon /> Task setup…
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onShowShortcuts} data-testid="menu-shortcuts">
          <KeyboardIcon /> Keyboard shortcuts
          <DropdownMenuShortcut>?</DropdownMenuShortcut>
        </DropdownMenuItem>
        {/* A real link (role), so "the Plugins link" stays one thing to find for people and tests. */}
        <DropdownMenuItem asChild role="link">
          <Link to={settingsUrl(projectId, "plugins")} data-testid="menu-plugins">
            <ToolIcon /> Plugins
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger data-testid="menu-theme">
            <LightThemeIcon /> Theme
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={preference} onValueChange={(v) => setPreference(v as ThemePreference)}>
              <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">Match system</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        {/* todo10 §3.4: the known-good baseline safe mode and rollback return to. */}
        {kernelEnabled() && (
          <DropdownMenuItem onSelect={() => void markKnownGood(taskId).then((r) => toast(r.moved ? "This setup is now the last known good one" : (r.reason ?? "Unchanged"))).catch((e) => toast(`Couldn't mark it: ${e instanceof Error ? e.message : String(e)}`))} data-testid="menu-known-good">
            <DoneIcon /> Mark setup as known good
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <a href={`${window.location.pathname}?safe`} data-testid="menu-safe-mode">
            <SecurityIcon /> Restart in safe mode
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to={projectUrl(projectId, "review")} data-testid="menu-project-review">
            <ReviewIcon /> Open project Review
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
