import { useQueryClient } from "@tanstack/react-query";
import type { ComposerFiles } from "@studio/ui/ui/composer-empty-state";
import type { SeedAsset } from "@studio/contracts/types";
import { insertRegistered } from "@/studio/lib/task-items";
import { markTimeline, startTimeline, type TimelineOrigin } from "@/studio/lib/drop-timeline";
import { fromDataTransfer, fromFileList, type Picked } from "@/studio/lib/uploads/walk";
import { useUploads } from "@/studio/stores/uploads";
import { feature } from "@/studio/lib/features";
import { startDrop } from "@/studio/core/drops/start";
import { useDrops } from "@/studio/core/drops/store";

/**
 * The entry surfaces' one way to hand files over (todo13 Milestone 1, `todo13-entry`): Home,
 * the empty states and the Studio canvas call `dropFiles`, never the uploader directly.
 *
 * With `chatDrops` on, every gesture is a drop (`core/drops` `startDrop`: a `drops` row, the
 * import's `origin`, the same uploader underneath). With it off, the existing import flow
 * (`stores/uploads.ts`: attestation, hashing, 64 MB chunks, the tray), as before todo13.
 */
export type DropOrigin = "home" | "chat" | "files" | "studio";

export interface DropRequest {
  projectId: string;
  picked: Picked;
  /** Where the gesture happened (the drops table's `origin`). */
  origin: DropOrigin;
  /** The surface, for the timeline (`home`, `canvas`, `files`…). Defaults to `origin`. */
  surface?: TimelineOrigin;
  /** The conversation the files are shared in (the drawer's thread), when there is one. */
  conversationId?: string;
  /** A drop into a Studio: same-kind files become its items at once (todo11 D8, D11). */
  taskId?: string;
  /** A folder of the drive to land in (Files). */
  targetNodeId?: string;
  /** The timeline already started at the gesture (Home starts it before creating the project). */
  timelineStarted?: boolean;
  onRegistered?: (items: SeedAsset[]) => void;
  onChanged?: (projectId: string) => void;
}

/** A drop, a paste or a picker's files, folders walked (system clutter skipped and counted). */
export async function pickedFrom(files: ComposerFiles): Promise<Picked> {
  if (Array.isArray(files)) return fromFileList(files);
  if (typeof DataTransfer !== "undefined" && files instanceof DataTransfer) return fromDataTransfer(files);
  return fromFileList(files as FileList);
}

/** Start the upload; resolves once it's handed over (not when the bytes land). */
export function dropFiles(req: DropRequest): Promise<void> {
  if (!req.picked.files.length) return Promise.resolve();
  if (!req.timelineStarted) startTimeline(req.surface ?? req.origin);
  markTimeline("upload-start");
  if (feature("chatDrops")) {
    const id = startDrop(req);
    watchDrop(id);
    return Promise.resolve();
  }
  const done = useUploads.getState().add(req.projectId, req.picked, {
    targetNodeId: req.targetNodeId,
    taskId: req.taskId,
    onRegistered: req.onRegistered,
    onChanged: req.onChanged,
  });
  // `add` puts its session first synchronously (before the attestation's await).
  const key = useUploads.getState().sessions[0]?.key;
  if (key) watchUpload(key);
  return done.then(() => undefined);
}

/** The drop's first upload session, once `startDrop` has created it, feeds the timeline. */
function watchDrop(dropId: string): void {
  const first = () => useDrops.getState().drops[dropId]?.uploadKeys[0];
  const key = first();
  if (key) return watchUpload(key);
  const stop = useDrops.subscribe(() => {
    const d = useDrops.getState().drops[dropId];
    const k = d?.uploadKeys[0];
    if (k || !d || d.error) {
      stop();
      if (k) watchUpload(k);
    }
  });
}

/** Timeline steps from the tray session: the first file's bytes in, then all of them. */
function watchUpload(key: string): void {
  const stop = useUploads.subscribe((s) => {
    const session = s.sessions.find((x) => x.key === key);
    if (!session) return stop();
    if (session.files.some((f) => f.state !== "pending")) markTimeline("first-file-uploaded");
    if (session.phase === "checking" || session.phase === "done") {
      markTimeline("upload-done");
      stop();
    }
    // Not on "failed": `absorb` passes through it for a moment before "uploading" (and Retry
    // resumes a failed session); a dismissed session ends the watch above.
    if (session.phase === "cancelled") stop();
  });
}

/** `dropFiles` with the page's refresh (and, in a Studio, its items inserted as they register). */
export function useDropFiles() {
  const qc = useQueryClient();
  const refresh = (projectId: string) => {
    void qc.invalidateQueries({ queryKey: ["projects", projectId] });
    void qc.invalidateQueries({ queryKey: ["sources"] });
    void qc.invalidateQueries({ queryKey: ["source-nodes"] });
    void qc.invalidateQueries({ queryKey: ["files", projectId] });
  };
  return (req: Omit<DropRequest, "onChanged">) =>
    dropFiles({
      ...req,
      onChanged: refresh,
      onRegistered: req.onRegistered ?? (req.taskId ? (assets) => insertRegistered(qc, req.taskId!, assets) : undefined),
    });
}
