import { create } from "zustand";
import type { DropAction, DropGroup, DropPlan, DropPlanState } from "@studio/contracts/drop-plan";
import { apiUrl } from "@/extension-host/runtime-config";
import { onProjectEvent } from "@/studio/lib/use-project-events";
import { api } from "@/studio/lib/projects-api";
import { studioUrl } from "@/studio/lib/routes";
import { useBoots } from "@/studio/stores/boots";
import { apiFetch } from "@/extension-host/http";

/**
 * Drop plans (todo13 D5, D6, §3.3): what the plan card shows, fed by the project stream's
 * `drop.classified`, `drop.planned`, `drop.applied` and `drop.failed` events, plus the plan
 * route (`GET /drops/{id}/plan`) for a card opened after its events went by.
 *
 * Apply, Change and Undo go to the kernel (`POST /drops/{id}/apply`, `PUT …/plan`, `POST …/undo`);
 * their answers and the events say the same thing, whichever lands first.
 *
 * Navigation: the tab that dropped (`markOwn`, called by the composer's drop card) opens the
 * Studio a fast-path apply booted; every other tab gets the card's "Open Studio" link. A second
 * drop never navigates an open Studio away (J4): only a fast path (a new dataset) does.
 */

export type PlanPhase = "classified" | "planned" | "applying" | "applied" | "undone" | "failed";

export interface PlanView {
  dropId: string;
  projectId: string;
  state: PlanPhase;
  groups: Omit<DropGroup, "nodeIds">[];
  plan?: DropPlan;
  auto: boolean;
  fastPath: boolean;
  datasetId?: string;
  taskIds: string[];
  collectionIds: string[];
  undoUntil: string | null;
  pipelineRunIds?: string[];
  failed?: { step: string; errorClass: string };
  /** Archives the worker refused to unpack (zip bomb, traversal, …): node id → reason. */
  refused: Record<string, string>;
  /** This tab made the drop (it navigates on a fast path). */
  own: boolean;
  /** Fast path applied, the Studio opens on its first `item.ready` ("Preparing your first item"). */
  waitingFirstItem?: boolean;
  seenAt: number;
}

/** What `POST /drops/{id}/replan` did to an applied drop (ids only). */
export interface ReplanSummary {
  changed?: boolean;
  moved: { collectionId: string; nodeIds: string[] }[];
  createdCollections: string[];
  createdStudios: string[];
  retiredStudios: string[];
  retiredCollections: string[];
  keptAnnotated: string[];
}

const studios = (n: number) => `${n} ${n === 1 ? "Studio" : "Studios"}`;

/** The summary in the card's words. */
export function replanSummaryText(s: ReplanSummary): string {
  const files = s.moved.reduce((n, m) => n + m.nodeIds.length, 0);
  const parts: string[] = [];
  if (files) parts.push(`${files} ${files === 1 ? "file" : "files"} moved`);
  if (s.createdStudios.length) parts.push(`${s.createdStudios.length} new ${s.createdStudios.length === 1 ? "Studio" : "Studios"}`);
  if (s.retiredStudios.length) parts.push(`${studios(s.retiredStudios.length)} left empty moved to Trash`);
  if (s.keptAnnotated.length) parts.push(`${studios(s.keptAnnotated.length)} kept because of annotations`);
  return parts.length ? `Re-planned: ${parts.join(", ")}.` : "Already matches the current rules: nothing changed.";
}

interface PlansState {
  plans: Record<string, PlanView>;
  load: (dropId: string) => Promise<PlanView | undefined>;
  apply: (dropId: string, actions?: Partial<DropAction>[]) => Promise<void>;
  change: (dropId: string, actions: Partial<DropAction>[]) => Promise<void>;
  undo: (dropId: string) => Promise<void>;
  /** Classify again with the current rules; an applied plan is reconciled (`POST …/replan`). */
  replan: (dropId: string) => Promise<ReplanSummary>;
  markOwn: (dropId: string) => void;
}

