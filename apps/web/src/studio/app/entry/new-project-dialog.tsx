import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { ProjectSummary } from "@studio/contracts/types";
import { AddDataIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@studio/ui/ui/dialog";
import { Input } from "@studio/ui/ui/input";
import { NeedsApiError, projectKeys } from "@/studio/lib/projects-api";
import { projectUrl } from "@/studio/lib/routes";
import { useShell } from "@/studio/stores/shell";
import { createProject } from "./start-project";

/**
 * todo21 D1, D2: "New project" is a name dialog, like Drive's "New folder". One field, prefilled
 * with an editable suggestion and selected so typing replaces it; Enter creates. Opened from
 * anywhere with `useNewProject().open(...)`; `NewProjectHost` (mounted once, in the app shell)
 * renders it. Resolves with the project, or null on Cancel.
 */
export interface NewProjectRequest {
  /** The prefilled, selected name. */
  suggestion?: string;
  /**
   * What waits to be delivered after Create (a Home send or drop, D2): a line under the field.
   * With `pending` the caller delivers and navigates; without it, the new project opens on its
   * Overview.
   */
  pending?: string;
  /** Don't open the project after Create (the Home assistant's `create_project` tool). */
  stay?: boolean;
}

interface NewProjectState {
  request: (NewProjectRequest & { resolve: (p: ProjectSummary | null) => void }) | null;
  open: (req?: NewProjectRequest) => Promise<ProjectSummary | null>;
  close: (p: ProjectSummary | null) => void;
}

export const useNewProjectStore = create<NewProjectState>()((set, get) => ({
  request: null,
  open: (req = {}) =>
    new Promise((resolve) => {
      // A second open replaces the first (its caller sees Cancel).
      get().request?.resolve(null);
      set({ request: { ...req, resolve } });
    }),
  close: (p) => {
    get().request?.resolve(p);
    set({ request: null });
  },
}));

/** `open({ suggestion, pending })` from any component. */
export function useNewProject() {
  const open = useNewProjectStore((s) => s.open);
  return { open };
}

export function NewProjectButton({ size = "sm", variant = "outline", testId = "new-project", className }: { size?: "sm" | "lg"; variant?: "default" | "outline"; testId?: string; className?: string }) {
  const { open } = useNewProject();
  return (
    <Button variant={variant} size={size} className={className} onClick={() => void open()} data-testid={testId}>
      <AddDataIcon /> New project
    </Button>
  );
}

export function NewProjectHost() {
  const request = useNewProjectStore((s) => s.request);
  const close = useNewProjectStore((s) => s.close);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // After Create opens the project, focus goes to its chat composer, not back to the trigger.
  const opened = useRef(false);

  useEffect(() => {
    if (!request) return;
    setName(request.suggestion ?? "");
    setError(null);
    setBusy(false);
    // Selected, so typing replaces the suggestion.
    requestAnimationFrame(() => input.current?.select());
  }, [request]);

  const create = async () => {
    const title = name.trim();
    if (!title || !request) return;
    setBusy(true);
    setError(null);
    try {
      const p = await createProject(title);
      useShell.getState().visited({ id: p.id, title: p.title });
      void qc.invalidateQueries({ queryKey: projectKeys.all });
      if (request.pending === undefined && !request.stay) {
        opened.current = true;
        navigate(projectUrl(p.id));
      }
      close(p);
    } catch (e) {
      setError(e instanceof NeedsApiError ? "Creating a project needs the full stack (the API): see docs/running.md" : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!request} onOpenChange={(o) => !o && close(null)}>
      <DialogContent
        className="max-w-md"
        data-testid="new-project-dialog"
        onCloseAutoFocus={(e) => {
          if (!opened.current) return;
          opened.current = false;
          // Focus goes to the new project's Overview composer, not back to the trigger.
          e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>Name it; you can rename it later.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <Input ref={input} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Chest X-ray screening" aria-label="Project name" data-testid="new-project-name" />
          {request?.pending && (
            <p className="mt-2 text-sm text-muted-foreground" data-testid="new-project-pending">
              {request.pending}
            </p>
          )}
          {error && (
            <p className="mt-2 text-sm text-danger" role="alert">
              {error}
            </p>
          )}
          <DialogFooter className="mt-4 gap-2">
            <Button type="button" variant="outline" onClick={() => close(null)} data-testid="new-project-cancel">
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || busy} data-testid="new-project-create">
              {busy ? "Creating" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
