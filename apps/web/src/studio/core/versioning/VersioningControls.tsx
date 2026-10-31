import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { versionReviewUrl } from "@/studio/lib/routes";
import { useQuery } from "@tanstack/react-query";
import { SendIcon, WarningIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@studio/ui/ui/dialog";
import { Input } from "@studio/ui/ui/input";
import { Textarea } from "@studio/ui/ui/textarea";
import { useStudio } from "@/studio/stores/studio";
import { regionLabelNames } from "@studio/contracts/environment";
import { api } from "./api";
import { refreshAndReapply, submitForReview, useVersioning } from "./session";

/**
 * Top-bar versioning pieces besides the work-state chip (todo8 D1): "Request review", the
 * stale-head notice (separate and loud), and whether the draft has changes to review.
 */
export function reload(projectId: string, annotations: Parameters<ReturnType<typeof useStudio.getState>["load"]>[1], revision: number, dirty = false) {
  const s = useStudio.getState();
  const label = s.activeLabel ?? regionLabelNames(s.env?.labels)[0] ?? null;
  s.load(projectId, annotations, revision, label);
  if (dirty) useStudio.setState({ dirty: true, saveState: "idle" });
}

/** A save hit `stale_head`: someone else saved this branch. Refresh and replay this session's edits. */
export function StaleNotice({ projectId }: { projectId: string }) {
  const stale = useVersioning((s) => s.enabled && s.datasetId === projectId && s.stale);
  const [busy, setBusy] = useState(false);
  if (!stale) return null;
  const fix = async () => {
    setBusy(true);
    try {
      const { annotations, revision } = await refreshAndReapply(projectId, useStudio.getState().annotations);
      reload(projectId, annotations, revision, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex shrink-0 items-center gap-1.5 rounded-md bg-warning-tint px-2 py-0.5 text-sm text-warning" role="alert" data-testid="stale-save">
      <WarningIcon className="size-4" />
      <span className="hidden @[640px]:inline">Someone else saved; refresh and re-apply</span>
      <Button size="xs" variant="outline" disabled={busy} onClick={fix}>Refresh and re-apply</Button>
    </span>
  );
}

/**
 * Whether the draft (the work branch) differs from the published copy: unsaved edits, or a
 * head that isn't the protected branch's commit. Drives the header's primary button (todo8 D1).
 */
export function useDraftHasChanges(projectId: string): boolean {
  const enabled = useVersioning((s) => s.enabled && s.datasetId === projectId);
  const head = useVersioning((s) => s.head);
  const readOnly = useVersioning((s) => s.readOnly);
  const dirty = useStudio((s) => s.dirty);
  const branches = useQuery({ queryKey: ["versioning", projectId, "branches", head], queryFn: () => api.branches(projectId, projectId), enabled: enabled && !readOnly && !!head, staleTime: 10_000 });
  if (!enabled || readOnly) return false;
  if (dirty) return true;
  const published = branches.data?.items.find((b) => b.protected);
  return !!head && !!published && published.commit_oid !== head;
}

/** "Request review" (ux.md §10): opens a review of the draft into the published copy. */
export function RequestReview({ projectId, primary = true }: { projectId: string; primary?: boolean }) {
  const readOnly = useVersioning((s) => s.readOnly);
  const dirty = useStudio((s) => s.dirty);
  const navigate = useNavigate();
  const routeProject = useParams().projectId;
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (readOnly) return null;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const rv = await submitForReview(projectId, title.trim() || "Changes from my draft", description.trim() || undefined);
      setOpen(false);
      navigate(versionReviewUrl(routeProject ?? projectId, projectId, rv.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant={primary ? "default" : "outline"} className="shrink-0" disabled={dirty} onClick={() => setOpen(true)} data-testid="submit-review" aria-label="Request review" title={dirty ? "Wait for the save to finish" : undefined}>
        <SendIcon /> <span className="hidden @[760px]:inline">Request review</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request review</DialogTitle>
            <DialogDescription>
              Asks a reviewer to publish the changes in your draft. Checks run first; another person approves before they are published.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title, e.g. Correct LV contours" aria-label="Review title" />
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What changed and why (optional)" aria-label="Review description" />
            {error && <p className="text-sm text-danger" role="alert">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={busy}>Request review</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
