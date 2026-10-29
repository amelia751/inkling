import { BetweenVerticalStart, CircleDot, Crosshair, Hand, MousePointer2, MoveHorizontal, Pentagon, Redo2, Square, Undo2, type LucideIcon } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { labelColor } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { useStudio, type Tool } from "@/stores/studio";
import type { Project } from "@/types";

export const TOOL_META: Record<Tool, { label: string; hint: string; key: string; icon: LucideIcon }> = {
  select: { label: "Select", hint: "Select and inspect annotations", key: "V", icon: MousePointer2 },
  pan: { label: "Pan", hint: "Drag to move the image; scroll to zoom", key: "H", icon: Hand },
  box: { label: "Box", hint: "Drag to outline a region with the active label", key: "B", icon: Square },
  point: { label: "Point", hint: "Click to mark a 3D location with the active label", key: "P", icon: Crosshair },
  interval: { label: "Interval", hint: "Drag across a lead to mark a time span", key: "I", icon: MoveHorizontal },
  polygon: { label: "Contour", hint: "Click to place points; click the first point or double-click to close. Esc cancels", key: "C", icon: Pentagon },
  mark: { label: "Mark", hint: "Click to mark a single location, e.g. a cell", key: "M", icon: CircleDot },
  segment: { label: "Segment", hint: "Drag along the timeline to label a span of the video", key: "S", icon: BetweenVerticalStart },
};

export function CanvasToolbar({ project, tools }: { project: Project; tools: Tool[] }) {
  const tool = useStudio((s) => s.tool);
  const setTool = useStudio((s) => s.setTool);
  const activeLabel = useStudio((s) => s.activeLabel);
  const undo = useStudio((s) => s.undo);
  const redo = useStudio((s) => s.redo);
  const canUndo = useStudio((s) => s.past.length > 0);
  const canRedo = useStudio((s) => s.future.length > 0);
  const labels = project.labels ?? [];
  const drawing = tool !== "select" && tool !== "pan";

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--border-color)] bg-[var(--bg-primary)] px-2" role="toolbar" aria-label="Annotation tools">
      {tools.map((t) => {
        const meta = TOOL_META[t];
        return (
          <Tooltip key={t}>
            <TooltipTrigger asChild>
              <button
                onClick={() => setTool(t)}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors",
                  tool === t ? "bg-primary text-primary-foreground" : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-foreground",
                )}
                aria-pressed={tool === t}
              >
                <meta.icon className="h-3.5 w-3.5" />
                {meta.label}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {meta.hint} <kbd className="ml-1 font-mono opacity-70">{meta.key}</kbd>
            </TooltipContent>
          </Tooltip>
        );
      })}
      <Separator orientation="vertical" className="mx-1 h-5" />
      <IconAction icon={Undo2} label="Undo" shortcut="⌘Z" onClick={undo} disabled={!canUndo} />
      <IconAction icon={Redo2} label="Redo" shortcut="⇧⌘Z" onClick={redo} disabled={!canRedo} />
      {drawing && activeLabel && (
        <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          Drawing
          <span className="flex items-center gap-1 rounded-md bg-[var(--bg-secondary)] px-2 py-0.5 capitalize text-foreground">
            <span className="h-2 w-2 rounded-full" style={{ background: labelColor(labels, activeLabel) }} />
            {activeLabel}
          </span>
        </div>
      )}
    </div>
  );
}

function IconAction({ icon: Icon, label, shortcut, onClick, disabled }: { icon: LucideIcon; label: string; shortcut: string; onClick: () => void; disabled: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {label} <kbd className="ml-1 font-mono opacity-70">{shortcut}</kbd>
      </TooltipContent>
    </Tooltip>
  );
}
