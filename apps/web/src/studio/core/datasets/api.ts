import { useMemo } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DatasetProfile, ProjectTarget } from "@studio/contracts/types";
import { api, ApiError, NeedsApiError, projectKeys } from "@/studio/lib/projects-api";
import { pipelineApi, pipelineKeys } from "@/studio/core/pipelines/api";
import type { PipelineRun, PipelineRunSummary } from "@/studio/core/pipelines/contract";
import { applyStructure, type DatasetStructure } from "./structure";

/**
 * Reads for the Datasets tab (docs/datasets.md §11): the profile is one pinned snapshot (the
 * working draft in Phase 1), read in one request so fields and records never mix snapshots.
 * The landing page reads one bounded summary per dataset and one attention list
 * (`routes/datasets_views.py`); where a server doesn't have those yet (an older api, the
 * Datasets flag off), the page falls back to per-dataset profiles and the review queue.
 */
export const datasetKeys = {
  profile: (projectId: string, datasetId: string) => [...projectKeys.datasets(projectId), datasetId, "profile"] as const,
  summaries: (projectId: string) => [...projectKeys.datasets(projectId), "summaries"] as const,
  attention: (projectId: string, datasetId?: string) => [...projectKeys.datasets(projectId), "attention", datasetId ?? ""] as const,
  structure: (datasetId: string) => ["datasets", datasetId, "structure"] as const,
  pipelineProblems: (projectId: string) => [...pipelineKeys.runs(projectId), "problems"] as const,
};

const enc = encodeURIComponent;

/** A route this server doesn't have (404 or the dev stand-in's 501) reads as "not available". */
const absent = (e: unknown) => e instanceof NeedsApiError || (e instanceof ApiError && (e.status === 404 || e.status === 405));
async function optional<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (absent(e)) return null;
    throw e;
  }
}

export const fetchDatasetProfile = (projectId: string, datasetId: string) => api<DatasetProfile>(`/projects/${enc(projectId)}/datasets/${enc(datasetId)}/profile`);

export function useDatasetProfile(projectId: string, datasetId: string | undefined) {
  return useQuery({ queryKey: datasetKeys.profile(projectId, datasetId ?? ""), queryFn: () => fetchDatasetProfile(projectId, datasetId!), enabled: !!datasetId, staleTime: 15_000 });
}

/** The landing page's fallback when summaries aren't served: one profile per dataset, each loading (and failing) on its own. */
export function useDatasetProfiles(projectId: string, datasetIds: string[], enabled = true) {
  return useQueries({
    queries: datasetIds.map((id) => ({ queryKey: datasetKeys.profile(projectId, id), queryFn: () => fetchDatasetProfile(projectId, id), staleTime: 15_000, enabled })),
  });
}

// ---- Landing summaries -------------------------------------------------------------------------

/** One row of `GET /projects/:p/dataset-summaries`: what a card needs, never every file. */
export interface DatasetLandingSummary {
  datasetId: string;
  files: number;
  checking: number;
  collections: Pick<DatasetProfile["collections"][number], "id" | "name" | "kind" | "count" | "unit" | "files" | "suggested" | "issues" | "previewNodeId">[];
  moreCollections: number;
  relationships: number;
  issues: { count: number; items: number; blocking: number; high: number };
  /** Suggested collections and connections nobody has confirmed. */
  suggestions: number;
  snapshot: DatasetProfile["snapshot"];
  lastChangedAt: string | null;
}

export function useDatasetSummaries(projectId: string) {
  return useQuery({
    queryKey: datasetKeys.summaries(projectId),
    queryFn: () => optional(api<{ datasets: DatasetLandingSummary[] }>(`/projects/${enc(projectId)}/dataset-summaries`)),
    enabled: !!projectId,
    staleTime: 15_000,
  });
}

// ---- Attention ---------------------------------------------------------------------------------

export type AttentionKind = "malformed" | "suggestion" | "plan" | "pipeline";

