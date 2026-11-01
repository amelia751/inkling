import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { AssetIngest, IngestState, ItemEvent, Project, SeedAsset } from "@studio/contracts/types";
import { RES } from "@studio/contracts/naming";
import { apiUrl } from "@/extension-host/runtime-config";
import { kernelEnabled } from "@/extension-host/kernel";
import { onProjectEvent } from "@/studio/lib/use-project-events";

/**
 * Items as they ingest (todo11 D8, Milestone 3 Slice A). A drop into a Studio registers its
 * images at once; `item.*` events on the project stream then move each one along
 * (`registered` → `uploaded` → `probed` → `thumb_ready` → `preview_ready` → `ready`). Both are
 * applied to the cached task document in place (one cache write per frame), so the rail inserts
 * rows and the viewer upgrades without refetching the document. `GET /v1/tasks/:id/items?after=`
 * catches up on what this page missed (the cursor is how many items it already has).
 */

export const ITEM_EVENT_TYPES = ["item.registered", "item.uploaded", "item.probed", "item.thumb_ready", "item.preview_ready", "item.ready", "item.failed"] as const;

const RANK: Record<IngestState, number> = { registered: 0, uploaded: 1, probed: 2, thumb_ready: 3, preview_ready: 4, ready: 5, failed: 6 };

const docKey = (taskId: string) => ["tasks", taskId, "document"];

/** Has the item's original arrived (so a viewer can load it)? Items without `ingest` always have. */
export function isLoadable(a: SeedAsset | undefined): boolean {
  return !!a && (!a.ingest || (a.ingest.state !== "registered" && a.ingest.state !== "failed"));
}

/** Merge assets into a document: same path replaces (keeping the further ingest state), new ones append. */
export function mergeAssets(doc: Project, incoming: SeedAsset[]): Project {
  if (!incoming.length) return doc;
  const at = new Map(doc.assets.map((a, i) => [a.path, i]));
  const assets = doc.assets.slice();
  for (const a of incoming) {
    const i = at.get(a.path);
    if (i === undefined) {
      at.set(a.path, assets.length);
      assets.push(a);
    } else {
      const cur = assets[i];
      if (cur.ingest && a.ingest && RANK[cur.ingest.state] > RANK[a.ingest.state]) assets[i] = { ...a, ...cur, ingest: { ...a.ingest, ...cur.ingest } };
      else assets[i] = { ...cur, ...a, ...(a.ingest ? { ingest: { ...cur.ingest, ...a.ingest } } : {}) };
    }
  }
  return { ...doc, assets };
}

/** One `item.<state>` event applied to a document; `missed` when it names an item we don't have. */
export function applyItemEvent(doc: Project, type: string, ev: ItemEvent): { doc: Project; missed: boolean } {
  const state = type.slice("item.".length) as IngestState;
  if (!(state in RANK)) return { doc, missed: false };
  const meta = ev.meta ?? {};
  const i = doc.assets.findIndex((a) => a.path === ev.itemId);
  if (i < 0) {
    if (state !== "registered") return { doc, missed: true };
    const entry: SeedAsset = { path: ev.itemId, sha256: "", bytes: meta.bytes ?? 0, name: meta.name, nodeId: ev.nodeId, ingest: { state, seq: meta.seq } };
    return { doc: { ...doc, assets: [...doc.assets, entry] }, missed: false };
  }
  const cur = doc.assets[i];
  const was = cur.ingest?.state ?? "ready";
  if (RANK[state] < RANK[was] && state !== "failed") return { doc, missed: false };
  const ingest: AssetIngest = { ...cur.ingest, state };
  for (const k of ["thumb", "thumbhash", "preview", "error"] as const) if (meta[k]) ingest[k] = meta[k];
  const next: SeedAsset = { ...cur, ingest, ...(meta.width ? { width: meta.width } : {}), ...(meta.height ? { height: meta.height } : {}) };
  const assets = doc.assets.slice();
  assets[i] = next;
  return { doc: { ...doc, assets }, missed: false };
}

// ---- Timing marks (todo11 §7: `registered` → skeleton < 300 ms; `thumb_ready` → thumbnail < 500 ms)

