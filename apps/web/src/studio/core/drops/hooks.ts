import { useFeature, useFeatures } from "@/studio/lib/features";
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useShallow } from "zustand/react/shallow";
import type { Drop } from "@studio/contracts/drops";
import { runtimeConfig } from "@/extension-host/runtime-config";
import { ApiError } from "@/studio/lib/projects-api";
import { onProjectEvent, projectStreamOpen, useProjectEvents } from "@/studio/lib/use-project-events";
import { noteDropProgress } from "@/studio/lib/drop-timeline";
import { NOT_UPLOADED, useUploads, type TrayFile } from "@/studio/stores/uploads";
import { dropsApi } from "./api";
import { useDrops, type LocalDrop } from "./store";
import { dropRefresh } from "./throttle";
import type { ChipState, FileState, ServerDrop } from "./progress";

export const dropKeys = {
  drop: (id: string) => ["drops", id] as const,
  list: (projectId: string, conversationId?: string) => ["drops", "list", projectId, conversationId ?? ""] as const,
  enabled: (projectId: string) => ["drops", "enabled", projectId] as const,
};

const SETTLED: FileState[] = ["ready", "in_studio", "kept", "failed", "duplicate", "removed", "deleted"];

/** Without events (stream down), a moving drop is polled this often; with them, only as a safety net. */
export const POLL_MS = 2000;
export const POLL_WITH_EVENTS_MS = 15_000;

/** todo28 W4: how often to poll a drop: never once settled, rarely while the stream carries its events. */
export function dropPollInterval(d: Pick<Drop, "files"> | undefined, streamOpen: boolean): number | false {
  const moving = !d || d.files.length === 0 || d.files.some((f) => !SETTLED.includes(f.state as FileState));
  if (!moving) return false;
  return streamOpen ? POLL_WITH_EVENTS_MS : POLL_MS;
}

/**
 * Whether chat drops are on (`API_FEATURE_CHAT_DROPS`): the drop routes answer 404 when it's off.
 * Without the kernel (the seed server) they're off. After todo13-entry merges this becomes
 * `useFeature("chatDrops")` (`lib/features.ts`, `GET /api/v1/features`).
 */
export function useChatDropsEnabled(projectId: string | undefined) {
  // The flag from `GET /api/v1/features` (read once at start), on the full stack only.
  const on = useFeature("chatDrops");
  const loaded = useFeatures((s) => s.loaded);
  const full = !!projectId && runtimeConfig().kernel;
  // `pending`: `/features` hasn't answered yet (todo15 D5): show a skeleton, not "off".
  return { data: full && on, pending: full && !loaded };
}

/** Follow `drop.*` (and import progress) for the drops of a project: their queries refetch. */
export function useDropEvents(projectId: string | undefined) {
  const qc = useQueryClient();
  useProjectEvents(projectId);
  useEffect(() => {
    if (!projectId) return;
    // todo28 W4: every card listens, but one shared throttle keyed by drop makes it at most one
    // refetch a second per drop, however many files report at once.
    const refresh = (data: unknown) => {
      const id = (data as { dropId?: string } | null)?.dropId;
      if (id) dropRefresh(id, () => void qc.invalidateQueries({ queryKey: dropKeys.drop(id) }));
      dropRefresh(`list:${projectId}`, () => void qc.invalidateQueries({ queryKey: ["drops", "list", projectId] }));
    };
    const offs = ["drop.received", "drop.file", "drop.failed", "drop.classified", "drop.planned", "drop.applied", "drop.kind_waiting", "drop.files_failed", "drop.settled", "source.node.inspected"].map((t) => onProjectEvent(t, refresh));
    // Imports progress, and Files changes (a dropped File moved to Trash shows "Deleted file").
    const others = ["import.updated", "fs.changed"].map((t) => onProjectEvent(t, () => dropRefresh(`all:${projectId}`, () => void qc.invalidateQueries({ queryKey: ["drops"] }))));
    return () => {
      offs.forEach((off) => off());
      others.forEach((off) => off());
    };
  }, [projectId, qc]);
}

/**
 * The kernel's drop: one query (so one poller) per drop, however many cards show it. Refetched
 * by events once the project stream is up, polled every 2 s only while it isn't (todo28 W4).
 */
