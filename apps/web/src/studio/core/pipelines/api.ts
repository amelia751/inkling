import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/studio/lib/projects-api";
import type { ApproveResponse, PipelineRun, RunsPage, RunState } from "./contract";
import { isLive } from "./model";

/**
 * The pipeline gateway routes in apps/api (docs/pipeline.md §15). The browser never talks to
 * apps/pipeline; the api checks access and forwards. Errors come back as `ApiError` (a 404 for
 * a run in another workspace, never a 403 that confirms it exists: P§20 test 19).
 */
export const pipelineApi = {
  runs: (projectId: string, opts: { state?: RunState | RunState[]; cursor?: string | null } = {}) => {
    const q = new URLSearchParams();
    const states = Array.isArray(opts.state) ? opts.state : opts.state ? [opts.state] : [];
    if (states.length) q.set("state", states.join(","));
    if (opts.cursor) q.set("cursor", opts.cursor);
    const qs = q.toString();
    return api<RunsPage>(`/projects/${encodeURIComponent(projectId)}/pipeline-runs${qs ? `?${qs}` : ""}`);
  },
  run: (runId: string) => api<PipelineRun>(`/pipeline-runs/${encodeURIComponent(runId)}`),
  /**
   * Approve the candidate: bound to its manifest digest, so an approval of content that has
   * since changed is refused (P§13). The key makes a double click one approval.
   */
  approve: (runId: string, candidateDigest: string) =>
    api<ApproveResponse>(`/pipeline-runs/${encodeURIComponent(runId)}/approve`, {
      method: "POST",
      headers: { "Idempotency-Key": `approve:${runId}:${candidateDigest}` },
      json: { candidate_digest: candidateDigest },
    }),
};

export const pipelineKeys = {
  all: ["pipelines"] as const,
  runs: (projectId: string) => ["pipelines", projectId, "runs"] as const,
  run: (runId: string) => ["pipelines", "run", runId] as const,
};

/** Fallback poll while a run is moving, in case the event stream is down; events refresh sooner. */
const LIVE_POLL_MS = 10_000;

export function usePipelineRuns(projectId: string) {
  return useQuery({
    queryKey: pipelineKeys.runs(projectId),
    queryFn: () => pipelineApi.runs(projectId),
    enabled: !!projectId,
    staleTime: 5_000,
    refetchInterval: (q) => (q.state.data?.runs.some((r) => isLive(r.state)) ? LIVE_POLL_MS : false),
  });
}

export function usePipelineRun(runId: string) {
  return useQuery({
    queryKey: pipelineKeys.run(runId),
    queryFn: () => pipelineApi.run(runId),
    enabled: !!runId,
    staleTime: 2_000,
    refetchInterval: (q) => (q.state.data && isLive(q.state.data.state) ? LIVE_POLL_MS : false),
  });
}

export function useApproveRun(run: PipelineRun | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => pipelineApi.approve(run!.run_id, run!.candidate!.output_manifest_digest),
    onSuccess: (res) => {
      if (!run) return;
      if (res.run) qc.setQueryData(pipelineKeys.run(run.run_id), res.run);
      else qc.setQueryData<PipelineRun>(pipelineKeys.run(run.run_id), (r) => (r ? { ...r, state: res.state ?? "publishing" } : r));
      void qc.invalidateQueries({ queryKey: pipelineKeys.run(run.run_id) });
      void qc.invalidateQueries({ queryKey: pipelineKeys.runs(run.project_id) });
    },
  });
}
