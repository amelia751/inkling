import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { AddDataIcon, CloseIcon } from "@studio/ui/icons";
import { NAMING } from "@studio/contracts/naming";
import { DropZone, useRefreshProject } from "@/studio/components/uploads/uploads";
import { Button } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@studio/ui/ui/dialog";
import { Input } from "@studio/ui/ui/input";
import { Label } from "@studio/ui/ui/label";
import { Textarea } from "@studio/ui/ui/textarea";
import { api, NeedsApiError, projectKeys } from "@/studio/lib/projects-api";
import { projectUrl } from "@/studio/lib/routes";
import { useShell } from "@/studio/stores/shell";
import { useUploads } from "@/studio/stores/uploads";
import type { Picked } from "@/studio/lib/uploads/walk";
import type { ProjectSummary } from "@studio/contracts/types";

/** The chips fill the field; they don't run anything (todo6 §3.1). */
export const EXAMPLE_GOALS = ["Classify chest X-rays", "Outline the left ventricle in cardiac MRI", "Mark events in ECG recordings"];

/** What New project receives from Home: a goal sentence and/or files dropped on Home. */
export interface NewProjectState {
  goal?: string;
  picked?: Picked;
}

/** A title from a goal sentence: "Help me classify chest X-rays." → "Classify chest X-rays". */
export function titleFromGoal(goal: string): string {
  const s = goal
    .trim()
    .replace(/^(please\s+)?(help me( to)?|i want to|i'd like to|i would like to|we want to|let's|lets)\s+/i, "")
    .replace(/[.!?]+$/, "")
    .split(/\n/)[0];
  const t = s.length > 60 ? `${s.slice(0, 57).replace(/\s+\S*$/, "")}…` : s;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Create project (docs/ux.md §3): a name or a goal sentence, an optional description and the
 * drop area. Create works with no files at all; attached files ask for the rights attestation
 * (the upload layer's dialog), then upload while Overview opens. Used by `/projects/new` and by
 * the dialog the shell opens from anywhere (`useShell().setNewProject`).
 */
export function NewProjectForm({ initial = {}, onCancel, onCreated }: { initial?: NewProjectState; onCancel: () => void; onCreated?: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const add = useUploads((s) => s.add);
  const refresh = useRefreshProject();
  const [title, setTitle] = useState(() => (initial.goal ? titleFromGoal(initial.goal) : ""));
  const [description, setDescription] = useState(() => (initial.goal && titleFromGoal(initial.goal) !== initial.goal ? initial.goal : ""));
  const [picked, setPicked] = useState<Picked | undefined>(initial.picked);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [title]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await api<ProjectSummary>("/projects", { method: "POST", json: { title: title.trim(), description: description.trim() } });
      void qc.invalidateQueries({ queryKey: projectKeys.all });
      onCreated?.();
      navigate(projectUrl(p.id));
      // The tray keeps uploading while Overview opens; the attestation dialog comes first.
      if (picked?.files.length) void add(p.id, picked, { onChanged: refresh });
    } catch (e) {
      setError(e instanceof NeedsApiError ? "Creating projects needs the full stack (the API): see docs/running.md" : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) void create();
      }}
      data-testid="new-project-form"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="project-title">Name or goal</Label>
        <Input id="project-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={EXAMPLE_GOALS[0]} autoFocus data-testid="project-title-input" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="project-description">Description <span className="text-hint">(optional)</span></Label>
        <Textarea id="project-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="What the data is, and what you want from it" />
      </div>
      {picked?.files.length ? (
        <Card className="flex items-center gap-3 px-4 py-3 text-sm" data-testid="attached">
          <AddDataIcon className="size-4 text-hint" />
          <span className="min-w-0 flex-1">
            {picked.files.length.toLocaleString()} {picked.files.length === 1 ? "file" : "files"} attached
            {picked.skipped > 0 && <span className="text-muted-foreground"> · {picked.skipped} system {picked.skipped === 1 ? "file" : "files"} skipped</span>}
          </span>
          <Button type="button" variant="ghost-secondary" size="icon" onClick={() => setPicked(undefined)} aria-label="Remove attached files">
            <CloseIcon />
          </Button>
        </Card>
      ) : (
        <DropZone onPick={setPicked} title="Drop files or folders here" hint={`Optional. Originals are kept exactly as they are; ${NAMING.displayName} reads them to find out what's there.`} />
      )}
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="lg" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="lg" disabled={!title.trim()} loading={busy} data-testid="create-project">Create</Button>
      </div>
    </form>
  );
}

/** New project from anywhere (the project switcher's "New project"); mounted once by the shell. */
export function NewProjectDialog() {
  const open = useShell((s) => s.newProjectOpen);
  const setOpen = useShell((s) => s.setNewProject);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-xl" data-testid="new-project-dialog">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>Name it, or say what you're trying to build. You can add data now or later.</DialogDescription>
        </DialogHeader>
        {open && <NewProjectForm onCancel={() => setOpen(false)} onCreated={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  );
}
