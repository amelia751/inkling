import { Link } from "react-router";
import { AlertCircle, Check, ChevronRight, Loader2, PanelRight, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BrandMark } from "@/components/layout/brand";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { cn } from "@/lib/utils";
import { useStudio } from "@/stores/studio";
import type { Project } from "@/types";

export function StudioTopBar({ project, onRetrySave }: { project: Project; onRetrySave: () => void }) {
  const aiOpen = useStudio((s) => s.aiOpen);
  const toggleAi = useStudio((s) => s.toggleAi);

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--border-color)] bg-[var(--bg-primary)] px-3">
      <BrandMark />
      <nav className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground" aria-label="Breadcrumb">
        <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        <Link to="/" className="hover:text-foreground">Workspace</Link>
        <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate font-medium text-foreground">{project.title}</span>
      </nav>
      <Badge variant="secondary" className="font-normal">Draft</Badge>
      <SaveIndicator onRetry={onRetrySave} />

      <div className="ml-auto flex items-center gap-1.5">
        <Button variant="outline" size="sm" asChild>
          <Link to={`/datasets/${project.id}/review`}>Review</Link>
        </Button>
        <Button size="sm" asChild>
          <Link to={`/datasets/${project.id}/export`}>Export</Link>
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn("h-8 w-8", aiOpen && "bg-accent text-primary")}
              onClick={toggleAi}
              aria-pressed={aiOpen}
              aria-label="Toggle Inkling AI panel"
            >
              {aiOpen ? <PanelRight className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{aiOpen ? "Hide" : "Show"} Inkling AI</TooltipContent>
        </Tooltip>
        <ThemeToggle />
      </div>
    </header>
  );
}

/** Never says "Saved" until the server has confirmed the write (ui.md §3, top bar). */
function SaveIndicator({ onRetry }: { onRetry: () => void }) {
  const saveState = useStudio((s) => s.saveState);
  const dirty = useStudio((s) => s.dirty);

  if (saveState === "error") {
    return (
      <button onClick={onRetry} className="flex items-center gap-1 text-xs text-state-fail hover:underline">
        <AlertCircle className="h-3.5 w-3.5" /> Not saved · Retry
      </button>
    );
  }
  if (saveState === "saving") {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
      </span>
    );
  }
  if (dirty) return <span className="text-xs text-muted-foreground">Unsaved changes</span>;
  if (saveState === "saved") {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Check className="h-3.5 w-3.5 text-state-pass" /> Saved
      </span>
    );
  }
  return null;
}
