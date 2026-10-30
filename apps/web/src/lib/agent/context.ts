import { environmentContext } from "@/platform/agent";
import { describeGeometry } from "@/platform/describe";
import { labelNames } from "@/platform/environment";
import { useStudio } from "@/stores/studio";
import type { Project, StudioItem } from "@/types";
import type { AgentContext } from "./protocol";

/** Cap so one huge dataset can't blow the request size; tools report totals separately. */
const MAX_ANNOTATIONS = 3000;

/** The text-only snapshot the dataset tools read (see AgentContext). Never pixels or file contents. */
export function buildAgentContext(project: Project, items: StudioItem[]): AgentContext {
  const s = useStudio.getState();
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
    items: items.map((i) => ({ id: i.id, name: i.name, group: i.group, sourceLabel: i.sourceLabel, assets: i.assets.map((a) => a.path) })),
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
