import { environmentContext } from "@/extension-host/agent";
import { describeGeometry } from "@/extension-host/describe";
import { labelNames } from "@studio/contracts/environment";
import { useStudio } from "@/studio/stores/studio";
import { studioDefaults } from "@/studio/lib/task-setup";
import type { Project, StudioItem } from "@studio/contracts";
import type { DatasetSnapshot as AgentContext } from "@studio/agent-protocol";
import type { AgentContextProvider } from "./providers";

/** Cap so one huge dataset can't blow the request size; tools report totals separately. */
export const MAX_ANNOTATIONS = 3000;

/** todo18 D: the chip says when the snapshot was cut (null when everything is shared). */
export function snapshotTruncation(total: number): string | null {
  return total > MAX_ANNOTATIONS ? `Shares the first ${MAX_ANNOTATIONS.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} annotations` : null;
}

/** The text-only snapshot the dataset tools read (see AgentContext). Never pixels or file contents. */
export function buildAgentContext(project: Project, items: StudioItem[]): AgentContext {
  const s = useStudio.getState();
  const blind = s.env ? !studioDefaults(s.env).showSourceLabels : project.task === "classification";
  return {
    project: {
      id: project.id,
      title: project.title,
      viewer: s.env?.dataKind.id ?? String(project.environment.extends ?? "unknown"),
      task: project.task,
      labels: labelNames(project.labels),
      license: project.license,
      source: project.source,
      restricted: !!project.restricted,
    },
    // Blind tasks (todo8 D8): the assistant doesn't get the label that came with the file either.
    items: items.map((i) => ({ id: i.id, name: i.name, group: i.group, ...(blind ? {} : { sourceLabel: i.sourceLabel }), assets: i.assets.map((a) => a.path), ...(i.dataKind ? { kind: i.dataKind } : {}) })),
    annotations: s.annotations.slice(0, MAX_ANNOTATIONS).map((a) => ({
      id: a.id,
      itemId: a.itemId,
      label: a.label,
      type: a.geometry.type,
      provenance: a.provenance,
      summary: describeGeometry(a, s.env),
    })),
    currentItemId: items[s.itemIndex]?.id,
    selectedIds: s.selectedIds,
    tools: s.env?.tools.map((t) => t.name) ?? [],
    unsavedChanges: s.dirty,
  };
}

/** Per-turn state shown to the model with the message: what's open, and the environment for profiles that edit it. */
export function turnContext(project: Project, item: StudioItem | undefined, withEnvironment: boolean): string {
  const s = useStudio.getState();
  const lines = [
    `Dataset: ${project.title} (${project.id})`,
    `Open item: ${item ? `${item.name} (${item.group})` : "none"}`,
    `Selected annotations: ${s.selectedIds.length}`,
  ];
  if (withEnvironment) lines.push(environmentContext(s.env));
  return lines.join("\n");
}

/**
 * The Studio's assistant context (todo6 Phase 6): the dataset snapshot plus the per-turn lines
 * above, as an `AgentContextProvider` like every other section's.
 */
export function studioContext(project: Project, items: StudioItem[], item: StudioItem | undefined, selected: number, withEnvironment: () => boolean): AgentContextProvider {
  return {
    key: `${project.id}:studio:${item?.id ?? ""}`,
    section: "studio",
    label: `${item?.name ?? project.title}${selected > 0 ? ` · ${selected} selected` : ""}`,
    shares: `Shared as text: ${project.title}, its label set, item names and annotation summaries.`,
    turnContext: () => turnContext(project, item, withEnvironment()),
    snapshot: () => buildAgentContext(project, items),
  };
}

/** What the Studio sends when the person removed the context chip: the dataset's name only. */
export function bareSnapshot(project: Project): AgentContext {
  const full = buildAgentContext(project, []);
  return { ...full, items: [], annotations: [], currentItemId: undefined, selectedIds: [], tools: [] };
}
