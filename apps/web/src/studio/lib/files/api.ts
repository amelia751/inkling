import { invalidateFor } from "@/studio/lib/invalidate";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import type {
  ChildrenPage,
  DatasetSummary,
  DriveInfo,
  FsActivityEntry,
  FsConflict,
  FsConflictError,
  FsOp,
  FsOpsRequest,
  FsOpsResult,
  FsShortcut,
  FsUndoResult,
  ImportSession,
  NodeVersion,
  SourceNode,
  TrashPage,
} from "@studio/contracts/types";
import { RES } from "@studio/contracts/naming";
import { personKey } from "@/studio/lib/person-key";
import { apiUrl, devStoresAllowed } from "@/extension-host/runtime-config";
import { api, ApiError, NeedsApiError, projectKeys } from "@/studio/lib/projects-api";
import { hashFiles } from "@/studio/lib/uploads/hash";
import { beginLocalOp, guardNow, loadIsCurrent } from "./guard";
import { DEFAULT_SORT, foldersTouched, patchFolder, patchStar, rowsOf, type ChildrenData, type FsSort } from "./optimistic";
import { useTabUndo } from "./undo";
import { apiFetch } from "@/extension-host/http";

export { NeedsApiError, ApiError };
export type { FsSort, FsSortKey, ChildrenData } from "./optimistic";
export { DEFAULT_SORT } from "./optimistic";

/**
 * The Files API (docs/files-api.md, todo7): typed fetchers and React Query hooks for every
 * route. Writes are optimistic on the cached children pages and roll back on error; the
 * server's journal is the truth for undo (D9). The seed stand-in answers 501 to writes
 * (`NeedsApiError`: the UI says "Needs the full stack", D12).
 */

// ---- Errors --------------------------------------------------------------------------------------

/** `409 { detail: { message, conflicts } }` from `fs/ops`: settle each conflict and retry with `resolutions`. */
export class FsConflictApiError extends ApiError {
  constructor(
    message: string,
    readonly conflicts: FsConflict[],
    body?: unknown,
  ) {
    super(409, message, body);
  }
}

/** `423`: sample data (D2) or a privacy-held file. The message says which. */
export class LockedError extends ApiError {
  constructor(message: string, body?: unknown) {
    super(423, message || "Sample data can't be changed. Copy it to make your own", body);
  }
}

/** Turn an `ApiError` into the typed Files errors. */
export function toFsError(e: unknown): unknown {
  if (!(e instanceof ApiError) || e instanceof FsConflictApiError || e instanceof LockedError) return e;
  if (e.status === 423) return new LockedError(e.message, e.body);
  if (e.status === 409) {
    const detail = (e.body as { detail?: unknown } | undefined)?.detail as Partial<FsConflictError> | undefined;
    if (detail && typeof detail === "object" && Array.isArray(detail.conflicts)) return new FsConflictApiError(detail.message ?? e.message, detail.conflicts, e.body);
  }
  return e;
}

async function fsApi<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  try {
    return await api<T>(path, init);
  } catch (e) {
    throw toFsError(e);
  }
}

// ---- Keys ----------------------------------------------------------------------------------------

const P = (projectId: string) => encodeURIComponent(projectId);
const N = (nodeId: string) => encodeURIComponent(nodeId);
const sortKey = (s: FsSort) => `${s.by}:${s.dir}`;

/** Every Files query key. Children keys are prefixes: `children(p, id)` matches every sort of that folder. */
export const filesKeys = {
  all: ["files"] as const,
  project: (projectId: string) => ["files", projectId] as const,
  drive: (projectId: string) => ["files", projectId, "drive"] as const,
  childrenAll: (projectId: string) => ["files", projectId, "children"] as const,
  /** `nodeId` null is the root before `useDrive` answered; prefer the real root id. */
  children: (projectId: string, nodeId: string | null, sort?: FsSort) => (sort ? (["files", projectId, "children", nodeId ?? "", sortKey(sort)] as const) : (["files", projectId, "children", nodeId ?? ""] as const)),
  history: (projectId: string) => ["files", projectId, "history"] as const,
  trash: (projectId: string) => ["files", projectId, "trash"] as const,
  emptyTrashPreview: (projectId: string) => ["files", projectId, "trash", "empty-preview"] as const,
  starred: (projectId: string) => ["files", projectId, "starred"] as const,
  recent: (projectId: string) => ["files", projectId, "recent"] as const,
  /** Same as `projectKeys.node`: the inspector's detail. */
  node: (nodeId: string) => projectKeys.node(nodeId),
  versions: (nodeId: string) => ["source-nodes", nodeId, "versions"] as const,
  activity: (nodeId: string) => ["source-nodes", nodeId, "activity"] as const,
  updateVersionsPreview: (projectId: string, datasetId: string) => ["projects", projectId, "datasets", datasetId, "update-versions"] as const,
};

