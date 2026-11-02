import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { ImportSession, SourceNode } from "@studio/contracts/types";
import { api, fetchChildren, fetchImports, fetchNode, fetchPreview, fetchSources, projectKeys, searchNodesWithTrash } from "@/studio/lib/projects-api";

/**
 * Sources queries (todo6 Phase 4). Every key sits under `["sources"]`, `["source-nodes"]` or
 * `["projects", id]`, which the kernel's events and the upload tray invalidate.
 */

/** `seq:<folder>:<key>` → the folder that holds the run. */
export function seqFolder(id: string): string {
  const rest = id.slice(4);
  const at = rest.indexOf(":");
  return at < 0 ? rest : rest.slice(0, at);
}

export const isSeq = (id: string | null | undefined): id is string => !!id && id.startsWith("seq:");

export function useSources(projectId: string) {
  return useQuery({ queryKey: projectKeys.sources(projectId), queryFn: () => fetchSources(projectId), staleTime: 10_000 });
}

export function useImports(projectId: string) {
  return useQuery({ queryKey: projectKeys.imports(projectId), queryFn: () => fetchImports(projectId), staleTime: 5_000 });
}

export function useImport(id: string | null) {
  return useQuery({ queryKey: ["projects", "imports", id ?? ""], enabled: !!id, queryFn: () => api<ImportSession>(`/imports/${encodeURIComponent(id!)}`) });
}

/** A node's detail (path, used in, provenance). Runs (`seq:`) have none of their own. */
export function useNode(id: string | null | undefined) {
  return useQuery({ queryKey: projectKeys.node(id ?? ""), enabled: !!id && !isSeq(id), queryFn: () => fetchNode(id!), staleTime: 10_000 });
}

export function usePreview(id: string | null | undefined, enabled = true) {
  return useQuery({ queryKey: [...projectKeys.node(id ?? ""), "preview"], enabled: enabled && !!id && !isSeq(id), queryFn: () => fetchPreview(id!), staleTime: 60_000 });
}

/** Every page of a folder (or a run) for the listing, fetched as it scrolls. */
export function useFolder(sourceId: string | undefined, nodeId: string | null | undefined) {
  return useInfiniteQuery({
    queryKey: [...projectKeys.children(sourceId ?? "", nodeId ?? null), "listing"],
    enabled: !!sourceId && !!nodeId,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => fetchChildren(sourceId!, nodeId!, pageParam),
    getNextPageParam: (p) => p.nextCursor,
    staleTime: 10_000,
  });
}

export function useSearch(projectId: string, q: string, kind: string | undefined, status: string | undefined) {
  const on = !!q || !!kind || !!status;
  return useQuery({
    queryKey: ["sources", "search", projectId, q, kind ?? "", status ?? ""],
    enabled: on,
    queryFn: () => searchNodesWithTrash(projectId, q, kind, status),
    staleTime: 5_000,
  });
}

/** Items of all loaded pages, flattened. */
export function pagesItems(pages: { items: SourceNode[] }[] | undefined): SourceNode[] {
  return pages?.flatMap((p) => p.items) ?? [];
}
