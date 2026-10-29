import { useStudio } from "@/stores/studio";
import type { ViewerAdapter } from "@/viewers/ViewerAdapter";
import { PATHOLOGY_TOOLS } from "./controller";
import { pathologyExporters } from "./io";
import { inspectRows } from "./measure";
import { PathologyViewer } from "./PathologyViewer";

export const pathologyAdapter: ViewerAdapter = {
  kind: "pathology",
  tools: PATHOLOGY_TOOLS,
  Component: PathologyViewer,
  inspect: (a, { item }) => inspectRows(a, item.assets[0]?.mpp ?? null, useStudio.getState().annotations),
  exporters: pathologyExporters,
};