/** One row of `GET /projects/:p/dataset-attention`, or a pipeline run that needs a person. */
export interface DatasetAttentionItem {
  id: string;
  kind: AttentionKind;
  datasetId: string | null;
  datasetTitle?: string | null;
  severity: "high" | "medium" | "low";
  blocking: boolean;
  title: string;
  detail: string;
  count: number;
  action: { label: string; target: Omit<ProjectTarget, "section"> & { section: ProjectTarget["section"] | "pipelines"; runId?: string; dropId?: string; conversationId?: string } };
  at: string | null;
}

export function useDatasetAttention(projectId: string, datasetId?: string) {
  return useQuery({
    queryKey: datasetKeys.attention(projectId, datasetId),
    queryFn: () => optional(api<{ items: DatasetAttentionItem[]; total: number }>(`/projects/${enc(projectId)}/dataset-attention${datasetId ? `?datasetId=${enc(datasetId)}` : ""}`)),
    enabled: !!projectId,
    staleTime: 15_000,
  });
}

/** Runs worth a person's look: failed, waiting for review, or holding back files. */
export const isProblemRun = (r: PipelineRunSummary) => r.state === "failed" || r.state === "awaiting_review" || (r.item_counts?.quarantined ?? 0) > 0 || (r.item_counts?.rejected ?? 0) > 0;
const PROBLEM_DETAILS = 5;

/**
 * todo12's pipeline validation, once the gateway answers: the project's problem runs, with
 * the detail of the newest few (the detail names the dataset a run's candidate belongs to).
 * No pipeline service (503) or none on this server means nothing to show, not an error.
 */
export function usePipelineProblems(projectId: string) {
  return useQuery({
    queryKey: datasetKeys.pipelineProblems(projectId),
    queryFn: async (): Promise<{ runs: PipelineRunSummary[]; details: PipelineRun[] }> => {
      let runs: PipelineRunSummary[] = [];
      try {
        runs = (await pipelineApi.runs(projectId)).runs.filter(isProblemRun);
      } catch {
        return { runs: [], details: [] };
      }
      const details = await Promise.all(runs.slice(0, PROBLEM_DETAILS).map((r) => pipelineApi.run(r.run_id).catch(() => null)));
      return { runs, details: details.filter((d): d is PipelineRun => !!d) };
    },
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

// ---- Structure (todo13-organize's routes) ------------------------------------------------------

export function useDatasetStructure(datasetId: string | undefined) {
  return useQuery({
    queryKey: datasetKeys.structure(datasetId ?? ""),
    queryFn: () => optional(api<DatasetStructure>(`/datasets/${enc(datasetId!)}/structure`)),
    enabled: !!datasetId,
    staleTime: 15_000,
    retry: false,
  });
}

export class StructureUnavailableError extends Error {
  constructor() {
    super("Confirming collections needs the dataset structure service, which this server doesn't have yet.");
  }
}

/** Write the working draft's structure (draft only; a published dataset answers with a proposal). */
export function usePutStructure(projectId: string, datasetId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (s: DatasetStructure) => {
      try {
        return await api<DatasetStructure>(`/datasets/${enc(datasetId)}/structure`, { method: "PUT", json: s });
      } catch (e) {
        if (absent(e)) throw new StructureUnavailableError();
        throw e;
      }
    },
    onSuccess: (saved, sent) => {
      qc.setQueryData(datasetKeys.structure(datasetId), saved ?? sent);
      void qc.invalidateQueries({ queryKey: projectKeys.datasets(projectId) });
    },
  });
}

/** What a view needs from the profile query: the merged data and the query's state. */
export interface ProfileQuery {
  data: DatasetProfile | undefined;
  error: unknown;
  isLoading: boolean;
  refetch: () => unknown;
}

/** The profile as the dataset's structure describes it (names, confirmed parts), one object for every view. */
export function useDatasetView(projectId: string, datasetId: string): ProfileQuery & { structure: DatasetStructure | null | undefined } {
  const profile = useDatasetProfile(projectId, datasetId);
  const structure = useDatasetStructure(datasetId);
  const data = useMemo(() => (profile.data ? applyStructure(profile.data, structure.data) : undefined), [profile.data, structure.data]);
  return { data, error: profile.error, isLoading: profile.isLoading, refetch: profile.refetch, structure: structure.data };
}
