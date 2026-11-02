import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, projectKeys } from "@/studio/lib/projects-api";

/**
 * Project-wide Trash and delete (todo16 D2–D6, the shared contract): every resource a project
 * owns moves to Trash in one batch with its dependents, and restoring the batch brings it all
 * back. Typed fetchers, React Query hooks and the one "Moved to Trash" toast (Undo, Open Trash).
 */

export type TrashKind = "source" | "dataset" | "collection" | "studio";
export type TrashFilter = "all" | "sources" | "datasets" | "collections" | "studios";
export type DeletableKind = Exclude<TrashKind, "source">;

export interface TrashActor {
  id: string;
  name: string;
  /** Deleted by this person's assistant: shown as "<person>'s assistant". */
  viaAssistant: boolean;
}

export interface ProjectTrashItem {
  batchId: string;
  kind: TrashKind;
  id: string;
  name: string;
  originalLocation: string | null;
  trashedAt: string;
  trashedBy: TrashActor;
  daysLeft: number;
  dependents: { files?: number; collections?: number; studios?: number; annotations?: number };
}

export interface Impact {
  items: { kind: string; id: string; name: string }[];
  files: number;
  datasetsLosingItems: { id: string; name: string; items: number }[];
}

export interface ProjectTrash {
  items: ProjectTrashItem[];
  count: number;
}

export interface RestoreResult {
  restored: ProjectTrashItem[];
  relocatedToRoot: boolean;
}

export interface DeletedProject {
  id: string;
  name: string;
  trashedAt: string;
  trashedBy: TrashActor | string;
  daysLeft: number;
}

const P = encodeURIComponent;

/** One row from either the new TrashItem or the older file-trash row (`trashedBy: string`, `purgeInDays`). */
export function normalizeTrashItem(raw: Record<string, unknown>): ProjectTrashItem {
  const by = raw.trashedBy;
  const actor: TrashActor = by && typeof by === "object" ? (by as TrashActor) : { id: "", name: typeof by === "string" ? by : "", viaAssistant: false };
  return {
    batchId: String(raw.batchId ?? raw.trashBatchId ?? raw.id ?? ""),
    kind: (raw.batchId && typeof raw.kind === "string" && ["source", "dataset", "collection", "studio"].includes(raw.kind) ? raw.kind : "source") as TrashKind,
    id: String(raw.id ?? ""),
    name: String(raw.name ?? ""),
    originalLocation: (raw.originalLocation as string | null | undefined) ?? null,
    trashedAt: String(raw.trashedAt ?? ""),
    trashedBy: actor,
    daysLeft: Number(raw.daysLeft ?? raw.purgeInDays ?? 0),
    dependents: (raw.dependents as ProjectTrashItem["dependents"]) ?? {},
  };
}

/** "Ana", or "Ana's assistant" when the assistant did it for Ana. */
export function deletedByLabel(by: TrashActor): string {
  if (!by.viaAssistant) return by.name || "Someone";
  return by.name ? `${by.name}'s assistant` : "The assistant";
}

export const KIND_LABEL: Record<TrashKind, string> = { source: "Source", dataset: "Dataset", collection: "Collection", studio: "Studio" };

/** Which rows a filter chip shows (Datasets includes their collections). */
export function matchesFilter(item: ProjectTrashItem, filter: TrashFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "sources":
      return item.kind === "source";
    case "datasets":
      return item.kind === "dataset" || item.kind === "collection";
    case "collections":
      return item.kind === "collection";
    case "studios":
      return item.kind === "studio";
  }
}

/** A one-line summary of what else a row took with it: "2 collections · 1 Studio · 340 annotations". */
export function dependentsLine(d: ProjectTrashItem["dependents"]): string {
  const parts: string[] = [];
  const add = (n: number | undefined, one: string, other: string) => n && parts.push(`${n.toLocaleString()} ${n === 1 ? one : other}`);
  add(d.files, "file", "files");
  add(d.collections, "collection", "collections");
  add(d.studios, "Studio", "Studios");
  add(d.annotations, "annotation", "annotations");
  return parts.join(" · ");
}