const enc = encodeURIComponent;

function blank(dropId: string, projectId: string): PlanView {
  return { dropId, projectId, state: "classified", groups: [], auto: false, fastPath: false, taskIds: [], collectionIds: [], undoUntil: null, refused: {}, own: false, seenAt: Date.now() };
}

/** Undo is offered while the window is open (D6: 30 s by default, the server's clock decides). */
export const undoSecondsLeft = (p: PlanView, now = Date.now()) => (p.state === "applied" && p.undoUntil ? Math.max(0, Math.ceil((Date.parse(p.undoUntil) - now) / 1000)) : 0);

/** Asks that hold the plan for a person (the others are offers beside an action). */
export const QUESTIONS = new Set(["labels_table", "tabular_collection", "which_dataset"]);

/** How long the fast path waits for the first item before opening the Studio anyway. */
export const FIRST_ITEM_WAIT_MS = 30_000;
/** Tasks that already have a ready item (an `item.ready` can beat `drop.applied`). */
const readyTasks = new Set<string>();

export const usePlans = create<PlansState>()((set, get) => {
  const put = (dropId: string, projectId: string, fn: (p: PlanView) => PlanView) =>
    set((s) => ({ plans: { ...s.plans, [dropId]: fn(s.plans[dropId] ?? blank(dropId, projectId)) } }));
  const open = (dropId: string, projectId: string, task: string) => {
    put(dropId, projectId, (x) => ({ ...x, waitingFirstItem: false }));
    useBoots.setState({ pendingNav: { bootId: dropId, url: studioUrl(projectId, task) } });
  };

  const fromState = (st: DropPlanState, projectId?: string) =>
    put(st.dropId, projectId ?? st.projectId, (p) => ({
      ...p,
      projectId: st.projectId ?? p.projectId,
      state: st.state,
      plan: st.plan,
      groups: st.groups.map(({ nodeIds: _ids, ...g }) => g),
      auto: st.auto,
      fastPath: !!st.fastPath,
      datasetId: st.datasetId ?? p.datasetId,
      taskIds: st.taskIds,
      collectionIds: st.collectionIds,
      undoUntil: st.undoUntil,
      pipelineRunIds: st.pipelineRunIds,
      failed: st.error ? { step: st.error.step, errorClass: st.error.errorClass } : p.failed,
    }));

  onProjectEvent("drop.classified", (data, projectId) => {
    const e = data as { dropId?: string; groups?: Omit<DropGroup, "nodeIds">[] } | null;
    if (!e?.dropId) return;
    put(e.dropId, projectId, (p) => ({ ...p, groups: e.groups ?? p.groups, state: p.state === "classified" ? "classified" : p.state }));
  });
  onProjectEvent("drop.planned", (data, projectId) => {
    const e = data as { dropId?: string; plan?: DropPlan; auto?: boolean } | null;
    if (!e?.dropId || !e.plan) return;
    put(e.dropId, projectId, (p) => ({ ...p, plan: e.plan, auto: !!e.auto, state: e.auto ? "applying" : "planned", failed: undefined }));
  });
  onProjectEvent("drop.applied", (data, projectId) => {
    const e = data as { dropId?: string; datasetId?: string; taskIds?: string[]; undoUntil?: string | null; collectionIds?: string[]; pipelineRunIds?: string[]; undone?: boolean; fastPath?: boolean } | null;
    if (!e?.dropId) return;
    const before = get().plans[e.dropId];
    put(e.dropId, projectId, (p) => ({
      ...p,
      state: e.undone ? "undone" : "applied",
      datasetId: e.datasetId ?? p.datasetId,
      taskIds: e.undone ? [] : (e.taskIds ?? p.taskIds),
      collectionIds: e.undone ? [] : (e.collectionIds ?? p.collectionIds),
      undoUntil: e.undone ? null : (e.undoUntil ?? null),
      pipelineRunIds: e.pipelineRunIds ?? p.pipelineRunIds,
      fastPath: !!e.fastPath || p.fastPath,
    }));
    const p = get().plans[e.dropId];
    // The fast path opens the new Studio in the tab that dropped (principle 3), once, and only
    // when its first item is ready (todo18: no empty-canvas flash).
    if (!e.undone && e.fastPath && p.own && p.taskIds[0] && before?.state !== "applied") {
      const task = p.taskIds[0];
      if (readyTasks.has(task)) return open(p.dropId, projectId, task);
      put(e.dropId, projectId, (x) => ({ ...x, waitingFirstItem: true }));
      // Nothing waits forever: open anyway after a while (the Studio shows its own progress).
      const dropId = e.dropId;
      setTimeout(() => get().plans[dropId]?.waitingFirstItem && open(dropId, projectId, task), FIRST_ITEM_WAIT_MS);
    }
  });
  onProjectEvent("item.ready", (data, projectId) => {
    const e = data as { taskId?: string } | null;
    if (!e?.taskId) return;
    readyTasks.add(e.taskId);
    for (const p of Object.values(get().plans)) if (p.waitingFirstItem && p.taskIds[0] === e.taskId) open(p.dropId, projectId, e.taskId);
  });
  onProjectEvent("drop.failed", (data, projectId) => {
    const e = data as { dropId?: string; step?: string; errorClass?: string; nodeId?: string } | null;
    if (!e?.dropId) return;
    put(e.dropId, projectId, (p) =>
      e.step === "unpack" && e.nodeId
        ? { ...p, refused: { ...p.refused, [e.nodeId]: e.errorClass ?? "unreadable" } }
        : { ...p, state: p.state === "applied" ? p.state : "failed", failed: { step: e.step ?? "plan", errorClass: e.errorClass ?? "error" } },
    );
  });

  return {
    plans: {},
    load: async (dropId) => {
      try {
        const st = await api<DropPlanState>(`/drops/${enc(dropId)}/plan`);
        fromState(st);
      } catch {
        return get().plans[dropId];
      }
      return get().plans[dropId];
    },
    apply: async (dropId, actions) => {
      const cur = get().plans[dropId];
      if (!cur) return;
      put(dropId, cur.projectId, (p) => ({ ...p, state: "applying" }));
      try {
        fromState(await api<DropPlanState>(`/drops/${enc(dropId)}/apply`, { method: "POST", json: actions ? { actions } : {} }));
      } catch (e) {
        put(dropId, cur.projectId, (p) => ({ ...p, state: "failed", failed: { step: "apply", errorClass: e instanceof Error ? e.message : String(e) } }));
        throw e;
      }
    },
    change: async (dropId, actions) => {
      fromState(await api<DropPlanState>(`/drops/${enc(dropId)}/plan`, { method: "PUT", json: { actions } }));
    },
    undo: async (dropId) => {
      fromState(await api<DropPlanState>(`/drops/${enc(dropId)}/undo`, { method: "POST" }));
    },
    replan: async (dropId) => {
      const out = await api<DropPlanState & { replan?: ReplanSummary }>(`/drops/${enc(dropId)}/replan`, { method: "POST" });
      fromState(out);
      return out.replan ?? { moved: [], createdCollections: [], createdStudios: [], retiredStudios: [], retiredCollections: [], keptAnnotated: [] };
    },
    markOwn: (dropId) => set((s) => ({ plans: { ...s.plans, [dropId]: { ...(s.plans[dropId] ?? blank(dropId, "")), own: true } } })),
  };
});

