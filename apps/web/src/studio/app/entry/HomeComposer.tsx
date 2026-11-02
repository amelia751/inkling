import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { ProjectSummary } from "@studio/contracts/types";
import { ComposerEmptyState, type ComposerFiles } from "@studio/ui/ui/composer-empty-state";
import { Button } from "@studio/ui/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@studio/ui/ui/dialog";
import { Input } from "@studio/ui/ui/input";
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
import { AiNotice, useAckAiNotice } from "@/studio/components/ai/ai-notice";
import { createProject, projectTitle } from "./start-project";

/** Starting points across kinds of data, so the first screen doesn't read as one domain's tool. */
export const HOME_EXAMPLES = ["Segment liver CT", "Classify skin lesions", "Annotate ultrasound video"];

type Gesture = { kind: "send"; text: string } | { kind: "drop"; picked: Picked; text: string };

/**
 * Home's composer (todo13 D1, §3.1): "What are you working on?". A send or a drop with no
 * project yet creates one (person API), opens it with the assistant drawer and delivers the
 * message (queued for the drawer) or the files (the drop adapter). todo20 D1: it always starts
 * a new project (no "Add to your last project?"); open a project's card to continue there.
 * Dropping anywhere on Home is the same as dropping on the composer (`onFiles` from the page's overlay).
 */
export function HomeComposer({ projects, surface = "home", actions, className, children }: { projects: ProjectSummary[] | undefined; surface?: "home" | "projects"; actions?: ReactNode; className?: string; children?: ReactNode }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const drop = useDropFiles();
  const setAssistant = useShell((s) => s.setAssistant);
  const queue = usePendingAsks((s) => s.queue);
  const ackAiNotice = useAckAiNotice();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Deliver the gesture into a project: open it with the drawer, then the message or the files.
   * With chat drops on, a drop is shared in the project's conversation (D1, D2): it starts now
   * (upload, Shared in chat, the plan and the fast path don't wait for the assistant), and the
   * drawer sends the message carrying it once the conversation is ready.
   */
  const deliver = async (projectId: string, g: Gesture) => {
    setAssistant(true, g.kind === "send");
    const text = g.text.trim();
    if (g.kind === "drop" && feature("chatDrops")) {
      // todo20 D2: the new project's first chat is an agent session (a local id when the service is down).
      const conv = await useAgent.getState().ensureConversation(projectId);
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
      // Its name is known now: the project's breadcrumb and sidebar show it at once, not its id.
      useShell.getState().visited({ id: p.id, title: p.title });
      void qc.invalidateQueries({ queryKey: projectKeys.all });
      // §3.5 fast path: a request that names a preset boots its Studio now (the person lands in
      // it); the message still goes to the assistant, which refines it (labels, structure).
      const match = g.kind === "send" && feature("fastPath") ? presetFor(g.text) : null;
      if (match) void useBoots.getState().start(p.id, { preset: match.preset, name: studioName(match.matched.find((m) => !m.startsWith("kind:")) ?? "") || undefined }).catch(() => undefined);
      await deliver(p.id, g);
    } catch (e) {
      setError(e instanceof NeedsApiError ? "Creating a project needs the full stack (the API): see docs/running.md" : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const begin = (g: Gesture) => {
    startTimeline(g.kind === "send" ? "send" : surface);
    // D2: the first send is the acknowledgement of the notice under the composer.
    ackAiNotice();
    // todo20 D1: a Home drop or send always starts a new project (named from the folder or the message).
    void startNew(g);
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
        description="Describe the task or drop your data. The assistant sets up the rest."
        placeholder="Label 200 chest X-rays as normal or pneumonia…"
        value={text}
        onValueChange={setText}
        onSend={(t) => begin({ kind: "send", text: t })}
        onFiles={(f) => void onFiles(f)}
        dropLabel="Drop to start a project with these files"
        busy={busy}
        error={error}
        footnote={<AiNotice />}
        autoFocus
        actions={actions}
        className={className}
        testId="home-composer"
        inputTestId="goal"
        dropTestId="home-drop"
      >
        {children}
      </ComposerEmptyState>
    </>
  );
}

/** todo20 D1: "New project" asks for a name, creates it and opens it with its chat. */
export function NewProjectButton({ className }: { className?: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const setAssistant = useShell((s) => s.setAssistant);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    const title = name.trim();
    if (!title) return;
    setBusy(true);
    setError(null);
    try {
      const p = await createProject(title);
      useShell.getState().visited({ id: p.id, title: p.title });
      void qc.invalidateQueries({ queryKey: projectKeys.all });
      setOpen(false);
      setName("");
      setAssistant(true);
      navigate(projectUrl(p.id));
    } catch (e) {
      setError(e instanceof NeedsApiError ? "Creating a project needs the full stack (the API): see docs/running.md" : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant="outline" size="sm" className={className} onClick={() => setOpen(true)} data-testid="new-project">New project</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md" data-testid="new-project-dialog">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>Name it; you can rename it later.</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Chest X-ray screening" aria-label="Project name" data-testid="new-project-name" />
            {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
            <DialogFooter className="mt-4 gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={!name.trim() || busy} data-testid="new-project-create">{busy ? "Creating" : "Create"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
