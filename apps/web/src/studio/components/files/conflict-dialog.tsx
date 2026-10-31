import { useEffect, useId, useMemo, useState } from "react";
import type { FsConflict, FsResolution } from "@studio/contracts/types";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@studio/ui/ui/alert-dialog";
import { Button } from "@studio/ui/ui/button";
import { Checkbox } from "@studio/ui/ui/checkbox";
import { Label } from "@studio/ui/ui/label";
import { keepBothName, plural } from "./shared";

/**
 * The name-conflict dialog (todo7 §2 Conflict dialog) for move, copy, paste and upload. It walks
 * the 409's `conflicts` one at a time: "An item named “scan001.dcm” already exists in MRI."
 * Files get Keep both / Replace / Skip, folders Merge / Keep both. "Do this for the other *N*
 * conflicts" applies the choice to every later conflict of the same kind (a file choice never
 * lands on a folder). Identical files (same sha256) are skipped without asking, with a summary
 * line. When every conflict is settled, `onDone` gets one resolution per conflicting nodeId, for
 * the single retry.
 */

export interface ConflictWalk {
  /** The conflicts that need a decision, in order (identical files are not among them). */
  pending: FsConflict[];
  resolutions: Record<string, FsResolution>;
  /** Index in `pending` of the one being asked, or null when all are settled. */
  current: number | null;
  /** Identical files skipped silently. */
  identical: number;
}

/** Sets up the walk: identical files are skipped at once. */
export function startConflictWalk(conflicts: FsConflict[]): ConflictWalk {
  const resolutions: Record<string, FsResolution> = {};
  const pending: FsConflict[] = [];
  let identical = 0;
  for (const c of conflicts) {
    if (c.kind === "file" && c.identical) {
      resolutions[c.nodeId] = "skip";
      identical++;
    } else pending.push(c);
  }
  return { pending, resolutions, current: pending.length ? 0 : null, identical };
}

/** Choices that make sense for a kind: `replace` is files only, `merge` folders only. */
export function choicesFor(kind: FsConflict["kind"]): FsResolution[] {
  return kind === "folder" ? ["merge", "keep_both"] : ["keep_both", "replace", "skip"];
}

/** How many later, unsettled conflicts have the same kind as the current one. */
export function othersLikeCurrent(w: ConflictWalk): number {
  if (w.current === null) return 0;
  const kind = w.pending[w.current].kind;
  return w.pending.slice(w.current + 1).filter((c) => c.kind === kind && !(c.nodeId in w.resolutions)).length;
}

/** Settles the current conflict (and, with `applyToAll`, the later ones of its kind), then moves on. */
export function chooseResolution(w: ConflictWalk, choice: FsResolution, applyToAll: boolean): ConflictWalk {
  if (w.current === null) return w;
  const cur = w.pending[w.current];
  if (!choicesFor(cur.kind).includes(choice)) return w;
  const resolutions = { ...w.resolutions, [cur.nodeId]: choice };
  if (applyToAll) for (const c of w.pending.slice(w.current + 1)) if (c.kind === cur.kind && !(c.nodeId in resolutions)) resolutions[c.nodeId] = choice;
  const next = w.pending.findIndex((c, i) => i > w.current! && !(c.nodeId in resolutions));
  return { ...w, resolutions, current: next < 0 ? null : next };
}

const LABEL: Record<FsResolution, string> = { keep_both: "Keep both", replace: "Replace", skip: "Skip", merge: "Merge" };

export interface ConflictDialogProps {
  open: boolean;
  /** From the 409 body (`FsConflictError.conflicts`). */
  conflicts: FsConflict[];
  /** Every conflict settled: one resolution per conflicting nodeId (identical files are `skip`). */
  onDone: (resolutions: Record<string, FsResolution>) => void;
  /** Closed without settling: the whole operation is called off. */
  onCancel: () => void;
}

export function ConflictDialog({ open, conflicts, onDone, onCancel }: ConflictDialogProps) {
  const initial = useMemo(() => startConflictWalk(conflicts), [conflicts]);
  const [walk, setWalk] = useState(initial);
  const [all, setAll] = useState(false);
  const checkId = useId();
  useEffect(() => {
    setWalk(initial);
    setAll(false);
  }, [initial, open]);

  // Nothing to ask (only identical files, or the last choice settled the rest).
  useEffect(() => {
    if (open && walk.current === null) onDone(walk.resolutions);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per settled walk
  }, [open, walk]);

  const cur = walk.current !== null ? walk.pending[walk.current] : null;
  const others = othersLikeCurrent(walk);
  const mixed = new Set(walk.pending.map((c) => c.kind)).size > 1;
  const pick = (r: FsResolution) => {
    setWalk((w) => chooseResolution(w, r, all));
    setAll(false);
  };

  return (
    <AlertDialog open={open && !!cur} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent className="max-w-md" data-testid="conflict-dialog" data-kind={cur?.kind}>
        {cur && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle className="text-base">
                {cur.kind === "folder" ? "A folder with this name is already there" : "A file with this name is already there"}
              </AlertDialogTitle>
              <AlertDialogDescription className="break-words" data-testid="conflict-message">
                An item named “{cur.name}” already exists in {cur.parentName}.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <p className="text-xs text-muted-foreground">
              {cur.kind === "folder"
                ? "Merge puts its contents into the folder that's there, asking again for any name that's taken. Keep both adds it with a new name."
                : `Keep both names the new one “${keepBothName(cur.name)}”. Replace adds it as a new version of the file that's there; the old version is kept.`}
            </p>
            {(walk.pending.length > 1 || walk.identical > 0) && (
              <p className="text-xs text-hint" data-testid="conflict-progress">
                {walk.pending.length > 1 && `Conflict ${walk.current! + 1} of ${walk.pending.length}`}
                {walk.pending.length > 1 && walk.identical > 0 && " · "}
                {walk.identical > 0 && <span data-testid="conflict-identical">{plural(walk.identical, "identical file")} skipped</span>}
              </p>
            )}
            <AlertDialogFooter className="flex-col gap-3 sm:flex-col sm:space-x-0">
              {others > 0 && (
                <div className="flex items-center gap-2">
                  <Checkbox id={checkId} checked={all} onCheckedChange={(v) => setAll(v === true)} data-testid="conflict-apply-all" />
                  <Label htmlFor={checkId} className="text-sm font-normal">
                    Do this for the other {plural(others, mixed ? `${cur.kind} conflict` : "conflict")}
                  </Label>
                </div>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                <AlertDialogCancel className="mr-auto" data-testid="conflict-cancel">Cancel</AlertDialogCancel>
                {[...choicesFor(cur.kind)].reverse().map((r, i, arr) => (
                  <Button key={r} variant={i === arr.length - 1 ? "default" : "outline"} onClick={() => pick(r)} data-testid={`conflict-${r.replace("_", "-")}`} autoFocus={i === arr.length - 1}>
                    {LABEL[r]}
                  </Button>
                ))}
              </div>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