const KIND_PATH: Record<DeletableKind, string> = { dataset: "datasets", collection: "collections", studio: "studios" };

// ---- Fetchers ------------------------------------------------------------------------------------

export const trashKeys = {
  list: (projectId: string, filter: TrashFilter = "all") => ["projects", projectId, "trash", filter] as const,
  all: (projectId: string) => ["projects", projectId, "trash"] as const,
  deletedProjects: () => ["org", "deleted-projects"] as const,
};

export async function fetchProjectTrash(projectId: string, filter: TrashFilter = "all"): Promise<ProjectTrash> {
  const res = await api<{ items?: Record<string, unknown>[]; count?: number; total?: number }>(`/projects/${P(projectId)}/trash?kind=${filter}`);
  const items = (res.items ?? []).map(normalizeTrashItem);
  return { items, count: res.count ?? res.total ?? items.length };
}

export const restoreBatch = (projectId: string, batchId: string) => api<RestoreResult>(`/projects/${P(projectId)}/trash/${P(batchId)}/restore`, { method: "POST" });
export const destroyBatch = (projectId: string, batchId: string) => api<{ purged: number }>(`/projects/${P(projectId)}/trash/${P(batchId)}`, { method: "DELETE" });
export const emptyProjectTrash = (projectId: string) => api<unknown>(`/projects/${P(projectId)}/trash/empty`, { method: "POST" });

export const previewDelete = (projectId: string, kind: DeletableKind, id: string) =>
  api<{ impact: Impact }>(`/projects/${P(projectId)}/${KIND_PATH[kind]}/${P(id)}?dryRun=true`, { method: "DELETE" });
export const deleteResource = (projectId: string, kind: DeletableKind, id: string) =>
  api<{ batchId: string; impact: Impact }>(`/projects/${P(projectId)}/${KIND_PATH[kind]}/${P(id)}?dryRun=false`, { method: "DELETE" });
export const renameResource = (projectId: string, kind: DeletableKind, id: string, name: string) =>
  api<unknown>(`/projects/${P(projectId)}/${KIND_PATH[kind]}/${P(id)}`, { method: "PATCH", json: { name } });

export const previewDeleteProject = (projectId: string) => api<{ impact: Impact }>(`/projects/${P(projectId)}?dryRun=true`, { method: "DELETE" });
export const deleteProject = (projectId: string) => api<{ batchId?: string; impact?: Impact }>(`/projects/${P(projectId)}?dryRun=false`, { method: "DELETE" });
export const restoreProject = (projectId: string) => api<unknown>(`/projects/${P(projectId)}/restore`, { method: "POST" });
export const fetchDeletedProjects = () => api<{ projects: DeletedProject[] }>(`/org/deleted-projects`);
export const destroyDeletedProject = (projectId: string) => api<unknown>(`/org/deleted-projects/${P(projectId)}`, { method: "DELETE" });

// ---- Hooks ---------------------------------------------------------------------------------------

/** Everything a trash or restore can change: lists, the drive, datasets, Studios, the trash itself. */
export function invalidateAfterTrash(qc: QueryClient, projectId: string) {
  void qc.invalidateQueries({ queryKey: trashKeys.all(projectId) });
  void qc.invalidateQueries({ queryKey: projectKeys.one(projectId) });
  void qc.invalidateQueries({ queryKey: ["files", projectId] });
  void qc.invalidateQueries({ queryKey: ["datasets", projectId] });
}

export function useProjectTrash(projectId: string, filter: TrashFilter) {
  return useQuery({ queryKey: trashKeys.list(projectId, filter), queryFn: () => fetchProjectTrash(projectId, filter), enabled: !!projectId });
}

export function useRestoreBatch(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (batchId: string) => restoreBatch(projectId, batchId),
    onSuccess: (r) => {
      invalidateAfterTrash(qc, projectId);
      toast(r.relocatedToRoot ? "Restored to Sources: the folder it was in is gone" : "Restored");
    },
    onError: (e) => toast(`Couldn't restore: ${messageOf(e)}`),
  });
}

