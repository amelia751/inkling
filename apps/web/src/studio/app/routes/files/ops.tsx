import { useCallback, useRef, useState, type ReactNode } from "react";
import type { FsConflict, FsOp, FsOpsResult, FsResolution } from "@studio/contracts/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@studio/ui/ui/alert-dialog";
import { ConflictDialog, NEEDS_FULL_STACK } from "@/studio/components/files";
import { ApiError, fetchFsChildren, FsConflictApiError, LockedError, NeedsApiError, useFsOps, useRedo, useUndo } from "@/studio/lib/files/api";

/**
 * A numbered run (`seq:…`) is a row, not a node: an op on it means its files. Replace run ids
 * with the ids of the files they stand for (every page).
 */
export async function expandRuns(projectId: string, ids: string[]): Promise<string[]> {
  if (!ids.some((id) => id.startsWith("seq:"))) return ids;
  const out: string[] = [];
  for (const id of ids) {
    if (!id.startsWith("seq:")) {
      out.push(id);
      continue;
    }
    let cursor: string | null | undefined = null;
    do {
      const page = await fetchFsChildren(projectId, id, undefined, cursor);
      out.push(...page.items.map((n) => n.id));
      cursor = page.nextCursor;
    } while (cursor);
  }
  return [...new Set(out)];
}
import { notify } from "@/studio/lib/files/announce";
import { useFilesClipboard } from "@/studio/lib/files/clipboard";

/**
 * Every namespace write on the Files page goes through `run` (todo7 §2 Feedback): optimistic
 * (`useFsOps`), a 409 opens the conflict dialog and retries once with the resolutions, a 423 on
 * sample data offers "Copy instead", the seed stand-in says "Needs the full stack", and every
 * outcome is one toast plus a live-region sentence, with **Undo** through the server's journal.
 */
export interface RunOptions {
  /** Patch the cached pages first (default true). */
  optimistic?: boolean;
  /** No success toast (a step of a bigger action that says its own sentence). */
  quiet?: boolean;
  /** Settled up front (e.g. Duplicate's "Keep both"). */
  resolutions?: Record<string, FsResolution>;
  /** The success sentence when the server's summary is empty. */
  fallback?: string;
}

export interface FileOps {
  run: (ops: FsOp[], opts?: RunOptions) => Promise<FsOpsResult | undefined>;
  undo: (batchId?: string) => Promise<void>;
  redo: () => Promise<void>;
  /** D10: "Change the extension from .dcm to .txt? The file's content won't change." */
  confirmExtension: (from: string, to: string) => Promise<boolean>;
  /** The conflict and confirmation dialogs; render once. */
  dialogs: ReactNode;
}

const NO_CONFLICTS: FsConflict[] = [];
const lower = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

export function errorText(e: unknown): string {
  if (e instanceof NeedsApiError) return NEEDS_FULL_STACK;
  if (e instanceof Error) return e.message;
  return String(e);
}

