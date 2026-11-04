import { useMemo } from "react";
import { useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { DocumentIcon, RegionIcon, SearchIcon, SettingsIcon, TagIcon, WarningIcon } from "@studio/ui/icons";
import { AssistantPanel, type Prompt } from "@/studio/components/ai/assistant-panel";
import { CARD_TOOL_NAMES, runCardTool } from "@/studio/lib/agent/card-tools";
import { fetchAgentStatus } from "@/studio/lib/agent/client";
import { bareSnapshot, buildAgentContext, studioContext } from "@/studio/lib/agent/context";
import { useAgentContext, useAgentContextStore } from "@/studio/lib/agent/providers";
import { envProfile } from "@/studio/lib/agent/session";
import { activeRunProvenance } from "@/studio/lib/agent/provenance";
import { installEnvironment, persistEnvironment } from "@/studio/lib/environment-edits";
import { itemNoun, pluralWord } from "@/studio/lib/format";
import { useOverview } from "@/studio/lib/projects-api";
import { AGENT_TOOLS, changedKeys, runAgentTool, type AgentHost as EnvHost } from "@/extension-host/agent";
import type { PanelProps } from "@studio/plugin-ui-sdk/module";
import type { ProfileName } from "@studio/agent-protocol";
import { useAgent, type ClientToolOutcome } from "@/studio/stores/agent";
import { useStudio } from "@/studio/stores/studio";
import { NAMING } from "@studio/contracts/naming";

const ENV_NAMES = new Set(AGENT_TOOLS.map((t) => t.name));

/** One line for an environment tool's row (the model gets the full result). */
function envSummary(name: string, out: Awaited<ReturnType<typeof runAgentTool>>, change?: { summary: string }): string {
  const errors = Array.isArray(out.errors) ? out.errors.length : 0;
  if (!out.ok) return errors ? `${errors} error${errors === 1 ? "" : "s"}` : String(out.error ?? "Failed").slice(0, 80);
  const summary = out.summary as { tools?: unknown[]; labels?: { classes: unknown[] }[] } | undefined;
  switch (name) {
    case "list_modules":
      return `${(out.modules as unknown[] | undefined)?.length ?? 0} modules`;
    case "get_environment":
    case "validate_environment":
      return summary ? `${summary.tools?.length ?? 0} tools · ${summary.labels?.reduce((n, g) => n + g.classes.length, 0) ?? 0} label classes` : "Done";
    case "preview_environment":
      return "Valid";
    case "patch_environment":
      return change?.summary ?? "Applied";
    case "run_command":
      return out.handled ? "Done" : "No handler took it";
    default:
      return "Done";
  }
}

function studioPrompts(profile: ProfileName, noun: string): Prompt[] {
  const prompts: Prompt[] = [
    { icon: SearchIcon, text: `Find unannotated ${noun}` },
    { icon: WarningIcon, text: "Explain validation warnings" },
    { icon: TagIcon, text: "Help me define labels" },
    { icon: RegionIcon, text: "Suggest a contour" },
    { icon: DocumentIcon, text: "Prepare dataset documentation" },
  ];
  if (profile === "builder") prompts.splice(0, 2, { icon: SettingsIcon, text: "Add segmentation to this workspace" }, { icon: SearchIcon, text: "Which plugins are installed here?" });
  else if (profile === "coder") prompts.splice(0, 0, { icon: DocumentIcon, text: `Compute basic statistics for three ${noun} in the sandbox` });
  else if (envProfile(profile)) prompts.splice(2, 0, { icon: SettingsIcon, text: "Add a polygon tool and a “car” class in red" });
  return prompts;
}

const PROFILE_BLURB: Record<ProfileName, string> = {
  assistant: ", reshape this workspace (tools, panels, labels) and run its installed capabilities; you approve each run.",
  coder: ". I can also reshape this workspace and run analysis code in a private sandbox.",
  builder: ". I can also find, install and build plugins for this workspace; you approve every install.",
  task: ". I can also run this workspace's installed capabilities; you approve each run.",
  "environment-designer": ". I can also reshape this workspace: tools, panels and labels.",
  home: ". I can list your projects, start a new one, or open a chat in one of them.",
  reviewer: ". I review a built artifact and record findings; I can't change it.",
  "red-team": ". I probe a built artifact for escapes and record findings; I can't change it.",
};

/**
 * `studio.core.panels.ai`: the assistant in the Studio's right slot (ui.md §3), the Studio host of
 * the shared `AssistantPanel` (todo6 Phase 6). The model gets a text snapshot of the dataset,
 * never pixels. Tools that act on the Studio run here, in the browser: environment edits are
 * normal undoable `setEnv` steps, cards only act on the expert's click, and consequential steps
 * wait for approval. Manual annotation never depends on this panel.
 */
export function AiPanel({ project, items, item }: PanelProps) {
  const toggleAi = useStudio((s) => s.toggleAi);
  const selected = useStudio((s) => s.selectedIds.length);
  // One conversation per project: the route's project (a seed's task shares its id).
  const params = useParams();
  const projectId = params.projectId ?? project.id;
  const held = useOverview(projectId).data?.attention?.filter((a) => a.type === "privacy").length ?? 0;
  const status = useQuery({ queryKey: ["agent-status"], queryFn: fetchAgentStatus, staleTime: 60_000, retry: false });
  const author = `agent:${status.data?.model ?? "model"}`;
  const provider = useMemo(
    () => studioContext(project, items, item, selected, () => envProfile(useAgent.getState().profile)),
    [project, items, item, selected],
  );
  useAgentContext(provider);
  const shared = useAgentContextStore((s) => (s.provider?.section === "studio" ? s.provider : null)) ?? provider;
  // The conversation's session is the project's (the route's); a Studio's dataset is its task,
  // whose id is the project's only for seeds. The agent checks a snapshot against its session's
  // project, so the snapshot names the project; the task is in the turn context.
  const live = useMemo(() => (shared.snapshot ? { ...shared, snapshot: () => inProject(shared.snapshot!(), projectId) } : shared), [shared, projectId]);
  const noun = pluralWord(2, itemNoun(useStudio.getState().env ?? undefined));

  const runTool = async (name: string, input: Record<string, unknown>): Promise<ClientToolOutcome> => {
    if (CARD_TOOL_NAMES.has(name)) return runCardTool(name, input, buildAgentContext(project, items));
    if (!ENV_NAMES.has(name)) return { ok: false, output: { error: `Unknown client tool ${name}.` } };
    const envHost: EnvHost & { change?: ClientToolOutcome["change"] } = {
      env: () => useStudio.getState().env,
      apply: async (env, summary) => {
        const before = useStudio.getState().env;
        await installEnvironment(env);
        envHost.change = { summary, keys: before ? changedKeys(before.source, env.source) : [] };
        await persistEnvironment(project.id, env, author, await activeRunProvenance(projectId));
      },
    };
    const out = await runAgentTool(name, input, envHost);
    return { ok: out.ok, output: out, summary: envSummary(name, out, envHost.change), change: out.ok ? envHost.change : undefined };
  };

  const undo = async (messageId: string, partId: string) => {
    useStudio.getState().undoEnv();
    useAgent.getState().setPart(projectId, messageId, partId, { undone: true });
    const env = useStudio.getState().env;
    if (env) await persistEnvironment(project.id, env, "local-expert").catch(() => undefined);
    useAgent.getState().addNote(projectId, "(The expert undid your last environment change.)");
  };

  return (
    <AssistantPanel
      project={{ id: projectId, title: project.title, restricted: !!project.restricted, heldFiles: held }}
      provider={live}
      runTool={runTool}
      onClose={toggleAi}
      studio={{ project, items }}
      taskId={params.taskId}
      onUndo={(m, p) => void undo(m, p)}
      bareSnapshot={() => inProject(bareSnapshot(project), projectId)}
      placeholder={(profile) => (profile === "builder" ? "Ask the plugin builder…" : profile === "coder" ? "Ask the code sandbox…" : `Ask about ${project.title}…`)}
      empty={(profile) => ({
        title: "How can I help with this dataset?",
        body: `I can check progress, find gaps, explain warnings, and draft label definitions or documentation for ${project.title}${PROFILE_BLURB[profile]}`,
        prompts: studioPrompts(profile, noun),
      })}
    />
  );
}

/** The snapshot as the project's (see `live` above). */
function inProject<T extends { project: { id: string } }>(snap: T, projectId: string): T {
  return snap.project.id === projectId ? snap : { ...snap, project: { ...snap.project, id: projectId } };
}
