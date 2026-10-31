import { useRef, useState } from "react";
import { AiIcon, SearchIcon, SourcesIcon, WarningIcon, RelationshipIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { Sheet, SheetContent } from "@studio/ui/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@studio/ui/ui/tooltip";
import { NAMING } from "@studio/contracts/naming";
import { AssistantPanel } from "@/studio/components/ai/assistant-panel";
import { CARD_TOOL_NAMES, runCardTool } from "@/studio/lib/agent/card-tools";
import { currentProvider, useAgentContextStore, type AgentSection } from "@/studio/lib/agent/providers";
import { ENV_TOOL_NAMES } from "@/studio/lib/agent/session";
import { useOverview, useProjectSummary } from "@/studio/lib/projects-api";
import { useViewport } from "@/studio/lib/use-media-query";
import type { ClientToolOutcome } from "@/studio/stores/agent";
import { ASSISTANT_WIDTH, clampAssistantWidth, useShell } from "@/studio/stores/shell";

const SECTIONS = new Set<AgentSection>(["overview", "sources", "explore", "datasets", "studio", "review", "activity", "settings"]);
export const agentSection = (s: string | undefined): AgentSection => (s && SECTIONS.has(s as AgentSection) ? (s as AgentSection) : "overview");

/** Outside the Studio only project cards run; environment tools need the open Studio. */
async function runProjectTool(name: string, input: Record<string, unknown>): Promise<ClientToolOutcome> {
  if (CARD_TOOL_NAMES.has(name)) return runCardTool(name, input);
  if (ENV_TOOL_NAMES.has(name)) return { ok: false, output: { error: "The Studio isn't open, so its environment can't be read or changed. Offer open_location to the Studio instead." }, summary: "Needs the Studio" };
  return { ok: false, output: { error: `Unknown client tool ${name}.` } };
}

/** The header's AI button outside the Studio (the Studio has its own in its top bar). */
export function AssistantToggle() {
  const open = useShell((s) => s.assistantOpen);
  const toggle = useShell((s) => s.toggleAssistant);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost-secondary" selected={open} onClick={toggle} aria-pressed={open} aria-label={`${NAMING.displayName} AI panel`} data-testid="assistant-toggle">
          <AiIcon />
          <span className="max-sm:hidden">Assistant</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{open ? "Close Assistant" : "Launch Assistant"}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The assistant in the project shell (todo6 Phase 6, docs/ux.md §11 `PersistentAgentDrawer`):
 * a 340px column on the right (drag its edge: 300–480px), a sheet below desktop. Open state and
 * width are remembered per person (shell store); `toggleAssistant` (mod+j) and the header's AI
 * button open and close it. The thread is the project's, shared with the Studio's AI panel.
 */
export function PersistentAgentDrawer({ project, section }: { project: { id: string; title: string }; section: string | undefined }) {
  const open = useShell((s) => s.assistantOpen);
  const setAssistant = useShell((s) => s.setAssistant);
  const desktop = useViewport() === "desktop";
  if (!open) return null;
  const panel = <DrawerPanel project={project} section={agentSection(section)} onClose={() => setAssistant(false)} />;
  if (!desktop)
    return (
      <Sheet open onOpenChange={(o) => !o && setAssistant(false)}>
        <SheetContent side="right" title={`${NAMING.displayName} AI`} showClose={false} className="flex w-[min(400px,92vw)] flex-col p-0">
          {panel}
        </SheetContent>
      </Sheet>
    );
  return <ResizableColumn>{panel}</ResizableColumn>;
}

function ResizableColumn({ children }: { children: React.ReactNode }) {
  const width = useShell((s) => s.assistantWidth);
  const setWidth = useShell((s) => s.setAssistantWidth);
  const [drag, setDrag] = useState<number | null>(null);
  const start = useRef({ x: 0, w: 0 });
  const shown = drag ?? width;
  return (
    <div className="relative flex min-h-0 shrink-0 border-l border-border" style={{ width: shown }} data-testid="agent-drawer">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize assistant"
        aria-valuemin={ASSISTANT_WIDTH.min}
        aria-valuemax={ASSISTANT_WIDTH.max}
        aria-valuenow={shown}
        tabIndex={0}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-generic-accent/60 focus-visible:bg-generic-accent"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          start.current = { x: e.clientX, w: width };
          setDrag(width);
        }}
        onPointerMove={(e) => drag !== null && setDrag(clampAssistantWidth(start.current.w + start.current.x - e.clientX))}
        onPointerUp={() => {
          if (drag !== null) setWidth(drag);
          setDrag(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setWidth(width + 20);
          if (e.key === "ArrowRight") setWidth(width - 20);
        }}
      />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

function DrawerPanel({ project, section, onClose }: { project: { id: string; title: string }; section: AgentSection; onClose: () => void }) {
  const summary = useProjectSummary(project.id).data;
  const held = useOverview(project.id).data?.attention?.filter((a) => a.type === "privacy").length ?? 0;
  const ref = { id: project.id, title: summary?.title ?? project.title, restricted: !!summary?.restricted };
  const registered = useAgentContextStore((s) => s.provider);
  const provider = currentProvider(registered, section, ref);
  return (
    <AssistantPanel
      project={{ ...ref, restricted: ref.restricted, heldFiles: held }}
      provider={provider}
      runTool={runProjectTool}
      onClose={onClose}
      placeholder={() => `Ask about ${ref.title}…`}
      empty={() => ({
        title: "How can I help with this project?",
        body: `I can tell you what's in ${ref.title}, what needs your attention and how your files might fit together. I point you to places and propose; you confirm.`,
        prompts: [
          { icon: SourcesIcon, text: "What did I import?" },
          { icon: WarningIcon, text: "What needs my attention?" },
          { icon: SearchIcon, text: "Did my last upload work?" },
          { icon: RelationshipIcon, text: "How do these files fit together?" },
        ],
      })}
    />
  );
}