// ---- Fetchers ------------------------------------------------------------------------------------

export const fetchDrive = (projectId: string) => fsApi<DriveInfo>(`/projects/${P(projectId)}/fs`);

export const fetchFsChildren = (projectId: string, nodeId: string | null, sort: FsSort = DEFAULT_SORT, cursor?: string | null, limit?: number) =>
  fsApi<ChildrenPage>(
    `/projects/${P(projectId)}/fs/children?${new URLSearchParams({ ...(nodeId ? { node: nodeId } : {}), ...(cursor ? { cursor } : {}), ...(limit ? { limit: String(limit) } : {}), sort: sort.by, dir: sort.dir })}`,
  );

export const postFsOps = (projectId: string, body: FsOpsRequest) => fsApi<FsOpsResult>(`/projects/${P(projectId)}/fs/ops`, { method: "POST", json: body });
export const postUndo = (projectId: string, batchId?: string) => fsApi<FsUndoResult>(`/projects/${P(projectId)}/fs/undo`, { method: "POST", json: batchId ? { batchId } : {} });
/** todo16: restore everything deleted together in one Trash batch (any kind). */
export const restoreTrashBatch = (projectId: string, batchId: string) => fsApi<{ restored: unknown[]; relocatedToRoot: boolean }>(`/projects/${P(projectId)}/trash/${encodeURIComponent(batchId)}/restore`, { method: "POST", json: {} });
export const postRedo = (projectId: string, batchId?: string) => fsApi<FsUndoResult>(`/projects/${P(projectId)}/fs/redo`, { method: "POST", json: batchId ? { batchId } : {} });

export interface FsHistory {
  undo: { batchId: string; label: string } | null;
  redo: { batchId: string; label: string } | null;
}
export const fetchFsHistory = (projectId: string, limit?: number) => fsApi<FsHistory>(`/projects/${P(projectId)}/fs/history${limit ? `?limit=${limit}` : ""}`);

