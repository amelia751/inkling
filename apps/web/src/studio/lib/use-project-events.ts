import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiUrl } from "@/extension-host/runtime-config";

/**
 * Live project updates (todo6 Phase 1.2): the kernel's server-sent events invalidate the
 * React Query keys they affect, so Overview, Sources and Explore follow an import while it
 * runs. EventSource reconnects on its own (the kernel ends a stream every few minutes).
 */
export function useProjectEvents(projectId: string | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!projectId || typeof EventSource === "undefined") return;
    const es = new EventSource(apiUrl(`/v1/projects/${encodeURIComponent(projectId)}/events`));
    const refresh = (keys: unknown[][]) => () => keys.forEach((queryKey) => void qc.invalidateQueries({ queryKey }));
    const project = ["projects", projectId];
    const on = {
      "import.updated": refresh([project, ["sources"]]),
      "source.node.inspected": refresh([project, ["sources"], ["source-nodes"]]),
      "proposal.created": refresh([project]),
      "proposal.decided": refresh([project, ["tasks"]]),
    };
    for (const [type, fn] of Object.entries(on)) es.addEventListener(type, fn);
    return () => es.close();
  }, [projectId, qc]);
}
