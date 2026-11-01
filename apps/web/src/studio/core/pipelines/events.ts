import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { onProjectEvent } from "@/studio/lib/use-project-events";
import { PIPELINE_EVENTS, type PipelineEventPayload, type PipelineEventType, type PipelineRun, type RunsPage } from "./contract";
import { pipelineKeys } from "./api";
import { applyEvent } from "./model";

/**
 * Follow pipeline runs on the project's SSE stream (opened by AppLayout's `useProjectEvents`).
 * Each event patches the cached run at once (state, step) and then invalidates it, so the page
 * moves with the event and settles on what the server says. Replays and duplicates are
 * harmless: a patch never moves a run backwards, and a refetch is idempotent.
 */
export function handlePipelineEvent(qc: QueryClient, projectId: string, type: PipelineEventType, data: unknown): void {
  const p = (data && typeof data === "object" ? data : {}) as PipelineEventPayload;
  if (p.project_id && p.project_id !== projectId) return;
  // review.* also fires for Studio reviews; without a run id there's nothing of ours to patch.
  if (!p.run_id) {
    if (!type.startsWith("review.")) void qc.invalidateQueries({ queryKey: pipelineKeys.runs(projectId) });
    return;
  }
  qc.setQueryData<RunsPage>(pipelineKeys.runs(projectId), (page) => (page ? { ...page, runs: page.runs.map((r) => applyEvent(r, type, p)) } : page));
  qc.setQueryData<PipelineRun>(pipelineKeys.run(p.run_id), (r) => (r ? applyEvent(r, type, p) : r));
  void qc.invalidateQueries({ queryKey: pipelineKeys.runs(projectId) });
  void qc.invalidateQueries({ queryKey: pipelineKeys.run(p.run_id) });
}

export function usePipelineEvents(projectId: string) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!projectId) return;
    const offs = PIPELINE_EVENTS.map((type) => onProjectEvent(type, (data, pid) => pid === projectId && handlePipelineEvent(qc, projectId, type, data)));
    return () => offs.forEach((off) => off());
  }, [projectId, qc]);
}