export const fetchTrash = (projectId: string, cursor?: string | null) => fsApi<TrashPage>(`/projects/${P(projectId)}/trash${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
export interface EmptyTrashResult {
  purged: number;
  keptBytes: { name: string; reason: string }[];
  byKind?: { sources: number; datasets: number; collections: number; studios: number };
}
/** Sources › Trash empties files only (`kind=sources`, todo18 P0-1); the project Trash empties every kind. */
export const emptyTrashUrl = (projectId: string, preview = false) => `/projects/${P(projectId)}/trash/empty${preview ? "/preview" : ""}?kind=sources`;
export const postEmptyTrash = (projectId: string) => fsApi<EmptyTrashResult>(emptyTrashUrl(projectId), { method: "POST" });
export const fetchEmptyTrashPreview = (projectId: string) => fsApi<EmptyTrashResult>(emptyTrashUrl(projectId, true));

export const fetchStarred = (projectId: string) => fsApi<{ items: FsShortcut[] }>(`/projects/${P(projectId)}/starred`).then((r) => r.items);
export const fetchRecent = (projectId: string) => fsApi<{ items: FsShortcut[] }>(`/projects/${P(projectId)}/recent`).then((r) => r.items);
export const putStar = (nodeId: string, starred: boolean) => fsApi<{ starred: boolean }>(`/source-nodes/${N(nodeId)}/star`, { method: starred ? "POST" : "DELETE" });

export const fetchVersions = (nodeId: string) => fsApi<{ versions: NodeVersion[] }>(`/source-nodes/${N(nodeId)}/versions`).then((r) => r.versions);
export const postRestoreVersion = (nodeId: string, version: number) => fsApi<FsOpsResult>(`/source-nodes/${N(nodeId)}/versions/${version}/restore`, { method: "POST" });
export const fetchActivity = (nodeId: string) => fsApi<{ items: FsActivityEntry[] }>(`/source-nodes/${N(nodeId)}/activity`).then((r) => r.items);

export interface UpdateVersionsPreview {
  files: { nodeId: string; name: string; from: number; to: number; annotations: number }[];
}
export const fetchUpdateVersionsPreview = (projectId: string, datasetId: string) =>
  fsApi<UpdateVersionsPreview>(`/projects/${P(projectId)}/datasets/${encodeURIComponent(datasetId)}/update-versions/preview`);
export const postUpdateVersions = (projectId: string, datasetId: string, nodeIds?: string[]) =>
  fsApi<DatasetSummary>(`/projects/${P(projectId)}/datasets/${encodeURIComponent(datasetId)}/update-versions`, { method: "POST", json: nodeIds ? { nodeIds } : {} });
export const postAddFollowed = (projectId: string, datasetId: string) => fsApi<DatasetSummary>(`/projects/${P(projectId)}/datasets/${encodeURIComponent(datasetId)}/add-followed`, { method: "POST" });

// ---- Downloads -----------------------------------------------------------------------------------

/** The signed-redirect URL of one file (`GET /source-nodes/:id/download`). */
export const downloadUrl = (nodeId: string) => apiUrl(`/v1/source-nodes/${N(nodeId)}/download`);

/** One version's bytes (`GET /source-nodes/:id/versions/:v/download`), named "name (v1).ext". */
export const versionDownloadUrl = (nodeId: string, version: number) => apiUrl(`/v1/source-nodes/${N(nodeId)}/versions/${version}/download`);

/** Download one version of a file (audited server-side like any download). */
export function downloadVersion(nodeId: string, version: number): void {
  clickDownload(versionDownloadUrl(nodeId, version));
}

/** Download one file (the browser follows the signed redirect; audited server-side). */
export function downloadNode(nodeId: string): void {
  clickDownload(downloadUrl(nodeId));
}

function clickDownload(href: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.rel = "noopener";
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export interface ZipProgress {
  /** Bytes received so far. */
  received: number;
  /** From Content-Length when the server sent one; a streamed ZIP usually doesn't. */
  total: number | null;
  /** Files left out because they're held for privacy review (listed in `_held_files.txt`). */
  held: number;
}

/**
 * Download a folder or a selection as one streamed ZIP (`POST /projects/:id/fs/zip`). Writes
 * straight to disk where the browser offers a save picker (constant memory), else gathers a
 * Blob. Resolves with the bytes received; rejects with `AbortError` when cancelled, `LockedError`
 * (423) or `NeedsApiError` (501, the seed stand-in).
 */
export async function downloadZip(
  projectId: string,
  nodeIds: string[],
  { filename = "files.zip", onProgress, signal }: { filename?: string; onProgress?: (p: ZipProgress) => void; signal?: AbortSignal } = {},
): Promise<ZipProgress> {
  type Picker = (o: { suggestedName: string; types?: unknown[] }) => Promise<{ createWritable: () => Promise<WritableStreamDefaultWriter & { write: (b: Uint8Array) => Promise<void>; close: () => Promise<void> }> }>;
  const picker = (globalThis as unknown as { showSaveFilePicker?: Picker }).showSaveFilePicker;
  // Ask where to save first (the picker needs the click's user activation).
  const sink = picker ? await picker({ suggestedName: filename }).then((h) => h.createWritable()).catch((e: unknown) => {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    return null;
  }) : null;
  const res = await apiFetch(apiUrl(`/v1/projects/${P(projectId)}/fs/zip`), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nodeIds }), signal });
  if (res.status === 501) throw new NeedsApiError();
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: unknown };
    throw toFsError(new ApiError(res.status, typeof body.detail === "string" ? body.detail : `${res.status} ${res.statusText}`, body));
  }
  const total = Number(res.headers.get("Content-Length")) || null;
  const progress: ZipProgress = { received: 0, total, held: Number(res.headers.get("X-Held-Files")) || 0 };
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      progress.received += value.byteLength;
      if (sink) await sink.write(value);
      else chunks.push(value);
      onProgress?.({ ...progress });
    }
  }
  if (sink) await sink.close();
  else {
    const url = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: "application/zip" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return progress;
}

// ---- Replace with a new version (D6) -------------------------------------------------------------

const CHUNK = 8 * 1024 * 1024;

/**
 * Upload `file` as a new version of `nodeId`: hash it, open a replace-mode upload session
 * (`POST /source-nodes/:id/versions`), send the bytes, complete. Inspection re-runs on the new
 * bytes server-side.
 */
export async function replaceFile(nodeId: string, file: File, { onProgress, signal }: { onProgress?: (sent: number, total: number) => void; signal?: AbortSignal } = {}): Promise<ImportSession> {
  const [sha256] = await hashFiles([file], () => {}, signal);
  const session = await fsApi<ImportSession>(`/source-nodes/${N(nodeId)}/versions`, {
    method: "POST",
    json: { attested: true, mode: "replace", files: [{ clientFileId: "f0", relPath: file.name, size: file.size, sha256 }] },
    signal,
  });
  const entry = session.files?.[0];
  if (!entry || entry.state === "pending") {
    let offset = entry?.received ?? 0;
    do {
      const res = await apiFetch(apiUrl(`/v1/uploads/${session.id}/files/f0?offset=${offset}`), { method: "PUT", body: file.slice(offset, offset + CHUNK), signal });
      const body = (await res.json().catch(() => ({}))) as { received?: number; state?: string; detail?: string };
      if (!res.ok) throw toFsError(new ApiError(res.status, body.detail ?? `${res.status}`, body));
      offset = body.received ?? offset + Math.min(CHUNK, file.size - offset);
      onProgress?.(offset, file.size);
      if (body.state && body.state !== "pending") break;
    } while (offset < file.size);
  }
  return fsApi<ImportSession>(`/imports/${session.id}/complete`, { method: "POST" });
}

// ---- Local stars (the seed stand-in, D12) --------------------------------------------------------

const STAR_KEY = () => personKey(`${RES}-files-stars`);

interface LocalStars {
  /** By project: starred node snapshots. */
  byProject: Record<string, Record<string, SourceNode>>;
  set: (projectId: string, node: SourceNode, starred: boolean) => void;
}

function readStars(): LocalStars["byProject"] {
  try {
    return JSON.parse(localStorage.getItem(STAR_KEY()) ?? "{}") as LocalStars["byProject"];
  } catch {
    return {};
  }
}

/** Stars kept in localStorage when the server can't (`writable: false`), so Phase 5's nav works in seed mode. */
export const useLocalStars = create<LocalStars>((set) => ({
  byProject: typeof localStorage === "undefined" ? {} : readStars(),
  set: (projectId, node, starred) =>
    set((s) => {
      const mine = { ...(s.byProject[projectId] ?? {}) };
      if (starred) mine[node.id] = { ...node, starred: true };
      else delete mine[node.id];
      const byProject = { ...s.byProject, [projectId]: mine };
      try {
        localStorage.setItem(STAR_KEY(), JSON.stringify(byProject));
      } catch {
        // Storage may be unavailable (private mode): stars last for the session.
      }
      return { byProject };
    }),
}));

// ---- Hooks: reads --------------------------------------------------------------------------------

export function useDrive(projectId: string | undefined) {
  return useQuery({ queryKey: filesKeys.drive(projectId ?? ""), queryFn: () => fetchDrive(projectId!), enabled: !!projectId, staleTime: 30_000 });
}

/** The cached page at `cursor` for a children query, if any (to keep a guarded view). */
function cachedPage(qc: QueryClient, key: readonly unknown[], cursor: string | null): ChildrenPage | undefined {
  const data = qc.getQueryData<ChildrenData>(key);
  if (!data) return undefined;
  const i = data.pageParams.indexOf(cursor);
  return i >= 0 ? data.pages[i] : undefined;
}

/**
 * A folder's children, a page (500) at a time, sorted server-side so paging stays correct.
 * Pass the real folder id (`useDrive().data.rootNodeId` for the root). A load that started
 * before this tab's last change to the folder is ignored (`guard.ts`), so an optimistic move
 * never flickers back. Local stars (seed mode) are merged into `starred`.
 */
export function useFsChildren(projectId: string, nodeId: string | null, sort: FsSort = DEFAULT_SORT, { enabled = true }: { enabled?: boolean } = {}) {
  const qc = useQueryClient();
  const local = useLocalStars((s) => s.byProject[projectId]);
  const key = filesKeys.children(projectId, nodeId, sort);
  return useInfiniteQuery({
    queryKey: key,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const started = guardNow();
      const page = await fsApi<ChildrenPage>(
        `/projects/${P(projectId)}/fs/children?${new URLSearchParams({ ...(nodeId ? { node: nodeId } : {}), ...(pageParam ? { cursor: pageParam } : {}), sort: sort.by, dir: sort.dir })}`,
        { signal },
      );
      if (nodeId && !loadIsCurrent(projectId, nodeId, started)) return cachedPage(qc, key, pageParam) ?? page;
      return page;
    },
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && !!projectId,
    staleTime: 10_000,
    select: local && Object.keys(local).length ? (d: ChildrenData) => ({ ...d, pages: d.pages.map((p) => ({ ...p, items: p.items.map((x) => (local[x.id] ? { ...x, starred: true } : x)) })) }) : undefined,
  });
}

export function useFsHistory(projectId: string) {
  return useQuery({ queryKey: filesKeys.history(projectId), queryFn: () => fetchFsHistory(projectId), enabled: !!projectId, staleTime: 5_000 });
}

export function useTrash(projectId: string, { enabled = true }: { enabled?: boolean } = {}) {
  return useInfiniteQuery({
    queryKey: filesKeys.trash(projectId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => fetchTrash(projectId, pageParam),
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && !!projectId,
    staleTime: 10_000,
  });
}

export function useEmptyTrashPreview(projectId: string, enabled = true) {
  return useQuery({ queryKey: filesKeys.emptyTrashPreview(projectId), queryFn: () => fetchEmptyTrashPreview(projectId), enabled: enabled && !!projectId });
}

/** Starred items (server's, plus local stars in seed mode), newest first. */
export function useStarred(projectId: string) {
  const local = useLocalStars((s) => s.byProject[projectId]);
  const q = useQuery({ queryKey: filesKeys.starred(projectId), queryFn: () => fetchStarred(projectId), enabled: !!projectId, staleTime: 10_000 });
  const server = q.data ?? [];
  const extra = Object.values(local ?? {})
    .filter((n) => !server.some((s) => s.node.id === n.id))
    .map((node): FsShortcut => ({ node, at: null }));
  return { ...q, data: q.data || extra.length ? [...server, ...extra] : q.data };
}

export function useRecent(projectId: string) {
  return useQuery({ queryKey: filesKeys.recent(projectId), queryFn: () => fetchRecent(projectId), enabled: !!projectId, staleTime: 10_000 });
}

export function useVersions(nodeId: string | null | undefined) {
  return useQuery({ queryKey: filesKeys.versions(nodeId ?? ""), queryFn: () => fetchVersions(nodeId!), enabled: !!nodeId, staleTime: 10_000 });
}

export function useActivity(nodeId: string | null | undefined) {
  return useQuery({ queryKey: filesKeys.activity(nodeId ?? ""), queryFn: () => fetchActivity(nodeId!), enabled: !!nodeId, staleTime: 10_000 });
}

export function useUpdateVersionsPreview(projectId: string, datasetId: string, enabled = true) {
  return useQuery({ queryKey: filesKeys.updateVersionsPreview(projectId, datasetId), queryFn: () => fetchUpdateVersionsPreview(projectId, datasetId), enabled: enabled && !!datasetId });
}

// ---- Cache helpers -------------------------------------------------------------------------------

type ChildrenEntry = [key: readonly unknown[], data: ChildrenData | undefined];

const folderOfKey = (key: readonly unknown[]) => String(key[3] ?? "");
const sortOfKey = (key: readonly unknown[]): FsSort => {
  const [by, dir] = String(key[4] ?? "name:asc").split(":");
  return { by: (by as FsSort["by"]) || "name", dir: dir === "desc" ? "desc" : "asc" };
};

/** Find a node in any cached children page of the project. */
export function findCachedNode(qc: QueryClient, projectId: string, nodeId: string): SourceNode | undefined {
  for (const [, data] of qc.getQueriesData<ChildrenData>({ queryKey: filesKeys.childrenAll(projectId) })) {
    const row = rowsOf(data).find((x) => x.id === nodeId);
    if (row) return row;
  }
  return qc.getQueryData<SourceNode>(projectKeys.node(nodeId));
}

/** Invalidate the children of these folders (every sort), and the drive's counts. */
export function invalidateFolders(qc: QueryClient, projectId: string, folderIds: Iterable<string>, root?: string | null): void {
  const rootId = root ?? qc.getQueryData<DriveInfo>(filesKeys.drive(projectId))?.rootNodeId;
  for (const id of new Set(folderIds)) {
    void qc.invalidateQueries({ queryKey: filesKeys.children(projectId, id) });
    if (id === rootId) void qc.invalidateQueries({ queryKey: filesKeys.children(projectId, null) });
    void qc.invalidateQueries({ queryKey: projectKeys.node(id) });
  }
}

export interface OptimisticContext {
  snapshot: ChildrenEntry[];
  settle: () => void;
  folders: string[];
}

/**
 * Apply `ops` to every cached children page of the project (all sorts), after cancelling
 * in-flight loads of the touched folders. Returns what `rollback` needs.
 */
export async function applyOptimistic(qc: QueryClient, projectId: string, ops: FsOp[]): Promise<OptimisticContext> {
  const parentOf = (id: string) => findCachedNode(qc, projectId, id)?.parentId;
  const folders = foldersTouched(ops, parentOf);
  await Promise.all(folders.map((f) => qc.cancelQueries({ queryKey: filesKeys.children(projectId, f) })));
  const entries = qc.getQueriesData<ChildrenData>({ queryKey: filesKeys.childrenAll(projectId) });
  // Rows as they were before any patch (a move removes the row from its old folder first).
  const before = new Map<string, SourceNode>();
  for (const [, data] of entries) for (const row of rowsOf(data)) if (!before.has(row.id)) before.set(row.id, row);
  const lookup = (id: string) => before.get(id) ?? findCachedNode(qc, projectId, id);
  const snapshot: ChildrenEntry[] = [];
  const touched = new Set(folders);
  const trashOp = ops.some((o) => o.kind === "trash" || o.kind === "purge" || o.kind === "restore");
  for (const [key, data] of entries) {
    if (!data) continue;
    const folder = folderOfKey(key);
    if (!touched.has(folder) && !trashOp) continue;
    const next = patchFolder(folder, data, ops, lookup, sortOfKey(key));
    if (next !== data) {
      snapshot.push([key, data]);
      qc.setQueryData(key, next);
    }
  }
  // Renames show in the inspector's title at once.
  for (const op of ops) {
    if (op.kind !== "rename") continue;
    const detail = qc.getQueryData<SourceNode>(projectKeys.node(op.nodeId));
    if (detail) {
      snapshot.push([projectKeys.node(op.nodeId), detail as unknown as ChildrenData]);
      qc.setQueryData(projectKeys.node(op.nodeId), { ...detail, name: op.name });
    }
  }
  const settle = beginLocalOp(projectId, folders);
  return { snapshot, settle, folders };
}

/** Put the snapshot back (the server refused). */
export function rollback(qc: QueryClient, ctx: OptimisticContext | undefined): void {
  if (!ctx) return;
  for (const [key, data] of ctx.snapshot) qc.setQueryData(key, data);
}

// ---- Hooks: writes -------------------------------------------------------------------------------

export interface FsOpsVariables extends FsOpsRequest {
  /** Patch the cached pages before the server answers (default true). */
  optimistic?: boolean;
}

/**
 * Every namespace write (`POST /projects/:id/fs/ops`): optimistic on the children pages,
 * rolled back on error. Errors arrive typed: `FsConflictApiError` (settle `conflicts`, then
 * `mutateAsync({ ...vars, resolutions })`), `LockedError`, `NeedsApiError` (seed), `ApiError`
 * (422 names and cycles: its message is the sentence to show). On success the batch is
 * recorded for this tab's undo labels.
 */
export function useFsOps(projectId: string) {
  const qc = useQueryClient();
  return useMutation<FsOpsResult, Error, FsOpsVariables, OptimisticContext | undefined>({
    mutationFn: ({ optimistic: _o, ...body }) => postFsOps(projectId, body),
    onMutate: async (vars) => (vars.optimistic === false ? undefined : applyOptimistic(qc, projectId, vars.ops)),
    onError: (_e, _vars, ctx) => rollback(qc, ctx),
    onSuccess: (res) => {
      useTabUndo.getState().record({ batchId: res.batchId, projectId, label: res.summary });
      for (const n of res.nodes) {
        const detail = qc.getQueryData<SourceNode>(projectKeys.node(n.id));
        if (detail) qc.setQueryData(projectKeys.node(n.id), { ...detail, ...n });
      }
    },
    onSettled: (res, _e, vars, ctx) => {
      ctx?.settle();
      const touched = foldersTouched(vars.ops, (id) => findCachedNode(qc, projectId, id)?.parentId);
      invalidateFolders(qc, projectId, [...(ctx?.folders ?? []), ...touched, ...(res?.parentIds ?? [])]);
      void qc.invalidateQueries({ queryKey: filesKeys.history(projectId) });
      void qc.invalidateQueries({ queryKey: filesKeys.drive(projectId) });
      if (vars.ops.some((o) => o.kind === "trash" || o.kind === "restore" || o.kind === "purge")) void qc.invalidateQueries({ queryKey: filesKeys.trash(projectId) });
      void qc.invalidateQueries({ queryKey: filesKeys.recent(projectId) });
    },
  });
}

function useUndoRedo(projectId: string, dir: "undo" | "redo") {
  const qc = useQueryClient();
  return useMutation<FsUndoResult, Error, { batchId?: string } | void>({
    mutationFn: (v) => (dir === "undo" ? postUndo : postRedo)(projectId, v ? v.batchId : undefined),
    onSuccess: (res) => {
      const tab = useTabUndo.getState();
      if (res.batchId) tab.noteOwn(res.batchId);
      if (dir === "undo") tab.markUndone(res.undoneBatchId);
      else tab.markRedone(res.undoneBatchId);
      invalidateFolders(qc, projectId, res.parentIds);
      for (const n of res.nodes) void qc.invalidateQueries({ queryKey: projectKeys.node(n.id) });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: filesKeys.history(projectId) });
      void qc.invalidateQueries({ queryKey: filesKeys.drive(projectId) });
      void qc.invalidateQueries({ queryKey: filesKeys.trash(projectId) });
    },
  });
}

/** ⌘Z: undo the caller's last batch (or `{ batchId }`). Refusals are `ApiError` 409 with the reason ("Can't undo: patient_002 changed after that"). */
export const useUndo = (projectId: string) => useUndoRedo(projectId, "undo");
/** ⇧⌘Z. */
export const useRedo = (projectId: string) => useUndoRedo(projectId, "redo");

export function useEmptyTrash(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => postEmptyTrash(projectId),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: filesKeys.trash(projectId) });
      void qc.invalidateQueries({ queryKey: filesKeys.drive(projectId) });
    },
  });
}

/**
 * Star or unstar (`POST|DELETE /source-nodes/:id/star`), optimistic on the cached rows. Without
 * the full stack (501) the star is kept in localStorage instead (pass `node` for that), in dev
 * mode only: a signed-in stage never keeps a star the server didn't (todo22 W5).
 */
export function useStar(projectId: string) {
  const qc = useQueryClient();
  return useMutation<{ starred: boolean; local?: boolean }, Error, { nodeId: string; starred: boolean; node?: SourceNode }, ChildrenEntry[]>({
    mutationFn: async ({ nodeId, starred, node }) => {
      try {
        return await putStar(nodeId, starred);
      } catch (e) {
        const n = node ?? findCachedNode(qc, projectId, nodeId);
        if (e instanceof NeedsApiError && n && devStoresAllowed()) {
          useLocalStars.getState().set(projectId, n, starred);
          return { starred, local: true };
        }
        throw e;
      }
    },
    onMutate: async ({ nodeId, starred }) => {
      const snapshot: ChildrenEntry[] = [];
      for (const [key, data] of qc.getQueriesData<ChildrenData>({ queryKey: filesKeys.childrenAll(projectId) })) {
        if (!data) continue;
        const next = patchStar(data, nodeId, starred);
        if (next !== data) {
          snapshot.push([key, data]);
          qc.setQueryData(key, next);
        }
      }
      return snapshot;
    },
    onError: (_e, _v, snapshot) => snapshot?.forEach(([key, data]) => qc.setQueryData(key, data)),
    onSettled: (_r, _e, { nodeId }) => {
      void qc.invalidateQueries({ queryKey: filesKeys.starred(projectId) });
      void qc.invalidateQueries({ queryKey: projectKeys.node(nodeId) });
    },
  });
}

export function useRestoreVersion(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, version }: { nodeId: string; version: number }) => postRestoreVersion(nodeId, version),
    onSuccess: (res) => useTabUndo.getState().record({ batchId: res.batchId, projectId, label: res.summary }),
    onSettled: (res, _e, { nodeId }) => {
      void qc.invalidateQueries({ queryKey: filesKeys.versions(nodeId) });
      void qc.invalidateQueries({ queryKey: filesKeys.activity(nodeId) });
      void qc.invalidateQueries({ queryKey: projectKeys.node(nodeId) });
      if (res) invalidateFolders(qc, projectId, res.parentIds);
    },
  });
}

/** "Replace with new version…" (D6): `mutate({ nodeId, file, onProgress? })`. */
export function useReplaceFile(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, file, onProgress, signal }: { nodeId: string; file: File; onProgress?: (sent: number, total: number) => void; signal?: AbortSignal }) => replaceFile(nodeId, file, { onProgress, signal }),
    onSettled: (_r, _e, { nodeId }) => {
      void qc.invalidateQueries({ queryKey: filesKeys.versions(nodeId) });
      void qc.invalidateQueries({ queryKey: filesKeys.activity(nodeId) });
      void qc.invalidateQueries({ queryKey: projectKeys.node(nodeId) });
      const parent = findCachedNode(qc, projectId, nodeId)?.parentId;
      if (parent) invalidateFolders(qc, projectId, [parent]);
    },
  });
}

/** Datasets (D6): move pinned files to their current version. */
export function useUpdateVersions(projectId: string, datasetId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v?: { nodeIds?: string[] }) => postUpdateVersions(projectId, datasetId, v?.nodeIds),
    onSettled: () => {
      invalidateFor(qc, projectId, "dataset.changed", { datasetId });
      void qc.invalidateQueries({ queryKey: projectKeys.activity(projectId) });
    },
  });
}

/** Datasets (D7): add the new files from followed folders. */
export function useAddFollowed(projectId: string, datasetId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => postAddFollowed(projectId, datasetId),
    onSettled: () => {
      invalidateFor(qc, projectId, "dataset.changed", { datasetId });
      void qc.invalidateQueries({ queryKey: projectKeys.activity(projectId) });
    },
  });
}

/**
 * How many things are in the project's Trash, for the sidebar's Trash item (todo16 Milestone 0).
 * Reads `count` (the all-kinds Trash API) and falls back to the file Trash's `total`; undefined
 * while loading or when the Trash can't be read (seed mode, no access), so the item shows no badge.
 * Its key sits under `filesKeys.trash`, so every invalidation of the Trash refreshes it.
 */
export function useTrashCount(projectId: string | undefined): number | undefined {
  const q = useQuery({
    queryKey: [...filesKeys.trash(projectId ?? ""), "count"] as const,
    queryFn: () => fetchTrash(projectId!) as Promise<TrashPage & { count?: number }>,
    enabled: !!projectId,
    retry: false,
    staleTime: 30_000,
    select: (d) => (typeof d.count === "number" ? d.count : typeof d.total === "number" ? d.total : undefined),
  });
  return q.isError ? undefined : q.data;
}