export function useDestroyBatch(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (batchId: string) => destroyBatch(projectId, batchId),
    onSuccess: () => {
      invalidateAfterTrash(qc, projectId);
      toast("Deleted forever");
    },
    onError: (e) => toast(`Couldn't delete: ${messageOf(e)}`),
  });
}

export function useEmptyProjectTrash(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => emptyProjectTrash(projectId),
    onSuccess: () => {
      invalidateAfterTrash(qc, projectId);
      toast("Trash emptied");
    },
    onError: (e) => toast(`Couldn't empty Trash: ${messageOf(e)}`),
  });
}

export function useRename(projectId: string, kind: DeletableKind) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => renameResource(projectId, kind, id, name),
    onSuccess: () => invalidateAfterTrash(qc, projectId),
    onError: (e) => toast(`Couldn't rename: ${messageOf(e)}`),
  });
}

export function useDeletedProjects() {
  return useQuery({ queryKey: trashKeys.deletedProjects(), queryFn: fetchDeletedProjects });
}

export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The one toast after every delete: "Moved to Trash" with **Undo** (restores the batch) and
 * **Open Trash**. `navigate` opens the project's Trash page.
 */
export function movedToTrashToast(opts: { qc: QueryClient; projectId: string; batchId: string; what: string; openTrash: () => void }) {
  const { qc, projectId, batchId, what, openTrash } = opts;
  toast(`Moved to Trash: ${what}`, {
    id: `trash-${batchId}`,
    duration: 10_000,
    action: {
      label: <span data-testid="toast-undo">Undo</span>,
      onClick: () => {
        void restoreBatch(projectId, batchId)
          .then(() => {
            invalidateAfterTrash(qc, projectId);
            toast(`Put back: ${what}`);
          })
          .catch((e) => toast(`Couldn't undo: ${messageOf(e)}`));
      },
    },
    cancel: { label: "Open Trash", onClick: openTrash },
  });
}

// ---- Round 2: impact of a file delete, trashed items, empty states ------------------------------

/**
 * What trashing these Sources nodes takes from datasets (`GET /projects/{pid}/trash/impact`).
 * Resolves `null` when the api doesn't have the endpoint yet, so the delete still goes ahead.
 */
export async function fetchFilesImpact(projectId: string, nodeIds: string[]): Promise<Impact | null> {
  try {
    const r = await api<{ impact?: Partial<Impact> } & Partial<Impact>>(`/projects/${P(projectId)}/trash/impact?nodeIds=${nodeIds.map(P).join(",")}`);
    const i = r.impact ?? r;
    return { items: i.items ?? [], files: i.files ?? 0, datasetsLosingItems: i.datasetsLosingItems ?? [] };
  } catch {
    return null;
  }
}

/** "Used by 2 datasets (340 items)", or "" when no dataset loses an item. */
export function usedByLine(datasets: Impact["datasetsLosingItems"]): string {
  if (!datasets.length) return "";
  const items = datasets.reduce((n, d) => n + d.items, 0);
  const what = datasets.length === 1 ? datasets[0].name : `${datasets.length} datasets`;
  return `Used by ${what} (${items.toLocaleString()} ${items === 1 ? "item" : "items"})`;
}

/** A dataset item (or row) whose source file is in Trash (`state: "trashed"`). */
export function isTrashedItem(x: unknown): boolean {
  return !!x && typeof x === "object" && (x as { state?: unknown }).state === "trashed";
}

/** Every one of the dataset's files is in Trash (`filesInTrash`, `itemCount` on the dataset). */
export function allFilesInTrash(d: { filesInTrash?: number; itemCount?: number } | null | undefined): boolean {
  return !!d && !!d.filesInTrash && d.filesInTrash >= (d.itemCount ?? Number.POSITIVE_INFINITY);
}

/** "3 matches in Trash", or "" when there are none. */
export function trashedMatchesLine(n: number | undefined): string {
  return n ? `${n.toLocaleString()} ${n === 1 ? "match" : "matches"} in Trash` : "";
}