// ---- Copy ----------------------------------------------------------------------------------

const NOUNS: Record<string, [string, string]> = {
  image: ["image", "images"],
  dicom: ["DICOM image", "DICOM images"],
  "dicom-series": ["DICOM file", "DICOM files"],
  volume: ["volume", "volumes"],
  video: ["video", "videos"],
  waveform: ["recording", "recordings"],
  slide: ["slide", "slides"],
  table: ["table", "tables"],
  document: ["document", "documents"],
  annotations: ["annotation file", "annotation files"],
  archive: ["archive", "archives"],
  mask: ["mask", "masks"],
  unknown: ["file", "files"],
  audio: ["audio file", "audio files"],
};
export const noun = (kind: string | undefined, n: number) => {
  const [one, other] = NOUNS[kind ?? "unknown"] ?? NOUNS.unknown!;
  return `${n} ${n === 1 ? one : other}`;
};

/** todo19 D5: a drop's one dataset and its one Studio, with a count per kind. */
export function memberCounts(a: DropAction): { kind: string; count: number; label: string }[] {
  const by = new Map<string, number>();
  for (const m of a.members ?? []) by.set(m.kind, (by.get(m.kind) ?? 0) + m.count);
  return [...by].map(([kind, count]) => ({ kind, count, label: noun(kind, count) }));
}

