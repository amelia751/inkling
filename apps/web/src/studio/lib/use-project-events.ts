import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { withDevPrincipal } from "@/studio/lib/dev-principal";
import { apiUrl } from "@/extension-host/runtime-config";
import { invalidateFor } from "@/studio/lib/invalidate";

/**
 * Live project updates (todo6 Phase 1.2): the kernel's server-sent events invalidate the
 * React Query keys they affect, so Overview, Sources and Explore follow an import while it
 * runs. EventSource reconnects on its own (the kernel ends a stream every few minutes).
 *
 * todo11 Milestone 2: the stream also carries `environment.updated` and `boot.*`. One
 * connection per project is shared by the pages that ask for it and outlives a route change
 * by a moment, so an SPA navigation (the tab that started a boot opening its Studio) doesn't
 * drop the events in between; a reopened stream resumes after the last event it saw.
 */
type ProjectEventListener = (data: unknown, projectId: string) => void;
const listeners = new Map<string, Set<ProjectEventListener>>();

/**
 * Event types forwarded to `onProjectEvent` subscribers (todo7: `fs.changed`; todo11: environments,
 * boots and `item.*`; todo12: pipeline runs, candidates and their reviews, `core/pipelines/contract.ts`).
 */
export const FORWARDED = [
  "fs.changed",
  "import.updated",
  "source.node.inspected",
  "environment.updated",
  "boot.started",
  "boot.step",
  "boot.ready",
  "boot.failed",
  "item.registered",
  "item.uploaded",
  "item.probed",
  "item.thumb_ready",
  "item.preview_ready",
  "item.ready",
  "item.failed",
  "pipeline.run.started",
  "pipeline.run.completed",
  "pipeline.run.failed",
  "pipeline.run.paused",
  "pipeline.step.started",
  "pipeline.step.completed",
  "pipeline.step.failed",
  "pipeline.output.staged",
  "dataset.candidate.created",
  "review.requested",
  "review.approved",
  // todo13 §5 drop events (core/drops follows them on its cards; the drop timeline reads them).
  "drop.received",
  "drop.file",
  "drop.classified",
  "drop.planned",
  "drop.applied",
  "drop.failed",
];

/**
 * Listen to one event type on the page's project stream (opened by `useProjectEvents`, one
 * per page). `data` is the event's parsed JSON. Returns the unsubscribe function.
 */
export function onProjectEvent(type: string, fn: ProjectEventListener): () => void {
  const set = listeners.get(type) ?? new Set();
  set.add(fn);
  listeners.set(type, set);
  return () => set.delete(fn);
}

/** Deliver an event to subscribers (the stream, and tests). */
export function emitProjectEvent(type: string, data: unknown, projectId: string): void {
  listeners.get(type)?.forEach((fn) => fn(data, projectId));
}

/** Kept open this long after its last page lets go, so a navigation reuses it. */
const LINGER_MS = 3000;

interface Connection {
  es: EventSource;
  refs: number;
  close?: ReturnType<typeof setTimeout>;
}
const connections = new Map<string, Connection>();
/** Last event id seen per project: a reopened stream continues from there (`?after=`). */
const lastIds = new Map<string, string>();
let client: QueryClient | null = null;

function open(projectId: string): EventSource {
  const after = lastIds.get(projectId);
  // No headers on an EventSource: the dev principal rides in the URL (the Vite proxy makes it a header).
  const es = new EventSource(withDevPrincipal(apiUrl(`/v1/projects/${encodeURIComponent(projectId)}/events${after ? `?after=${encodeURIComponent(after)}` : ""}`)));
  const seen = (e: Event) => {
    const id = (e as MessageEvent).lastEventId;
    if (id) lastIds.set(projectId, id);
  };
  // todo18 D1: every event refreshes what `invalidateFor` says, app-wide (not only on the page that listens).
  for (const type of ["proposal.created", "proposal.decided"]) {
    es.addEventListener(type, (e) => {
      seen(e);
      if (client) invalidateFor(client, projectId, type);
    });
  }
  for (const type of FORWARDED) {
    es.addEventListener(type, (e) => {
      seen(e);
      let data: unknown = null;
      try {
        data = JSON.parse((e as MessageEvent<string>).data);
      } catch {
        // Events without a JSON body still notify.
      }
      if (client) invalidateFor(client, projectId, type, data && typeof data === "object" ? (data as { taskId?: string; datasetId?: string }) : undefined);
      emitProjectEvent(type, data, projectId);
    });
  }
  return es;
}

export function useProjectEvents(projectId: string | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!projectId || typeof EventSource === "undefined") return;
    client = qc;
    let c = connections.get(projectId);
    if (c) {
      clearTimeout(c.close);
      c.refs++;
    } else connections.set(projectId, (c = { es: open(projectId), refs: 1 }));
    const conn = c;
    return () => {
      if (--conn.refs > 0) return;
      conn.close = setTimeout(() => {
        if (conn.refs > 0) return;
        conn.es.close();
        if (connections.get(projectId) === conn) connections.delete(projectId);
      }, LINGER_MS);
    };
  }, [projectId, qc]);
}
