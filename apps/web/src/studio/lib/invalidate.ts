import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * todo18 D1: one map from "what happened" to "which queries are stale". The project event
 * stream (`use-project-events.ts`) and every mutation call `invalidateFor` with the same event
 * names, so a change made here and a change made in another tab refresh the same views.
 */
export type InvalidationEvent =
  | "fs.changed"
  | "import.updated"
  | "source.node.inspected"
  | "proposal.created"
  | "proposal.decided"
  | "boot.ready"
  | "environment.updated"
  | "trash.changed" // something trashed, restored or destroyed
  | "turn.undone" // an assistant turn undone from Activity
  | "dataset.changed"
  | "task.changed"
  | "annotations.saved"
  | "item.ready";

type Payload = { datasetId?: string; taskId?: string } | undefined;

const MAP: Record<InvalidationEvent, (p: string, x: Payload) => QueryKey[]> = {
  "fs.changed": (p) => [["files", p], ["projects", p, "trash"], ["projects", p, "overview"], ["projects", p, "activity"]],
  // The drive (todo7) lists imported files too: its children pages follow imports and inspection.
  "import.updated": (p) => [["projects", p], ["sources"], ["files", p]],
  "source.node.inspected": (p) => [["projects", p], ["sources"], ["source-nodes"], ["files", p, "children"]],
  "proposal.created": (p) => [["projects", p]],
  "proposal.decided": (p) => [["projects", p], ["tasks"]],
  // A boot adds a draft task: Overview and the Studio list show it.
  "boot.ready": (p) => [["projects", p], ["tasks"]],
  "environment.updated": (p, x) => [["environment", p], ...(x?.taskId ? [["environment", x.taskId], ["tasks", x.taskId]] : [["environment"], ["tasks"]]), ["projects", p, "activity"]],
  // Trash and restore touch everything that lists files, datasets or Studios.
  "trash.changed": (p) => [["projects", p], ["files", p], ["datasets", p], ["datasets"], ["tasks"], ["org", "deleted-projects"]],
  // Undoing a turn can revert files, datasets, Studios, setups and annotations, not only Activity.
  "turn.undone": (p) => [["projects", p], ["files", p], ["datasets"], ["tasks"], ["environment"], ["annotations"]],
  "dataset.changed": (p, x) => [["projects", p], ["datasets"], ...(x?.datasetId ? [["tasks", x.datasetId]] : [["tasks"]])],
  "task.changed": (p, x) => [["projects", p], ...(x?.taskId ? [["tasks", x.taskId]] : [["tasks"]])],
  "annotations.saved": (p, x) => [["projects", p, "overview"], ["projects", p, "activity"], ...(x?.taskId ? [["tasks", x.taskId, "summary"]] : [])],
  "item.ready": (p) => [["files", p], ["projects", p, "overview"]],
};

export const INVALIDATION_EVENTS = Object.keys(MAP) as InvalidationEvent[];

/** The query keys an event makes stale (pure; for tests and the stream). */
export function keysFor(projectId: string, event: string, payload?: Payload): QueryKey[] {
  const f = MAP[event as InvalidationEvent];
  return f ? f(projectId, payload) : [];
}

/** Invalidate every query an event makes stale. Unknown events are a no-op. */
export function invalidateFor(qc: QueryClient, projectId: string, event: string, payload?: Payload): void {
  for (const queryKey of keysFor(projectId, event, payload)) void qc.invalidateQueries({ queryKey });
}