/** One line per action, in the card's words (no file names: the plan carries none). */
export function actionLabel(a: DropAction): string {
  const what = noun(a.kind, a.count ?? a.nodeIds.length);
  switch (a.type) {
    case "new_dataset":
      if (a.members?.length) {
        const n = a.count ?? a.nodeIds.length;
        const k = memberCounts(a).length;
        return `One Studio · ${n} ${n === 1 ? "file" : "files"} · ${k} ${k === 1 ? "kind" : "kinds"}`;
      }
      return `${what} → a new draft dataset${a.name ? ` (“${a.name}”)` : ""}`;
    case "new_collection":
      if (a.asks === "labels_table") return `${what}: labels or metadata for these items?`;
      if (a.asks === "tabular_collection") return `${what} → a table collection in this dataset?`;
      return `${what} → a new collection${a.name ? ` “${a.name}”` : ""}${a.datasetId ? " in this dataset" : ""}`;
    case "add_to_collection":
      return `${what} → added to the matching collection`;
    case "unpack":
      return `${what}: unpacked, then sorted like any drop`;
    case "keep_reference":
      return `${what}: kept in Sources as reference`;
    case "keep_unsupported":
      return `${what}: kept in Sources, can't use yet`;
    case "link_existing":
      return `${what}: already in Sources, linked (nothing re-uploaded)`;
    default:
      return what;
  }
}

export const QUESTION_COPY: Record<string, { question: string; yes: string; no: string; noChange: Partial<DropAction> }> = {
  labels_table: { question: "Is this a labels table for these images?", yes: "Yes, use it as labels", no: "No, keep it as reference", noChange: { type: "keep_reference" } },
  tabular_collection: { question: "Add this table to the dataset as its own collection?", yes: "Add it", no: "Keep it in Sources", noChange: { type: "keep_reference" } },
  which_dataset: { question: "Add these to this dataset, or start a separate one?", yes: "Add to this dataset", no: "Start a separate dataset", noChange: { type: "new_dataset", datasetId: null as unknown as undefined } },
};

export const REFUSED_COPY: Record<string, string> = {
  too_large: "Not unpacked: larger than the unpack limit",
  too_many_files: "Not unpacked: more files than the unpack limit",
  ratio: "Not unpacked: it expands far more than a normal archive",
  depth: "Not unpacked: archives nested too deep",
  traversal: "Not unpacked: paths point outside the archive",
  encrypted: "Not unpacked: it's encrypted",
  unreadable: "Not unpacked: we couldn't read it",
  tmp_budget: "Not unpacked: too large to unpack here",
  symlink: "Not unpacked: it holds links",
};

/** "Find a plugin" (todo13 M2 item 8): the catalogue's data kinds that open this kind of file. */
export async function findPlugins(kind: string): Promise<{ id: string; label?: string; module: string; description: string }[]> {
  const res = await apiFetch(apiUrl(`/catalog?kind=${enc(kind)}`));
  if (!res.ok) return [];
  const cat = (await res.json()) as { contributions?: { id: string; label?: string; module: string; description: string; type: string }[] };
  return (cat.contributions ?? []).filter((c) => c.type === "dataKinds");
}