type MarkKind = "registered" | "skeleton" | "thumbEvent" | "thumbPainted" | "previewPainted" | "fullPainted";
const marks: Record<MarkKind, Record<string, number>> = { registered: {}, skeleton: {}, thumbEvent: {}, thumbPainted: {}, previewPainted: {}, fullPainted: {} };

/** First time `kind` happened for an item (performance.now()); later calls are ignored. */
export function markIngest(kind: MarkKind, itemId: string): void {
  if (marks[kind][itemId] === undefined) marks[kind][itemId] = performance.now();
}
if (import.meta.env.DEV && typeof window !== "undefined") (window as unknown as Record<string, unknown>)[`__${RES}Ingest`] = marks;

// ---- Applying updates (batched per frame) ------------------------------------------------------

type Op = { kind: "assets"; assets: SeedAsset[] } | { kind: "event"; type: string; ev: ItemEvent };
const pending = new Map<string, Op[]>();
let frame = 0;

function flush(qc: QueryClient) {
  frame = 0;
  const work = [...pending.entries()];
  pending.clear();
  for (const [taskId, ops] of work) {
    let missed = false;
    qc.setQueryData<Project>(docKey(taskId), (doc) => {
      if (!doc) return doc;
      let d = doc;
      for (const op of ops) {
        if (op.kind === "assets") d = mergeAssets(d, op.assets);
        else {
          const r = applyItemEvent(d, op.type, op.ev);
          d = r.doc;
          missed ||= r.missed;
        }
      }
      return d;
    });
    if (missed) void catchUp(qc, taskId);
  }
}

function queue(qc: QueryClient, taskId: string, op: Op) {
  const ops = pending.get(taskId) ?? [];
  ops.push(op);
  pending.set(taskId, ops);
  if (!frame) frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => flush(qc)) : (setTimeout(() => flush(qc), 16) as unknown as number);
}

/** Items the server just registered (the drop's own response): into the rail now, no round trip. */
export function insertRegistered(qc: QueryClient, taskId: string, assets: SeedAsset[]): void {
  for (const a of assets) markIngest("registered", a.path);
  queue(qc, taskId, { kind: "assets", assets });
}

const catching = new Set<string>();

/** Fetch the items after the ones we have (`?after=<count>`), page by page. */
export async function catchUp(qc: QueryClient, taskId: string): Promise<void> {
  if (!kernelEnabled() || catching.has(taskId)) return;
  catching.add(taskId);
  try {
    let after: string | null = String(qc.getQueryData<Project>(docKey(taskId))?.assets.length ?? 0);
    while (after !== null) {
      const res = await fetch(apiUrl(`/v1/tasks/${encodeURIComponent(taskId)}/items?after=${after}`));
      if (!res.ok) return;
      const page = (await res.json()) as { items: SeedAsset[]; next: string | null };
      if (page.items.length) queue(qc, taskId, { kind: "assets", assets: page.items });
      after = page.next;
    }
  } finally {
    catching.delete(taskId);
  }
}

/** The Studio's subscription: `item.*` events for this task go into its document. */
export function useTaskItems(taskId: string | undefined): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!taskId) return;
    const offs = ITEM_EVENT_TYPES.map((type) =>
      onProjectEvent(type, (data) => {
        const ev = data as ItemEvent | null;
        if (!ev || ev.taskId !== taskId) return;
        if (type === "item.registered") markIngest("registered", ev.itemId);
        if (type === "item.thumb_ready") markIngest("thumbEvent", ev.itemId);
        queue(qc, taskId, { kind: "event", type, ev });
      }),
    );
    void catchUp(qc, taskId);
    return () => offs.forEach((off) => off());
  }, [qc, taskId]);
}

// ---- Visible items (the worker serves these first) --------------------------------------------

let visibleTimer: number | undefined;
let lastVisible = "";

/** Tell the kernel which ingesting items are on screen (debounced; only when it changed). */
export function postVisible(taskId: string, itemIds: string[]): void {
  if (!kernelEnabled() || !itemIds.length) return;
  const key = `${taskId}:${itemIds.join("|")}`;
  if (key === lastVisible) return;
  window.clearTimeout(visibleTimer);
  visibleTimer = window.setTimeout(() => {
    lastVisible = key;
    void fetch(apiUrl(`/v1/tasks/${encodeURIComponent(taskId)}/items/visible`), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemIds }) }).catch(() => undefined);
  }, 150);
}
