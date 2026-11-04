import { useEffect } from "react";
import type { Annotation } from "@studio/contracts/types";
import { apiUrl } from "@/extension-host/runtime-config";
import { apiFetch } from "@/extension-host/http";
import { kernelEnabled } from "@/extension-host/kernel";
import { fetchAnnotations } from "@/studio/lib/api";
import { useSaveConflicts } from "@/studio/lib/annotation-merge";
import { onProjectEvent } from "@/studio/lib/use-project-events";
import { useStudio } from "@/studio/stores/studio";

/**
 * Masks land live (todo25 W5, D6): a batch job (the assistant's `create_job`, or Segment in
 * another tab) commits AI suggestions to the Studio's annotation document as each job finishes.
 * The open Studio picks them up without a reload:
 *
 * - on the project stream's `annotations.committed` / `job.succeeded` events, at once;
 * - with the kernel on, by polling while the workspace has queued or running jobs (fast, with
 *   back-off), and slowly otherwise, so a stream that dropped an event still catches up.
 *
 * Only suggestions the store doesn't have yet are added, and never ones the person removed
 * (they're in the merge base but not in the store). They don't enter undo history, and they
 * don't make the Studio dirty: they're already saved on the server.
 */

/** Server annotations that are AI suggestions this store hasn't seen. */
export function newSuggestions(local: Annotation[], base: Annotation[], server: Annotation[]): Annotation[] {
  const have = new Set(local.map((a) => a.id));
  const known = new Set(base.map((a) => a.id));
  return server.filter((a) => a.provenance === "ai-suggested" && !have.has(a.id) && !known.has(a.id));
}

/** Fetch the Studio's document and merge new suggestions into the store. Returns how many landed. */
export async function pullSuggestions(projectId: string, fetchDoc: (id: string) => Promise<{ revision: number; annotations: Annotation[] }> = fetchAnnotations): Promise<number> {
  const doc = await fetchDoc(projectId);
  const s = useStudio.getState();
  if (s.projectId !== projectId) return 0;
  const conflicts = useSaveConflicts.getState();
  const base = conflicts.baseProject === projectId ? conflicts.base : [];
  const fresh = newSuggestions(s.annotations, base, doc.annotations);
  if (!fresh.length) return 0;
  if (!s.dirty && doc.revision >= s.revision) {
    // Nothing unsaved here: take the server's revision, so the next save doesn't conflict.
    useStudio.setState({ annotations: [...s.annotations, ...fresh], revision: doc.revision });
    conflicts.setBase(projectId, [...base, ...fresh]);
  } else {
    // Unsaved edits: add the suggestions; the save's 409 merge reconciles the revision.
    useStudio.setState({ annotations: [...s.annotations, ...fresh] });
  }
  return fresh.length;
}

/** Whether the workspace has jobs queued or running (kernel jobs API). */
export async function activeJobs(workspaceId: string): Promise<boolean> {
  for (const state of ["running", "queued"]) {
    const res = await apiFetch(apiUrl(`/v1/jobs?state=${state}`), { headers: { "X-Workspace-Id": workspaceId } });
    if (!res.ok) return false;
    const body = (await res.json()) as { jobs?: unknown[] };
    if (body.jobs?.length) return true;
  }
  return false;
}

export const POLL = { activeMs: 1000, activeMaxMs: 4000, idleMs: 5000, idleMaxMs: 30_000 } as const;

export interface LiveSuggestionsDeps {
  pull: () => Promise<unknown>;
  /** Present when the kernel can list jobs; without it only events trigger a pull. */
  hasActiveJobs?: () => Promise<boolean>;
  subscribe: (type: string, fn: () => void) => () => void;
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel?: (t: ReturnType<typeof setTimeout>) => void;
}

/** Start following a Studio's suggestions; returns stop. Exported for tests (fake timers). */
export function followSuggestions(d: LiveSuggestionsDeps): () => void {
  const schedule = d.schedule ?? setTimeout;
  const cancel = d.cancel ?? clearTimeout;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay: number = POLL.activeMs;
  let wasActive = false;
  let busy = false;

  const safePull = async () => {
    try {
      await d.pull();
    } catch {
      /* offline or 5xx: the next tick or event tries again */
    }
  };
  const tick = async () => {
    if (stopped || busy || !d.hasActiveJobs) return;
    busy = true;
    let active = false;
    try {
      active = await d.hasActiveJobs();
    } catch {
      active = false;
    }
    // Pull on every active tick, and once more on the tick a batch goes quiet (its last job).
    if (active || wasActive) await safePull();
    busy = false;
    if (stopped) return;
    if (active) delay = wasActive ? Math.min(delay * 1.5, POLL.activeMaxMs) : POLL.activeMs;
    else delay = wasActive ? POLL.idleMs : Math.min(Math.max(delay, POLL.idleMs / 2) * 2, POLL.idleMaxMs);
    wasActive = active;
    timer = schedule(() => void tick(), delay);
  };
  const onEvent = () => {
    if (stopped) return;
    void safePull();
    // Something just finished: look again soon (more of the batch is likely running).
    if (d.hasActiveJobs) {
      if (timer) cancel(timer);
      wasActive = true;
      delay = POLL.activeMs;
      timer = schedule(() => void tick(), delay);
    }
  };
  const offs = ["annotations.committed", "job.succeeded"].map((t) => d.subscribe(t, onEvent));
  if (d.hasActiveJobs) timer = schedule(() => void tick(), POLL.activeMs);
  return () => {
    stopped = true;
    if (timer) cancel(timer);
    offs.forEach((off) => off());
  };
}

/** Follow new AI suggestions for the open Studio (needs the page's project stream for events). */
export function useLiveSuggestions(projectId: string | undefined, streamProjectId?: string) {
  useEffect(() => {
    if (!projectId) return;
    return followSuggestions({
      pull: () => pullSuggestions(projectId),
      hasActiveJobs: kernelEnabled() ? () => activeJobs(projectId) : undefined,
      // Events come from the route's project stream; a Studio's task id may differ from it.
      subscribe: (type, fn) => onProjectEvent(type, (_data, pid) => (!streamProjectId || pid === streamProjectId || pid === projectId) && fn()),
    });
  }, [projectId, streamProjectId]);
}
