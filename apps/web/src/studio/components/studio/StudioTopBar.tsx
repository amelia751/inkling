import { Link, useParams } from "react-router";
import { Spinner } from "@studio/ui/ui/spinner";
import { ErrorIcon, CheckIcon, ExportIcon, MoreIcon, KeyboardIcon, ReviewIcon, SidebarIcon, AiIcon, ToolIcon } from "@studio/ui/icons";
import { Breadcrumbs } from "@/studio/components/layout/switchers";
import { useCurrentProject } from "@/studio/components/layout/app-layout";
import { useShell } from "@/studio/stores/shell";
import { datasetUrl, projectUrl, settingsUrl } from "@/studio/lib/routes";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@studio/ui/ui/dropdown-menu";
import { ActionTooltipContent, Tooltip, TooltipTrigger } from "@studio/ui/ui/tooltip";
import { BrandMark } from "@/studio/components/layout/brand";
import { ThemeSwitch } from "@/studio/components/layout/theme-switch";
import { useTheme, type ThemePreference } from "@/studio/lib/theme";
import { useWindowWidth } from "@/studio/lib/use-media-query";
import { envLabel } from "@/studio/lib/format";
import { useStudio } from "@/studio/stores/studio";
import type { Project } from "@studio/contracts/types";
import { NAMING } from "@studio/contracts/naming";
import { useVersioning, VersioningControls } from "@/studio/core/versioning";

/**
 * Sizes are container queries on the header, so it adapts to its own width:
 * labels drop to icons below 760px, the theme switch moves into an overflow
 * menu below 960px, and below 480px Review, Export and shortcuts join it.
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
  const versioned = useVersioning((s) => s.enabled && s.datasetId === project.id);
  // The task's project (from the route); a seed's project, dataset and task share one id.
  const routeProject = useCurrentProject({ id: project.id, title: project.title })!;
  const datasetId = useParams().datasetId ?? project.id;
  const p = routeProject.id;

  return (
    <header className="@container flex h-12 shrink-0 items-center gap-2 border-b border-border bg-header text-foreground pl-2 pr-2 @[640px]:gap-3 @[640px]:pl-3.5 @[640px]:pr-3">
      {onOpenSidebar && (
        <Button variant="ghost-secondary" size="icon" onClick={onOpenSidebar} aria-label="Open files and labels">
          <SidebarIcon />
        </Button>
      )}
      {showLeftToggle && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost-secondary" size="icon" selected={leftOpen} onClick={toggleLeft} aria-pressed={leftOpen} aria-label="Files and labels panel" data-testid="toggle-left-panel">
              <SidebarIcon />
            </Button>
          </TooltipTrigger>
          <ActionTooltipContent title={`${leftOpen ? "Hide" : "Show"} files and labels`} shortcut="toggleSidePanel" />
        </Tooltip>
      )}
      <BrandMark compact className="hidden shrink-0 @[480px]:flex" />
      <Breadcrumbs project={routeProject} section={project.title} className="min-w-0 shrink [&_[data-testid=project-switcher]]:max-w-[min(240px,32cqw)]" />
      {!versioned && <Badge className="hidden @[760px]:inline-flex">Draft</Badge>}
      <VersioningControls projectId={project.id} />
      {env && <span className="hidden shrink-0 text-sm text-muted-foreground @[900px]:inline" title={env.modules.map((m) => `${m.id}@${m.version}`).join("\n")}>{envLabel(env)}</span>}
      <SaveIndicator onRetry={onRetrySave} />

      <div className="ml-auto flex shrink-0 items-center gap-1 @[640px]:gap-2">
        <div className="hidden items-center gap-2 @[480px]:flex">
          <Button variant="outline" asChild>
            <Link to={projectUrl(p, "review")} aria-label="Review dataset">
              <ReviewIcon />
              <span className="hidden @[760px]:inline">Review dataset</span>
            </Link>
          </Button>
          <Button asChild>
            <Link to={datasetUrl(p, datasetId, "publish")} aria-label="Export dataset">
              <ExportIcon />
              <span className="hidden @[760px]:inline">Export dataset</span>
            </Link>
          </Button>
          <div className="mx-1 h-5 w-px bg-border" aria-hidden />
        </div>
        {showAi && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost-secondary" size="icon" selected={aiOpen} onClick={toggleAi} aria-pressed={aiOpen} aria-label={`${NAMING.displayName} AI panel`}>
                <AiIcon />
              </Button>
            </TooltipTrigger>
            <ActionTooltipContent title={`${aiOpen ? "Hide" : "Show"} ${NAMING.displayName} AI`} />
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost-secondary" size="icon" className="hidden @[480px]:inline-flex" asChild>
              <Link to={settingsUrl(p, "plugins")} aria-label="Plugins">
                <ToolIcon />
              </Link>
            </Button>
          </TooltipTrigger>
          <ActionTooltipContent title="Plugins" description="Install, disable or roll back plugins in this workspace" />
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost-secondary" size="icon" onClick={onShowShortcuts} className="hidden @[480px]:inline-flex" aria-label="Keyboard shortcuts">
              <KeyboardIcon />
            </Button>
          </TooltipTrigger>
          <ActionTooltipContent title="Keyboard shortcuts" shortcut="showShortcuts" />
        </Tooltip>
        <ThemeSwitch className="hidden @[960px]:inline-flex" />
        <OverflowMenu projectId={p} datasetId={datasetId} onShowShortcuts={onShowShortcuts} />
      </div>
    </header>
  );
}

function OverflowMenu({ projectId, datasetId, onShowShortcuts }: { projectId: string; datasetId: string; onShowShortcuts: () => void }) {
  const { preference, setPreference } = useTheme();
  // The menu renders in a portal, outside the header's container queries.
  const narrow = useWindowWidth() < 480;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost-secondary" size="icon" className="@[960px]:hidden" aria-label="More actions">
          <MoreIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {narrow && (
          <>
            <DropdownMenuItem asChild>
              <Link to={projectUrl(projectId, "review")}><ReviewIcon /> Review dataset</Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to={datasetUrl(projectId, datasetId, "publish")}><ExportIcon /> Export dataset</Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onShowShortcuts}>
              <KeyboardIcon /> Keyboard shortcuts
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel className="font-normal text-hint">Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={preference} onValueChange={(v) => setPreference(v as ThemePreference)}>
          <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">Match system</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Never says "Saved" until the server has confirmed the write (ui.md §3, top bar). */
function SaveIndicator({ onRetry }: { onRetry: () => void }) {
  const saveState = useStudio((s) => s.saveState);
  const dirty = useStudio((s) => s.dirty);

  if (saveState === "error") {
    return (
      <Button variant="ghost" size="sm" onClick={onRetry} className="shrink-0 text-danger hover:text-danger">
        <ErrorIcon /> <span className="hidden @[520px]:inline">Not saved ·</span> Retry
      </Button>
    );
  }
  if (saveState === "saving") {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground" role="status">
        <Spinner /> <span className="hidden @[640px]:inline">Saving…</span>
      </span>
    );
  }
  if (dirty) return <span className="hidden shrink-0 text-sm text-muted-foreground @[640px]:inline" role="status">Unsaved changes</span>;
  if (saveState === "saved") {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground" role="status" aria-label="Saved">
        <CheckIcon className="size-4 text-positive" /> <span className="hidden @[640px]:inline">Saved</span>
      </span>
    );
  }
  return null;
}
