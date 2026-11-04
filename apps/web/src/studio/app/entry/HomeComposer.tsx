import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import type { ProjectSummary } from "@studio/contracts/types";
import { ComposerEmptyState, type ComposerFiles } from "@studio/ui/ui/composer-empty-state";
import { Button } from "@studio/ui/ui/button";
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
import { projectTitle } from "./start-project";
import { useNewProject } from "./new-project-dialog";
import { HomeChats, useHomeChat } from "./home-chat";

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
  const drop = useDropFiles();
  const setAssistant = useShell((s) => s.setAssistant);
  const queue = usePendingAsks((s) => s.queue);
  const ackAiNotice = useAckAiNotice();
  const { open: openNewProject } = useNewProject();
  const sendHome = useHomeChat((s) => s.send);
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
      // todo24 D2: a message sent with files waits for them. The upload starts first (its tray
      // session's key is known at once) and the queued message carries the key; the drawer
      // sends it once that session stops moving, naming the files that didn't make it.
      let uploadKey: string | undefined;
      if (g.kind === "drop") void drop({ projectId, picked: g.picked, origin: "home", surface, timelineStarted: true, onUploadKey: (k) => (uploadKey = k) });
      if (g.kind === "send" || text) queue(projectId, text, undefined, uploadKey ? { key: uploadKey } : undefined);
      navigate(projectUrl(projectId));
    }
    setText("");
  };

  const startNew = async (g: Gesture) => {
    setError(null);
    const goal = g.text.trim() || undefined;
    const picked = g.kind === "drop" ? g.picked : undefined;
    const n = picked?.files.length ?? 0;
    // todo21 D2: nothing is created until the person confirms the name.
    const pending =
      g.kind === "drop"
        ? `${n.toLocaleString()} ${n === 1 ? "file" : "files"}${goal ? " and your message" : ""} will go to its first chat.`
        : "Your message will go to its first chat.";
    const p = await openNewProject({ suggestion: projectTitle({ goal, picked }), pending });
    if (!p) {
      // Cancel keeps the text; dropped files aren't kept (they'd need picking again).
      if (g.kind === "drop") setError(`Not uploaded: ${n.toLocaleString()} ${n === 1 ? "file" : "files"}. Drop them again to start a project.`);
      return;
    }
    setBusy(true);
    try {
      markTimeline("project-created");
      // §3.5 fast path: a request that names a preset boots its Studio now (the person lands in
      // it); the message still goes to the assistant, which refines it (labels, structure).
      const match = g.kind === "send" && feature("fastPath") ? presetFor(g.text) : null;
      if (match) void useBoots.getState().start(p.id, { preset: match.preset, name: studioName(match.matched.find((m) => !m.startsWith("kind:")) ?? "") || undefined }).catch(() => undefined);
      await deliver(p.id, g);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const begin = (g: Gesture) => {
    startTimeline(g.kind === "send" ? "send" : surface);
    // D2: the first send is the acknowledgement of the notice under the composer.
    ackAiNotice();
    // todo21 D8: on Home a message (not a drop) goes to Home's routing assistant; files always
    // need a project, so a drop (or a send while the assistant is unavailable) opens the dialog.
    if (g.kind === "send" && surface === "home") {
      void sendHome(g.text, navigate).then((ok) => (ok ? setText("") : startNew(g)));
      return;
    }
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
        {surface === "home" && <HomeChats />}
        {children}
      </ComposerEmptyState>
    </>
  );
}

/** todo20 D1, todo21 D1: "New project" opens the name dialog (`NewProjectHost`). */
export function NewProjectButton({ className }: { className?: string }) {
  const { open } = useNewProject();
  return (
    <Button variant="outline" size="sm" className={className} onClick={() => void open()} data-testid="new-project">
      New project
    </Button>
  );
}
