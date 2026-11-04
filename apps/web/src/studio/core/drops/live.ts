import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { onProjectEvent } from "@/studio/lib/use-project-events";
import { dropRefresh } from "./throttle";

type Routed = { taskId?: unknown; taskIds?: unknown; studioTaskId?: unknown; state?: unknown; undone?: boolean } | null;

/** Whether a stream event concerns this Studio's items (todo28 W4). Pure, for tests. */
export function joinsStudio(type: string, data: unknown, taskId: string): boolean {
  const e = data as Routed;
  const ids = [e?.taskId, e?.studioTaskId, ...(Array.isArray(e?.taskIds) ? e!.taskIds : [])];
  const mine = ids.includes(taskId);
  if (type === "drop.applied") return mine;
  // todo28 D6: a drop's files join its Studio one by one; the routing event names the task.
  if (type === "drop.file") return mine && (e?.state === undefined || e.state === "in_studio" || e.state === "ready");
  // A file checked: it may have joined a Studio that fills from uploads. An event that names
  // another Studio is not ours; one that names none might be.
  if (type === "source.node.inspected") return mine || (e?.taskId === undefined && e?.taskIds === undefined && e?.studioTaskId === undefined);
  return false;
}

/**
 * The open Studio grows without a reload: a drop applied to its collection (todo13 J3), and
 * since todo28 each file of a drop that joins it (`drop.file` for its task, or a file inspected),
 * refetch its document. Bursts collapse to at most one refetch a second. Any other drop leaves
 * the open Studio alone (J4: a CT drop gets its own collection and Studio).
 */
export function useLiveDropItems(taskId: string | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!taskId) return;
    const refetch = () => dropRefresh(`studio:${taskId}`, () => void qc.invalidateQueries({ queryKey: ["tasks", taskId, "document"] }));
    const offs = ["drop.applied", "drop.file", "source.node.inspected"].map((type) =>
      onProjectEvent(type, (data) => {
        if (joinsStudio(type, data, taskId)) refetch();
        // A new collection in this dataset shows in the header's switcher (the Studio itself stays).
        if (type === "drop.applied") void qc.invalidateQueries({ queryKey: ["datasets"] });
      }),
    );
    return () => offs.forEach((off) => off());
  }, [taskId, qc]);
}
