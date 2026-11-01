import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { onProjectEvent } from "@/studio/lib/use-project-events";

/**
 * A drop applied to the open Studio's collection (todo13 J3: more X-rays dropped while the X-ray
 * Studio is open) refetches its document, so the new items appear without a reload. Any other
 * drop leaves the open Studio alone (J4: a CT drop gets its own collection and Studio).
 */
export function useLiveDropItems(taskId: string | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!taskId) return;
    return onProjectEvent("drop.applied", (data) => {
      const e = data as { taskIds?: string[]; undone?: boolean } | null;
      if (e?.taskIds?.includes(taskId)) void qc.invalidateQueries({ queryKey: ["tasks", taskId, "document"] });
    });
  }, [taskId, qc]);
}
