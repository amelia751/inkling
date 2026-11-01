import { useQueries, useQuery } from "@tanstack/react-query";
import type { DatasetProfile } from "@studio/contracts/types";
import { api, projectKeys } from "@/studio/lib/projects-api";

/**
 * Reads for the Datasets tab (docs/datasets.md §11): the profile is one pinned snapshot (the
 * working draft in Phase 1), read in one request so fields and records never mix snapshots.
 */
export const datasetKeys = {
  profile: (projectId: string, datasetId: string) => [...projectKeys.datasets(projectId), datasetId, "profile"] as const,
};

export const fetchDatasetProfile = (projectId: string, datasetId: string) =>
  api<DatasetProfile>(`/projects/${encodeURIComponent(projectId)}/datasets/${encodeURIComponent(datasetId)}/profile`);

export function useDatasetProfile(projectId: string, datasetId: string | undefined) {
  return useQuery({ queryKey: datasetKeys.profile(projectId, datasetId ?? ""), queryFn: () => fetchDatasetProfile(projectId, datasetId!), enabled: !!datasetId, staleTime: 15_000 });
}

/** The landing page's cards: one profile per dataset, each loading (and failing) on its own. */
export function useDatasetProfiles(projectId: string, datasetIds: string[]) {
  return useQueries({
    queries: datasetIds.map((id) => ({ queryKey: datasetKeys.profile(projectId, id), queryFn: () => fetchDatasetProfile(projectId, id), staleTime: 15_000 })),
  });
}
