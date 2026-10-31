import { useEffect, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { onProjectEvent } from "@/studio/lib/use-project-events";
import { projectKeys } from "@/studio/lib/projects-api";
import { filesKeys, invalidateFolders } from "./api";
import { hasPendingOp } from "./guard";
import { useTabUndo } from "./undo";

export { shouldApplyLoad, loadIsCurrent, beginLocalOp } from "./guard";

/**
 * Live sync (todo7 §2 Feedback): the kernel's `fs.changed { projectId, parentIds, batchId,
 * actor, summary }` on the project stream invalidates only those folders' children queries
 * (every sort) and the touched nodes. Loads that started before this tab's last local change
 * to a folder are ignored by the children query itself (`guard.ts`), so a colleague's change
 * never flickers an optimistic move back. Others' changes show briefly with their name:
 * "Lam moved 2 items here".
 */
export interface FsChangedEvent {
  projectId: string;
  parentIds: string[];
  batchId: string;
  actor: string;
  /** "Moved 2 items to MRI". */
  summary: string;
  /** Touched node ids, when the kernel sends them. */
  nodeIds?: string[];
}

export interface RemoteNotice {
  id: string;
  batchId: string;
  actor: string;
  /** "Lam moved 2 items to MRI". */
  text: string;
  parentIds: string[];
  at: number;
}

/** How long a remote notice stays (ms). */
export const NOTICE_MS = 6000;

/** "user:lam" → "Lam"; seeds read "Sample data". */
export function actorName(actor: string): string {
  if (/(^|:)seed$/.test(actor)) return "Sample data";
  const name = actor.replace(/^[a-z]+:/i, "").split("@")[0];
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : "Someone";
}

/** "Lam" + "Moved 2 items to MRI" → "Lam moved 2 items to MRI". */
export const noticeText = (actor: string, summary: string) => `${actorName(actor)} ${summary ? summary.charAt(0).toLowerCase() + summary.slice(1) : "changed files"}`;

function parse(data: unknown): FsChangedEvent | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Partial<FsChangedEvent>;
  if (!Array.isArray(d.parentIds)) return null;
  return { projectId: String(d.projectId ?? ""), parentIds: d.parentIds.map(String), batchId: String(d.batchId ?? ""), actor: String(d.actor ?? ""), summary: String(d.summary ?? ""), nodeIds: Array.isArray(d.nodeIds) ? d.nodeIds.map(String) : undefined };
}

/** Is this event ours (this tab's batch, or a folder this tab is changing right now)? */
export function isOwnEvent(e: FsChangedEvent, { self }: { self?: string } = {}): boolean {
  if (self && e.actor === self) return true;
  const tab = useTabUndo.getState();
  if (tab.done.some((b) => b.batchId === e.batchId) || tab.undone.some((b) => b.batchId === e.batchId) || tab.own.includes(e.batchId)) return true;
  return e.parentIds.some((p) => hasPendingOp(e.projectId, p));
}

/** Apply one `fs.changed` to the cache. */
export function applyFsChanged(qc: QueryClient, e: FsChangedEvent): void {
  invalidateFolders(qc, e.projectId, e.parentIds);
  for (const id of e.nodeIds ?? []) void qc.invalidateQueries({ queryKey: projectKeys.node(id) });
  void qc.invalidateQueries({ queryKey: filesKeys.history(e.projectId) });
  void qc.invalidateQueries({ queryKey: filesKeys.drive(e.projectId) });
  void qc.invalidateQueries({ queryKey: filesKeys.trash(e.projectId) });
}

/**
 * Follow `fs.changed` for a project (the page must also run `useProjectEvents`, which the app
 * layout does). Returns others' recent changes, newest first, each for `NOTICE_MS`. `self` is
 * the signed-in principal when known (else own batches are recognised by this tab's batch ids).
 */
export function useFilesLive(projectId: string | undefined, { self }: { self?: string } = {}): { notices: RemoteNotice[]; dismiss: (id: string) => void } {
  const qc = useQueryClient();
  const [notices, setNotices] = useState<RemoteNotice[]>([]);

  useEffect(() => {
    if (!projectId) return;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const off = onProjectEvent("fs.changed", (data, streamProject) => {
      const e = parse(data);
      if (!e) return;
      if (!e.projectId) e.projectId = streamProject;
      if (e.projectId !== projectId) return;
      applyFsChanged(qc, e);
      if (isOwnEvent(e, { self })) return;
      const notice: RemoteNotice = { id: `${e.batchId}-${Date.now()}`, batchId: e.batchId, actor: e.actor, text: noticeText(e.actor, e.summary), parentIds: e.parentIds, at: Date.now() };
      setNotices((n) => [notice, ...n.filter((x) => x.batchId !== e.batchId)].slice(0, 5));
      const t = setTimeout(() => {
        timers.delete(t);
        setNotices((n) => n.filter((x) => x.id !== notice.id));
      }, NOTICE_MS);
      timers.add(t);
    });
    return () => {
      off();
      timers.forEach(clearTimeout);
    };
  }, [projectId, qc, self]);

  return { notices, dismiss: (id) => setNotices((n) => n.filter((x) => x.id !== id)) };
}

/** The notices about one folder ("… here"). */
export const noticesFor = (notices: RemoteNotice[], folderId: string | null | undefined): RemoteNotice[] => (folderId ? notices.filter((n) => n.parentIds.includes(folderId)) : []);
