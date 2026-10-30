import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { datasetUrl, versionReviewUrl } from "@/studio/lib/routes";
import { useQuery } from "@tanstack/react-query";
import { BranchIcon, CheckIcon, HistoryIcon, SendIcon, WarningIcon } from "@studio/ui/icons";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@studio/ui/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@studio/ui/ui/dropdown-menu";
import { Input } from "@studio/ui/ui/input";
import { Textarea } from "@studio/ui/ui/textarea";
import { useStudio } from "@/studio/stores/studio";
import { regionLabelNames } from "@studio/contracts/environment";
import { api } from "./api";
import { refreshAndReapply, submitForReview, switchBranch, useVersioning } from "./session";

/** Top-bar versioning controls: branch switcher, "Submit for review", and the stale-save notice. Render nothing while versioning is off. */
export function VersioningControls({ projectId }: { projectId: string }) {
  const enabled = useVersioning((s) => s.enabled && s.datasetId === projectId);
  if (!enabled) return null;
  return (
    <>
      <BranchSwitcher projectId={projectId} />
      <StaleNotice projectId={projectId} />
      <SubmitForReview projectId={projectId} />
    </>
  );
}

function reload(projectId: string, annotations: Parameters<ReturnType<typeof useStudio.getState>["load"]>[1], revision: number, dirty = false) {
  const s = useStudio.getState();
  const label = s.activeLabel ?? regionLabelNames(s.env?.labels)[0] ?? null;
  s.load(projectId, annotations, revision, label);
  if (dirty) useStudio.setState({ dirty: true, saveState: "idle" });
}

function BranchSwitcher({ projectId }: { projectId: string }) {
  // `projectId` is the Studio's task id (the versioned dataset); the route names the project.
  const routeProject = useParams().projectId;
  const branch = useVersioning((s) => s.branch);
  const readOnly = useVersioning((s) => s.readOnly);
  const dirty = useStudio((s) => s.dirty);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const branches = useQuery({ queryKey: ["versioning", projectId, "branches"], queryFn: () => api.branches(projectId, projectId), enabled: open });

  const go = async (name: string, protectedBranch: boolean) => {
    setBusy(true);
    try {
      const doc = await switchBranch(projectId, name, protectedBranch);
      reload(projectId, doc.annotations, doc.revision);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="max-w-[min(240px,30cqw)] shrink" disabled={busy} data-testid="branch-switcher" aria-label={`Branch ${branch}`}>
          <BranchIcon />
          <span className="truncate font-mono text-xs">{branch}</span>
          {readOnly && <Badge theme="unknown">read-only</Badge>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="font-normal text-hint">{dirty ? "Save before switching branches" : "Switch branch"}</DropdownMenuLabel>
        {(branches.data?.items ?? []).map((b) => (
          <DropdownMenuItem key={b.name} disabled={dirty || b.name === branch} onSelect={() => go(b.name, b.protected)} data-branch={b.name}>
            {b.name === branch ? <CheckIcon /> : <BranchIcon />}
            <span className="truncate font-mono text-xs">{b.name}</span>
            {b.protected && <Badge theme="info" className="ml-auto">protected</Badge>}
            {b.name === branches.data?.workBranch && <Badge theme="clear" className="ml-auto">yours</Badge>}
          </DropdownMenuItem>
        ))}
        {branches.isLoading && <DropdownMenuLabel className="font-normal text-muted-foreground">Loading…</DropdownMenuLabel>}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to={datasetUrl(routeProject ?? projectId, projectId, "versions")}><HistoryIcon /> History, reviews and releases</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A save hit `stale_head`: someone else saved this branch. Refresh and replay this session's edits. */
function StaleNotice({ projectId }: { projectId: string }) {
  const stale = useVersioning((s) => s.stale);
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

function SubmitForReview({ projectId }: { projectId: string }) {
  const branch = useVersioning((s) => s.branch);
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
      const rv = await submitForReview(projectId, title.trim() || `Changes from ${branch}`, description.trim() || undefined);
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
      <Button variant="outline" size="sm" className="hidden shrink-0 @[640px]:inline-flex" disabled={dirty} onClick={() => setOpen(true)} data-testid="submit-review" title={dirty ? "Wait for the save to finish" : undefined}>
        <SendIcon /> <span className="hidden @[900px]:inline">Submit for review</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Submit for review</DialogTitle>
            <DialogDescription>
              Opens a review of <code className="font-mono">{branch}</code> into <code className="font-mono">main</code>. Checks run first; another person approves before it can merge.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title, e.g. Correct LV contours" aria-label="Review title" />
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What changed and why (optional)" aria-label="Review description" />
            {error && <p className="text-sm text-danger" role="alert">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={busy}>Open review</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
