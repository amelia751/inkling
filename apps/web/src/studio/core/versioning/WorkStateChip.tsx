import { useState } from "react";
import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { BranchIcon, CheckIcon, ChevronDownIcon, ErrorIcon, HistoryIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@studio/ui/ui/dropdown-menu";
import { Spinner } from "@studio/ui/ui/spinner";
import { datasetUrl } from "@/studio/lib/routes";
import { useStudio } from "@/studio/stores/studio";
import { api } from "./api";
import { switchBranch, useVersioning } from "./session";
import { reload } from "./VersioningControls";

/**
 * The header's "state of my work" chip (todo8 D1): the save indicator and the versioning state
 * in one place, in ux.md §10 words (never git words).
 *
 * - Versioning off: `Saved ✓`, `Saving…` or `Not saved · Retry` (quiet text; only Retry is a control).
 * - Versioning on: `Your draft · Saved ✓`, or `Published (read-only)` on the protected branch. It
 *   opens a menu with Compare versions, the switch between the published copy and the draft
 *   (`data-testid="branch-switcher"`), and the branch name in small print.
 *
 * Never says "Saved" until the server has confirmed the write (ui.md §3, top bar).
 */
export function WorkStateChip({ projectId, onRetry }: { projectId: string; onRetry: () => void }) {
  const versioned = useVersioning((s) => s.enabled && s.datasetId === projectId);
  const saveState = useStudio((s) => s.saveState);
  if (saveState === "error") {
    return (
      <Button variant="ghost" size="sm" onClick={onRetry} className="shrink-0 text-danger hover:text-danger" data-testid="work-state" data-state="error">
        <ErrorIcon /> <span className="hidden @[520px]:inline">Not saved ·</span> Retry
      </Button>
    );
  }
  return versioned ? <VersionedChip projectId={projectId} /> : <SaveText />;
}

function SaveText({ prefix }: { prefix?: string }) {
  const saveState = useStudio((s) => s.saveState);
  const dirty = useStudio((s) => s.dirty);
  const lead = prefix && <span className="hidden @[640px]:inline">{prefix} ·</span>;
  if (saveState === "saving") {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground" role="status" data-testid={prefix ? undefined : "work-state"} data-state="saving">
        {lead} <Spinner /> <span className="hidden @[640px]:inline">Saving…</span>
      </span>
    );
  }
  if (dirty) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground" role="status" data-testid={prefix ? undefined : "work-state"} data-state="dirty">
        {lead} <span className="hidden @[640px]:inline">Unsaved changes</span>
      </span>
    );
  }
  if (saveState === "saved") {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground" role="status" aria-label={prefix ? `${prefix}, saved` : "Saved"} data-testid={prefix ? undefined : "work-state"} data-state="saved">
        {lead} <span className="hidden @[640px]:inline">Saved</span> <CheckIcon className="size-4 text-positive" />
      </span>
    );
  }
  return prefix ? <span className="text-sm text-muted-foreground">{prefix}</span> : null;
}

function VersionedChip({ projectId }: { projectId: string }) {
  // `projectId` is the Studio's task id (the versioned dataset); the route names the project.
  const routeProject = useParams().projectId;
  const branch = useVersioning((s) => s.branch);
  const workBranch = useVersioning((s) => s.workBranch);
  const readOnly = useVersioning((s) => s.readOnly);
  const dirty = useStudio((s) => s.dirty);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const branches = useQuery({ queryKey: ["versioning", projectId, "branches"], queryFn: () => api.branches(projectId, projectId), enabled: open });
  const published = branches.data?.items.find((b) => b.protected);
  const draft = workBranch ?? branches.data?.workBranch ?? null;

  const go = async (name: string, protectedBranch: boolean) => {
    setBusy(true);
    try {
      const doc = await switchBranch(projectId, name, protectedBranch);
      reload(projectId, doc.annotations, doc.revision);
    } finally {
      setBusy(false);
    }
  };
  // The switch: to the published copy from the draft, or back to the draft.
  const target = readOnly ? (draft ? { name: draft, protected: false, label: "Back to your draft" } : null) : published ? { name: published.name, protected: true, label: "View the published copy" } : null;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="shrink-0 text-muted-foreground" disabled={busy} data-testid="work-state" data-state={readOnly ? "published" : "draft"} aria-label={readOnly ? "Published (read-only). Work state" : "Your draft. Work state"}>
          {readOnly ? (
            <span className="text-sm">
              Published<span className="hidden @[640px]:inline"> (read-only)</span>
            </span>
          ) : (
            <SaveText prefix="Your draft" />
          )}
          <ChevronDownIcon className="text-hint" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="font-normal text-hint">{readOnly ? "You're viewing the published copy. It can't be edited here." : "You're editing your draft. Others see it after a review."}</DropdownMenuLabel>
        <DropdownMenuItem
          disabled={dirty || !target}
          onSelect={() => target && go(target.name, target.protected)}
          data-testid="branch-switcher"
          data-branch={target?.name}
        >
          <BranchIcon />
          {dirty ? "Save before switching" : (target?.label ?? (branches.isLoading ? "Loading…" : "View the published copy"))}
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to={datasetUrl(routeProject ?? projectId, projectId, "versions")}>
            <HistoryIcon /> Compare versions
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <p className="truncate px-2 py-1 font-mono text-xs text-hint" data-testid="branch-name" title={branch ?? undefined}>
          {branch}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
