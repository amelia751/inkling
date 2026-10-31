import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiUrl } from "@/extension-host/runtime-config";

/**
 * Live project updates (todo6 Phase 1.2): the kernel's server-sent events invalidate the
 * React Query keys they affect, so Overview, Sources and Explore follow an import while it
 * runs. EventSource reconnects on its own (the kernel ends a stream every few minutes).
 */
type ProjectEventListener = (data: unknown, projectId: string) => void;
const listeners = new Map<string, Set<ProjectEventListener>>();

/** Event types forwarded to `onProjectEvent` subscribers (todo7: `fs.changed`). */
const FORWARDED = ["fs.changed", "import.updated", "source.node.inspected"];

/**
 * Listen to one event type on the page's project stream (opened by `useProjectEvents`, one
 * per page). `data` is the event's parsed JSON. Returns the unsubscribe function.
 */
export function onProjectEvent(type: string, fn: ProjectEventListener): () => void {
  const set = listeners.get(type) ?? new Set();
  set.add(fn);
  listeners.set(type, set);
  return () => set.delete(fn);
}

/** Deliver an event to subscribers (the stream, and tests). */
export function emitProjectEvent(type: string, data: unknown, projectId: string): void {
  listeners.get(type)?.forEach((fn) => fn(data, projectId));
}

export function useProjectEvents(projectId: string | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!projectId || typeof EventSource === "undefined") return;
    const es = new EventSource(apiUrl(`/v1/projects/${encodeURIComponent(projectId)}/events`));
    const refresh = (keys: unknown[][]) => () => keys.forEach((queryKey) => void qc.invalidateQueries({ queryKey }));
    const project = ["projects", projectId];
    const on = {
      // The drive (todo7) lists imported files too: its children pages follow imports and inspection.
      "import.updated": refresh([project, ["sources"], ["files", projectId]]),
      "source.node.inspected": refresh([project, ["sources"], ["source-nodes"], ["files", projectId, "children"]]),
      "proposal.created": refresh([project]),
      "proposal.decided": refresh([project, ["tasks"]]),
    };
    for (const [type, fn] of Object.entries(on)) es.addEventListener(type, fn);
    for (const type of FORWARDED) {
      es.addEventListener(type, (e) => {
        let data: unknown = null;
        try {
          data = JSON.parse((e as MessageEvent<string>).data);
        } catch {
          // Events without a JSON body still notify.
        }
        emitProjectEvent(type, data, projectId);
      });
    }
    return () => es.close();
  }, [projectId, qc]);
}