export function useDrop(dropId: string | undefined) {
  const local = useDrops((s) => (dropId ? s.drops[dropId] : undefined));
  return useQuery({
    queryKey: dropKeys.drop(dropId ?? ""),
    enabled: !!dropId && !local?.error,
    queryFn: async () => {
      const d = await dropsApi.get(dropId!);
      noteDropProgress(d as unknown as ServerDrop);
      return d;
    },
    retry: (n, e) => n < 8 && e instanceof ApiError && e.status === 404, // the create may still be on its way
    retryDelay: 400,
    refetchInterval: (q) => {
      const d = q.state.data as Drop | undefined;
      return dropPollInterval(d, projectStreamOpen(d?.projectId ?? local?.projectId));
    },
  });
}

export interface Chip {
  key: string;
  name: string;
  size: number;
  /** `confirming` while the rights dialog is open, `preparing` before the kernel knows the file (hashing), then the kernel's states. */
  state: ChipState;
  /** Still being checked after a transient error (todo28 D3). */
  retrying?: boolean;
  progress?: number;
  reason?: string | null;
  looksLike?: string | null;
  nodeId?: string | null;
  kind?: string | null;
  preview?: string;
}

type TrayLike = { files: TrayFile[]; phase: string };

/**
 * The drop stopped before the kernel had its files: the kernel refused it, every upload of it
 * failed or was cancelled, or the page reloaded mid-way (its `File`s are gone). Never while the
 * kernel's answer is still loading, so a finished drop doesn't flash "Not uploaded" after a reload.
 */
export function dropInterrupted(local: LocalDrop | undefined, server: Drop | undefined, trays: TrayLike[], loading = false): boolean {
  if (!local || server?.files.length) return false;
  if (local.error) return true;
  if (trays.length) return trays.every((t) => t.phase === "failed" || t.phase === "cancelled");
  return !!local.restored && !loading;
}

/** One chip per file: the kernel's view once it has the file, the browser's upload progress until then. */
export function chipsOf(local: LocalDrop | undefined, server: Drop | undefined, trays: TrayLike[], loading = false): Chip[] {
  const preview = new Map((local?.files ?? []).map((f) => [f.relPath, f.preview]));
  const live = new Map<string, TrayFile>();
  for (const t of trays) for (const f of t.files) live.set(f.relPath, f);
  const base = (rel: string) => rel.split("/").pop() ?? rel;
  if (server && server.files.length) {
    return (server.files as ServerDrop["files"]).map((f) => {
      const t = live.get(f.relPath);
      const uploading = f.state === "uploading";
      const received = uploading && t ? t.received : f.received;
      return {
        key: `${f.importId}:${f.clientFileId}`,
        name: f.name,
        size: f.size,
        state: uploading && t?.state === "uploaded" ? "checking" : f.state,
        progress: uploading ? (f.size ? Math.min(1, received / f.size) : 1) : undefined,
        reason: f.reason,
        looksLike: f.looksLike,
        nodeId: f.nodeId,
        kind: f.kind,
        ...(f.retrying ? { retrying: true } : {}),
        preview: preview.get(f.relPath) ?? [...preview.entries()].find(([k]) => k.endsWith(`/${f.relPath}`) || f.relPath.endsWith(`/${k}`))?.[1],
      };
    });
  }
  const stopped = dropInterrupted(local, server, trays, loading);
  return (local?.files ?? []).map((f) => {
    const t = live.get(f.relPath);
    if (stopped && (!t || t.state !== "uploaded")) return { key: f.relPath, name: base(f.relPath), size: f.size, state: "failed" as const, reason: t?.state === "rejected" ? t.reason : NOT_UPLOADED, preview: f.preview };
    // todo28 (todo26 W2d): while the rights dialog is open the files wait on the person, not on us.
    if (trays.some((x) => x.phase === "attesting") && (!t || t.state === "pending")) return { key: f.relPath, name: base(f.relPath), size: f.size, state: "confirming" as const, preview: f.preview };
    return { key: f.relPath, name: base(f.relPath), size: f.size, state: t ? (t.state === "failed" || t.state === "rejected" ? "failed" : "uploading") : "preparing", progress: t && f.size ? t.received / f.size : undefined, reason: t?.reason, preview: f.preview };
  });
}

export function useDropChips(dropId: string) {
  const local = useDrops((s) => s.drops[dropId]);
  const trays = useUploads(useShallow((s) => s.sessions.filter((x) => x.dropId === dropId)));
  const server = useDrop(dropId);
  const loading = server.isLoading;
  return { local, server: server.data, trays, chips: chipsOf(local, server.data, trays, loading), loading, interrupted: dropInterrupted(local, server.data, trays, loading), missing: !local && server.isError };
}

export function useConversationDrops(projectId: string, conversationId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: dropKeys.list(projectId, conversationId),
    enabled: enabled && !!conversationId,
    queryFn: () => dropsApi.list(projectId, conversationId),
  });
}
