import { useFeature } from "@/studio/lib/features";
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useShallow } from "zustand/react/shallow";
import type { Drop, DropFileState } from "@studio/contracts/drops";
import { runtimeConfig } from "@/extension-host/runtime-config";
import { ApiError } from "@/studio/lib/projects-api";
import { onProjectEvent, useProjectEvents } from "@/studio/lib/use-project-events";
import { useUploads, type TrayFile } from "@/studio/stores/uploads";
import { dropsApi } from "./api";
import { useDrops, type LocalDrop } from "./store";

export const dropKeys = {
  drop: (id: string) => ["drops", id] as const,
  list: (projectId: string, conversationId?: string) => ["drops", "list", projectId, conversationId ?? ""] as const,
  enabled: (projectId: string) => ["drops", "enabled", projectId] as const,
};

const SETTLED: DropFileState[] = ["ready", "kept", "failed", "duplicate", "removed", "deleted"];

/**
 * Whether chat drops are on (`API_FEATURE_CHAT_DROPS`): the drop routes answer 404 when it's off.
 * Without the kernel (the seed server) they're off. After todo13-entry merges this becomes
 * `useFeature("chatDrops")` (`lib/features.ts`, `GET /api/v1/features`).
 */
export function useChatDropsEnabled(projectId: string | undefined) {
  // The flag from `GET /api/v1/features` (read once at start), on the full stack only.
  const on = useFeature("chatDrops");
  return { data: !!projectId && runtimeConfig().kernel && on };
}

/** Follow `drop.*` (and import progress) for the drops of a project: their queries refetch. */
export function useDropEvents(projectId: string | undefined) {
  const qc = useQueryClient();
  useProjectEvents(projectId);
  useEffect(() => {
    if (!projectId) return;
    const refresh = (data: unknown) => {
      const id = (data as { dropId?: string } | null)?.dropId;
      if (id) void qc.invalidateQueries({ queryKey: dropKeys.drop(id) });
      void qc.invalidateQueries({ queryKey: ["drops", "list", projectId] });
    };
    const offs = ["drop.received", "drop.file", "drop.failed", "drop.classified", "drop.planned", "drop.applied"].map((t) => onProjectEvent(t, refresh));
    // Imports progress, and Files changes (a dropped File moved to Trash shows "Deleted file").
    const others = ["import.updated", "fs.changed"].map((t) => onProjectEvent(t, () => void qc.invalidateQueries({ queryKey: ["drops"] })));
    return () => {
      offs.forEach((off) => off());
      others.forEach((off) => off());
    };
  }, [projectId, qc]);
}

/** The kernel's drop, refetched by events and, while files are moving, every 2 s. */
export function useDrop(dropId: string | undefined) {
  const local = useDrops((s) => (dropId ? s.drops[dropId] : undefined));
  return useQuery({
    queryKey: dropKeys.drop(dropId ?? ""),
    enabled: !!dropId && !local?.error,
    queryFn: () => dropsApi.get(dropId!),
    retry: (n, e) => n < 8 && e instanceof ApiError && e.status === 404, // the create may still be on its way
    retryDelay: 400,
    refetchInterval: (q) => {
      const d = q.state.data as Drop | undefined;
      return !d || d.files.length === 0 || d.files.some((f) => !SETTLED.includes(f.state)) ? 2000 : false;
    },
  });
}

export interface Chip {
  key: string;
  name: string;
  size: number;
  /** `preparing` before the kernel knows the file (hashing), then the kernel's states. */
  state: DropFileState | "preparing";
  progress?: number;
  reason?: string | null;
  looksLike?: string | null;
  nodeId?: string | null;
  kind?: string | null;
  preview?: string;
}

/** One chip per file: the kernel's view once it has the file, the browser's upload progress until then. */
export function chipsOf(local: LocalDrop | undefined, server: Drop | undefined, trays: { files: TrayFile[]; phase: string }[]): Chip[] {
  const preview = new Map((local?.files ?? []).map((f) => [f.relPath, f.preview]));
  const live = new Map<string, TrayFile>();
  for (const t of trays) for (const f of t.files) live.set(f.relPath, f);
  const base = (rel: string) => rel.split("/").pop() ?? rel;
  if (server && server.files.length) {
    return server.files.map((f) => {
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
        preview: preview.get(f.relPath) ?? [...preview.entries()].find(([k]) => k.endsWith(`/${f.relPath}`) || f.relPath.endsWith(`/${k}`))?.[1],
      };
    });
  }
  return (local?.files ?? []).map((f) => {
    const t = live.get(f.relPath);
    return { key: f.relPath, name: base(f.relPath), size: f.size, state: t ? (t.state === "failed" || t.state === "rejected" ? "failed" : "uploading") : "preparing", progress: t && f.size ? t.received / f.size : undefined, reason: t?.reason, preview: f.preview };
  });
}

export function useDropChips(dropId: string) {
  const local = useDrops((s) => s.drops[dropId]);
  const trays = useUploads(useShallow((s) => s.sessions.filter((x) => x.dropId === dropId)));
  const server = useDrop(dropId);
  return { local, server: server.data, trays, chips: chipsOf(local, server.data, trays), loading: server.isLoading };
}

export function useConversationDrops(projectId: string, conversationId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: dropKeys.list(projectId, conversationId),
    enabled: enabled && !!conversationId,
    queryFn: () => dropsApi.list(projectId, conversationId),
  });
}
