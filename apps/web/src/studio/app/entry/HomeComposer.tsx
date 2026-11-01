import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { NAMING } from "@studio/contracts/naming";
import type { ProjectSummary } from "@studio/contracts/types";
import { ComposerEmptyState, type ComposerFiles } from "@studio/ui/ui/composer-empty-state";
import { Button } from "@studio/ui/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@studio/ui/ui/dialog";
import { NeedsApiError, projectKeys } from "@/studio/lib/projects-api";
import { projectUrl } from "@/studio/lib/routes";
import { markTimeline, startTimeline } from "@/studio/lib/drop-timeline";
import type { Picked } from "@/studio/lib/uploads/walk";
import { useShell } from "@/studio/stores/shell";
import { useAgent } from "@/studio/stores/agent";
import { feature } from "@/studio/lib/features";
import { newDropId } from "@/studio/core/drops/api";
import { presetFor, studioName } from "@/studio/lib/studio-boot";
import { useBoots } from "@/studio/stores/boots";
import { useDropFiles, pickedFrom } from "./drop-adapter";
import { usePendingAsks } from "./pending-ask";
import { createProject, projectTitle } from "./start-project";

/** Starting points across kinds of data, so the first screen doesn't read as one domain's tool. */
export const HOME_EXAMPLES = ["Segment liver CT", "Classify skin lesions", "Annotate ultrasound video"];

type Gesture = { kind: "send"; text: string } | { kind: "drop"; picked: Picked; text: string };

/**
 * Home's composer (todo13 D1, §3.1): "What are you working on?". A send or a drop with no
 * project yet creates one (person API), opens it with the assistant drawer and delivers the
 * message (queued for the drawer) or the files (the drop adapter). With projects already, it
 * asks first: add to the last project, or start a new one (§3.4). Dropping anywhere on Home is
 * the same as dropping on the composer (`onFiles` from the page's overlay).
 */
export function HomeComposer({ projects, surface = "home", actions, className, children }: { projects: ProjectSummary[] | undefined; surface?: "home" | "projects"; actions?: ReactNode; className?: string; children?: ReactNode }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const drop = useDropFiles();
  const setAssistant = useShell((s) => s.setAssistant);
  const queue = usePendingAsks((s) => s.queue);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<Gesture | null>(null);
  // Samples are read-only demos: never the default target for new files.
  const last = projects?.find((p) => !p.sample);

  /**
   * Deliver the gesture into a project: open it with the drawer, then the message or the files.
   * With chat drops on, a drop is shared in the project's conversation (D1, D2): it starts now
   * (upload, Shared in chat, the plan and the fast path don't wait for the assistant), and the
   * drawer sends the message carrying it once the conversation is ready.
   */
  const deliver = (projectId: string, g: Gesture) => {
    setAssistant(true, g.kind === "send");
    const text = g.text.trim();
    if (g.kind === "drop" && feature("chatDrops")) {
      const conv = useAgent.getState().conversation(projectId);
      const pending = { dropId: newDropId(), messageId: crypto.randomUUID() };
      queue(projectId, text, pending);
      navigate(projectUrl(projectId));
      void drop({ projectId, picked: g.picked, origin: "home", surface, timelineStarted: true, conversationId: conv.id, conversationTitle: conv.title ?? (text.slice(0, 80) || undefined), ...pending });
    } else {
      if (g.kind === "send" || text) queue(projectId, text);
      navigate(projectUrl(projectId));
      if (g.kind === "drop") void drop({ projectId, picked: g.picked, origin: "home", surface, timelineStarted: true });
    }
    setText("");
  };

  const startNew = async (g: Gesture) => {
    setBusy(true);
    setError(null);
    try {
      const goal = g.text.trim() || undefined;
      const title = projectTitle({ goal, picked: g.kind === "drop" ? g.picked : undefined });
      const p = await createProject(title, goal && title !== goal ? goal : "");
      markTimeline("project-created");
      void qc.invalidateQueries({ queryKey: projectKeys.all });
      // §3.5 fast path: a request that names a preset boots its Studio now (the person lands in
      // it); the message still goes to the assistant, which refines it (labels, structure).
      const match = g.kind === "send" && feature("fastPath") ? presetFor(g.text) : null;
      if (match) void useBoots.getState().start(p.id, { preset: match.preset, name: studioName(match.matched.find((m) => !m.startsWith("kind:")) ?? "") || undefined }).catch(() => undefined);
      deliver(p.id, g);
    } catch (e) {
      setError(e instanceof NeedsApiError ? "Creating a project needs the full stack (the API): see docs/running.md" : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const begin = (g: Gesture) => {
    startTimeline(g.kind === "send" ? "send" : surface);
    if (last) setChoice(g);
    else void startNew(g);
  };

  const onFiles = async (files: ComposerFiles) => {
    const picked = await pickedFrom(files);
    if (picked.files.length) begin({ kind: "drop", picked, text });
  };

  return (
    <>
      <ComposerEmptyState
        variant="hero"
        // §3.1: with nothing yet, one centered composer; with projects, it heads the page.
        align={projects && !projects.length ? "center" : "start"}
        composer
        title="What are you working on?"
        description={<>Drop files here, or describe it: “Label 200 chest X-rays as normal or pneumonia.”</>}
        placeholder="Describe what you're making, or drop files here"
        value={text}
        onValueChange={setText}
        onSend={(t) => begin({ kind: "send", text: t })}
        onFiles={(f) => void onFiles(f)}
        examples={HOME_EXAMPLES}
        dropLabel={last ? "Drop to add these files" : "Drop to start a project with these files"}
        busy={busy}
        error={error}
        footnote={`Files go to your project's Files. ${NAMING.displayName}'s assistant sees their kinds and technical facts, never their contents.`}
        autoFocus
        actions={actions}
        className={className}
        testId="home-composer"
        inputTestId="goal"
        dropTestId="home-drop"
      >
        {children}
      </ComposerEmptyState>
      <Dialog open={!!choice} onOpenChange={(o) => !o && setChoice(null)}>
        <DialogContent className="max-w-md" data-testid="home-target-dialog">
          <DialogHeader>
            <DialogTitle>{choice?.kind === "drop" ? `Add to ${last?.title ?? "your last project"}?` : `Ask in ${last?.title ?? "your last project"}?`}</DialogTitle>
            <DialogDescription>
              {choice?.kind === "drop"
                ? `${choice.picked.files.length.toLocaleString()} ${choice.picked.files.length === 1 ? "file goes" : "files go"} to that project's Files, or to a new project.`
                : "Continue in the project you worked on last, or start a new one for this."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              size="lg"
              onClick={() => {
                const g = choice!;
                setChoice(null);
                void startNew(g);
              }}
              data-testid="home-target-new"
            >
              Start a new project
            </Button>
            <Button
              size="lg"
              onClick={() => {
                const g = choice!;
                setChoice(null);
                deliver(last!.id, g);
              }}
              data-testid="home-target-existing"
            >
              {choice?.kind === "drop" ? `Add to ${last?.title}` : `Open ${last?.title}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
