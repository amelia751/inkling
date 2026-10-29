import { Link } from "react-router";
import { Spinner } from "@/components/ui/spinner";
import { SettingsIcon, ErrorIcon, CheckIcon, ExportIcon, MoreIcon, KeyboardIcon, ReviewIcon, SidebarIcon, AiIcon } from "@/components/icons";
import { DatasetSwitcher } from "@/components/layout/dataset-switcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ActionTooltipContent, Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { BrandMark } from "@/components/layout/brand";
import { ThemeSwitch } from "@/components/layout/theme-switch";
import { useTheme, type ThemePreference } from "@/lib/theme";
import { useWindowWidth } from "@/lib/use-media-query";
import { envLabel } from "@/lib/format";
import { useStudio } from "@/stores/studio";
import type { Project } from "@/types";

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
  onShowSettings?: () => void;
}

export function StudioTopBar({ project, onRetrySave, onOpenSidebar, onShowShortcuts, showAi = true, onShowSettings }: StudioTopBarProps) {
  const aiOpen = useStudio((s) => s.aiOpen);
  const env = useStudio((s) => s.env);
  const toggleAi = useStudio((s) => s.toggleAi);

  return (
    <header className="@container flex h-12 shrink-0 items-center gap-2 border-b border-border bg-header text-foreground pl-2 pr-2 @[640px]:gap-3 @[640px]:pl-3.5 @[640px]:pr-3">
      {onOpenSidebar && (
        <Button variant="ghost-secondary" size="icon" onClick={onOpenSidebar} aria-label="Open files and labels">
          <SidebarIcon />
        </Button>
      )}
      <BrandMark compact className="hidden shrink-0 @[480px]:flex" />
      <DatasetSwitcher datasetId={project.id} title={project.title} className="max-w-[min(280px,40cqw)] shrink" />
      <Badge className="hidden @[760px]:inline-flex">Draft</Badge>
      {env && <span className="hidden shrink-0 text-sm text-muted-foreground @[900px]:inline" title={env.modules.map((m) => `${m.id}@${m.version}`).join("\n")}>{envLabel(env)}</span>}
      <SaveIndicator onRetry={onRetrySave} />

      <div className="ml-auto flex shrink-0 items-center gap-1 @[640px]:gap-2">
        <div className="hidden items-center gap-2 @[480px]:flex">
          <Button variant="outline" asChild>
            <Link to={`/datasets/${project.id}/review`} aria-label="Review dataset">
              <ReviewIcon />
              <span className="hidden @[760px]:inline">Review dataset</span>
            </Link>
          </Button>
          <Button asChild>
            <Link to={`/datasets/${project.id}/export`} aria-label="Export dataset">
              <ExportIcon />
              <span className="hidden @[760px]:inline">Export dataset</span>
            </Link>
          </Button>
          <div className="mx-1 h-5 w-px bg-border" aria-hidden />
        </div>
        {showAi && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost-secondary" size="icon" selected={aiOpen} onClick={toggleAi} aria-pressed={aiOpen} aria-label="Inkling AI panel">
                <AiIcon />
              </Button>
            </TooltipTrigger>
            <ActionTooltipContent title={`${aiOpen ? "Hide" : "Show"} Inkling AI`} />
          </Tooltip>
        )}
        {onShowSettings && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost-secondary" size="icon" onClick={onShowSettings} className="hidden @[480px]:inline-flex" aria-label="Environment settings">
                <SettingsIcon />
              </Button>
            </TooltipTrigger>
            <ActionTooltipContent title="Environment settings" description="Viewer and module options for this dataset" />
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost-secondary" size="icon" onClick={onShowShortcuts} className="hidden @[480px]:inline-flex" aria-label="Keyboard shortcuts">
              <KeyboardIcon />
            </Button>
          </TooltipTrigger>
          <ActionTooltipContent title="Keyboard shortcuts" shortcut="showShortcuts" />
        </Tooltip>
        <ThemeSwitch className="hidden @[960px]:inline-flex" />
        <OverflowMenu projectId={project.id} onShowShortcuts={onShowShortcuts} />
      </div>
    </header>
  );
}

function OverflowMenu({ projectId, onShowShortcuts }: { projectId: string; onShowShortcuts: () => void }) {
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
              <Link to={`/datasets/${projectId}/review`}><ReviewIcon /> Review dataset</Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to={`/datasets/${projectId}/export`}><ExportIcon /> Export dataset</Link>
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
