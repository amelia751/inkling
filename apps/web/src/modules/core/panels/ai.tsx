import { InfoIcon, SendIcon, AiIcon, CloseIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useStudio } from "@/stores/studio";
import type { PanelProps } from "@/platform/module";

const SAMPLE_PROMPTS = ["Help me define labels", "Suggest a contour", "Find unlabeled scans", "Explain validation warnings", "Prepare dataset documentation"];

/**
 * `inkling.core.panels.ai`: the right-hand assistant (ui.md §3). No model is connected yet,
 * so every action is disabled rather than faked; manual annotation never depends on it.
 */
export function AiPanel({ project, item }: PanelProps) {
  const toggleAi = useStudio((s) => s.toggleAi);

  return (
    <aside className="flex h-full flex-col bg-[var(--bg-primary)]" aria-label="Inkling AI">
      <div className="flex h-10 items-center gap-2 border-b border-[var(--border-color)] px-3">
        <AiIcon className="size-4 text-ai-text" />
        <span className="text-sm font-medium">Inkling AI</span>
        <button onClick={toggleAi} className="ml-auto rounded p-1 text-muted-foreground hover:bg-[var(--bg-tertiary)]" aria-label="Close assistant">
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-3 text-sm">
        <div className="rounded-md bg-[var(--bg-secondary)] p-2.5 text-xs">
          <div className="text-muted-foreground">Context</div>
          <div className="mt-0.5 truncate font-medium">{project.title}</div>
          {item && <div className="truncate text-muted-foreground">{item.name}</div>}
        </div>
        <div className="flex gap-2 rounded-md border border-[var(--border-color)] p-2.5 text-xs text-muted-foreground">
          <InfoIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>
            The assistant isn't connected in this build. Everything else in the Studio works without it.
            When enabled, suggestions will appear as <span className="rounded bg-prov-ai px-1 text-prov-ai-foreground">AI suggested</span> previews that you approve or reject.
          </p>
        </div>
        <div className="space-y-1.5">
          <div className="text-xs text-muted-foreground">Try asking</div>
          {SAMPLE_PROMPTS.map((p) => (
            <button key={p} disabled className="block w-full rounded-md border border-[var(--border-color)] px-2.5 py-1.5 text-left text-xs text-muted-foreground opacity-60">
              {p}
            </button>
          ))}
        </div>
      </div>
      <div className="border-t border-[var(--border-color)] p-2">
        <div className="flex items-end gap-1.5">
          <Textarea disabled placeholder="Ask Inkling…" className="min-h-9 resize-none text-sm" rows={1} />
          <Button size="icon" disabled className="h-9 w-9 shrink-0" aria-label="Send">
            <SendIcon className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </aside>
  );
}
