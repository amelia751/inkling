import { describeGeometry } from "@/extension-host/describe";
import { labelNames } from "@studio/plugin-contracts/environment";
import { useStudio } from "@/studio/stores/studio";
import type { Project, StudioItem } from "@studio/plugin-contracts/types";
import type { AgentContext } from "./protocol";

/** Cap so one huge dataset can't blow the request size; tools report totals separately. */
const MAX_ANNOTATIONS = 3000;

/** The text-only snapshot sent with every turn (see AgentContext). */
export function buildAgentContext(project: Project, items: StudioItem[], tools: string[]): AgentContext {
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
    items: items.map((i) => ({ id: i.id, name: i.name, group: i.group, sourceLabel: i.sourceLabel })),
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
    tools,
    unsavedChanges: s.dirty,
  };
}
