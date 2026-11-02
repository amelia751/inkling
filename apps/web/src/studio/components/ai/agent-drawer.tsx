import { useRef, useState } from "react";
import { AiIcon, FileIcon, FolderIcon, SearchIcon, SourcesIcon, TableFileIcon, WarningIcon, RelationshipIcon, SegmentIcon, TagIcon, VideoIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { Sheet, SheetContent } from "@studio/ui/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@studio/ui/ui/tooltip";
import { NAMING } from "@studio/contracts/naming";
import { AssistantPanel } from "@/studio/components/ai/assistant-panel";
import { AskButton } from "@/studio/components/ai/ask-button";
import { CARD_TOOL_NAMES, runCardTool } from "@/studio/lib/agent/card-tools";
import { currentProvider, useAgentContextStore, type AgentSection } from "@/studio/lib/agent/providers";
import { ENV_TOOL_NAMES } from "@/studio/lib/agent/session";
import { useOverview, useProjectSummary } from "@/studio/lib/projects-api";
import { useViewport } from "@/studio/lib/use-media-query";
import { useFeature } from "@/studio/lib/features";
import { useFirstRunHints } from "@/studio/lib/prefs-api";
import { HOME_EXAMPLES } from "@/studio/app/entry/HomeComposer";
import type { ClientToolOutcome } from "@/studio/stores/agent";
import { ASSISTANT_WIDTH, clampAssistantWidth, useShell } from "@/studio/stores/shell";

const SECTIONS = new Set<AgentSection>(["overview", "sources", "explore", "datasets", "studio", "review", "activity", "settings"]);
/** The old `files` route is the same section as `sources` (nav label "Files", todo13 D10). */
/** `tasks` (Task setup, todo8 D7) belongs with Datasets: a task is work on a dataset. */
const ALIASES: Record<string, AgentSection> = { files: "sources", tasks: "datasets" };
export const agentSection = (s: string | undefined): AgentSection => (s && ALIASES[s]) || (s && SECTIONS.has(s as AgentSection) ? (s as AgentSection) : "overview");

/** Empty-state prompts on the Files drive (todo7 Phase 8): the assistant proposes a plan; you apply it. */
const FILES_PROMPTS = [
  { icon: FolderIcon, text: "Group these scans by patient" },
  { icon: FileIcon, text: "Rename files to remove dates" },
  { icon: TableFileIcon, text: "Put all spreadsheets in one folder" },
];

/** todo14 D8: the first-run hints are the todo13 examples (Home's composer), in the same order. */
const FIRST_RUN_ICONS = [SegmentIcon, TagIcon, VideoIcon];
const FIRST_RUN_PROMPTS = HOME_EXAMPLES.map((text, i) => ({ icon: FIRST_RUN_ICONS[i] ?? SearchIcon, text }));

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
  return <AskButton open={open} onToggle={toggle} labelClassName="max-sm:hidden" testId="assistant-toggle" />;
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
  // todo13 §3.1 "Chat, new conversation": with chat drops on, the empty chat says files go here too.
  const drops = useFeature("chatDrops");
  const hints = useFirstRunHints();
  return (
    <AssistantPanel
      project={{ ...ref, restricted: ref.restricted, heldFiles: held }}
      provider={provider}
      runTool={runProjectTool}
      onClose={onClose}
      placeholder={() => `Ask about ${ref.title}…`}
      empty={() =>
        section === "sources"
          ? {
              title: "How can I help with these files?",
              body: "Find files or tidy folders. Nothing moves until you apply.",
              prompts: FILES_PROMPTS,
            }
          : {
              title: "How can I help with this project?",
              body: drops ? "Ask about this project, or drop files." : "Ask about this project.",
              ...(hints.show
                ? {
                    // todo14 D8: a first run gets the three todo13 examples, once, until dismissed.
                    prompts: FIRST_RUN_PROMPTS,
                    footer: (
                      <p className="flex items-center gap-2 text-sm text-hint" data-testid="first-run-hints">
                        Ideas to start with.
                        <button type="button" className="rounded-md px-1.5 text-complementary underline-offset-2 hover:underline" onClick={hints.dismiss} data-testid="first-run-hints-dismiss">
                          Don't show again
                        </button>
                      </p>
                    ),
                  }
                : {
                    prompts: [
                      { icon: SourcesIcon, text: "What did I import?" },
                      { icon: WarningIcon, text: "What needs my attention?" },
                      { icon: SearchIcon, text: "Did my last upload work?" },
                      { icon: RelationshipIcon, text: "How do these files fit together?" },
                    ],
                  }),
            }
      }
    />
  );
}