export function useFileOps(projectId: string, writable: boolean): FileOps {
  const fsOps = useFsOps(projectId);
  const undoM = useUndo(projectId);
  const redoM = useRedo(projectId);
  const [conflicts, setConflicts] = useState<FsConflict[] | null>(null);
  const resolveConflicts = useRef<((r: Record<string, FsResolution> | null) => void) | null>(null);
  const [ext, setExt] = useState<{ from: string; to: string } | null>(null);
  const resolveExt = useRef<((ok: boolean) => void) | null>(null);

  const askConflicts = (list: FsConflict[]) =>
    new Promise<Record<string, FsResolution> | null>((resolve) => {
      resolveConflicts.current = resolve;
      setConflicts(list);
    });

  const undo = useCallback(
    async (batchId?: string) => {
      if (!writable) return void notify(NEEDS_FULL_STACK, { tone: "error" });
      try {
        const r = await undoM.mutateAsync(batchId ? { batchId } : undefined);
        notify(r.summary ? (/^undid\b/i.test(r.summary) ? r.summary : `Undone: ${lower(r.summary)}`) : "Undone", { group: "undo" });
      } catch (e) {
        notify(errorText(e), { tone: "error", group: "undo" });
      }
    },
    [undoM, writable],
  );

  const redo = useCallback(async () => {
    if (!writable) return void notify(NEEDS_FULL_STACK, { tone: "error" });
    try {
      const r = await redoM.mutateAsync();
      notify(r.summary ? (/^redid\b/i.test(r.summary) ? r.summary : `Redone: ${lower(r.summary)}`) : "Redone", { group: "undo" });
    } catch (e) {
      notify(errorText(e), { tone: "error", group: "undo" });
    }
  }, [redoM, writable]);

  const run = useCallback(
    async (input: FsOp[], opts: RunOptions = {}): Promise<FsOpsResult | undefined> => {
      if (!input.length) return undefined;
      if (!writable) {
        notify(NEEDS_FULL_STACK, { tone: "error", description: "Changing files needs the API and the database (README.md)." });
        return undefined;
      }
      let ops: FsOp[];
      try {
        ops = await Promise.all(input.map(async (o): Promise<FsOp> => ("nodeIds" in o ? { ...o, nodeIds: await expandRuns(projectId, o.nodeIds) } : o)));
      } catch (e) {
        notify(errorText(e), { tone: "error" });
        return undefined;
      }
      const fail = (e: unknown) => {
        if (e instanceof LockedError && ops.some((o) => o.kind === "move")) {
          const copies = ops.map((o): FsOp => (o.kind === "move" ? { kind: "copy", nodeIds: o.nodeIds, parentId: o.parentId } : o));
          notify(e.message.includes("Copy") ? e.message : "Sample data can't be moved", { tone: "error", action: { label: "Copy instead", onClick: () => void run(copies, opts) } });
        } else notify(errorText(e), { tone: "error" });
      };
      const send = (resolutions?: Record<string, FsResolution>) => fsOps.mutateAsync({ ops, optimistic: opts.optimistic, ...(resolutions ? { resolutions } : {}) });
      let res: FsOpsResult;
      try {
        res = await send(opts.resolutions);
      } catch (e) {
        if (!(e instanceof FsConflictApiError)) return void fail(e);
        const resolutions = await askConflicts(e.conflicts);
        if (!resolutions) return void notify("Nothing changed", { description: "The name conflict wasn't settled." });
        try {
          res = await send({ ...opts.resolutions, ...resolutions });
        } catch (e2) {
          return void fail(e2);
        }
      }
      const trashed = ops.flatMap((o) => (o.kind === "trash" || o.kind === "purge" ? o.nodeIds : []));
      if (trashed.length) useFilesClipboard.getState().forget(trashed);
      if (!opts.quiet) {
        const identical = res.skipped?.identical ?? 0;
        const description = [identical ? `${identical.toLocaleString()} identical ${identical === 1 ? "file" : "files"} skipped` : null, ...(res.warnings ?? [])].filter(Boolean).join(" · ") || undefined;
        notify(res.summary || opts.fallback || "Done", { undo: res.batchId ? () => void undo(res.batchId) : undefined, description, tone: "success" });
      }
      return res;
    },
    [fsOps, undo, writable, projectId],
  );

  const confirmExtension = useCallback(
    (from: string, to: string) =>
      new Promise<boolean>((resolve) => {
        resolveExt.current = resolve;
        setExt({ from, to });
      }),
    [],
  );

  const closeExt = (ok: boolean) => {
    resolveExt.current?.(ok);
    resolveExt.current = null;
    setExt(null);
  };

  const dialogs = (
    <>
      <ConflictDialog
        open={!!conflicts}
        conflicts={conflicts ?? NO_CONFLICTS}
        onDone={(r) => {
          resolveConflicts.current?.(r);
          resolveConflicts.current = null;
          setConflicts(null);
        }}
        onCancel={() => {
          resolveConflicts.current?.(null);
          resolveConflicts.current = null;
          setConflicts(null);
        }}
      />
      <AlertDialog open={!!ext} onOpenChange={(o) => !o && closeExt(false)}>
        <AlertDialogContent data-testid="extension-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Change the extension from {ext?.from || "none"} to {ext?.to || "none"}?
            </AlertDialogTitle>
            <AlertDialogDescription>The file's content won't change, but apps may open it differently.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => closeExt(false)}>Keep {ext?.from || "no extension"}</AlertDialogCancel>
            <AlertDialogAction onClick={() => closeExt(true)} data-testid="extension-confirm-yes">
              Use {ext?.to || "no extension"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );

  return { run, undo, redo, confirmExtension, dialogs };
}

export { ApiError };
