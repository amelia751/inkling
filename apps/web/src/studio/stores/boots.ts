import { create } from "zustand";
import { toast } from "@studio/ui/ui/sonner";
import { onProjectEvent } from "@/studio/lib/use-project-events";
import { api } from "@/studio/lib/projects-api";
import { fetchEnvironment, saveEnvironment } from "@/studio/lib/api";
import { studioUrl } from "@/studio/lib/routes";
import { useAgent } from "./agent";

/**
 * Studio boots (todo11 Milestone 2, client): what the boot card and the top-bar pill show,
 * fed only by the project stream's `boot.*` events (plus the boot route's own answer for
 * boots this tab started), so it works the same for boots the model started and for the New
 * Studio button or `/studio`.
 *
 * Navigation (D6): the tab that asked navigates itself (a person's boot from here, or a boot
 * whose `initiator.runId` is the run this tab streams). Every other tab gets a deep link: the
 * card, the Studio list and a toast.
 */

export type BootPhase = "running" | "ready" | "failed" | "stopped";
export type StepState = "pending" | "active" | "done" | "failed";

export interface BootStep {
  step: string;
  state: StepState;
  label: string;
  artefact?: string;
}

export interface BootView {
  bootId: string;
  projectId: string;
  taskIds: string[];
  preset: string;
  initiator?: { kind: "person" | "agent"; runId?: string };
  state: BootPhase;
  steps: BootStep[];
  ms?: number;
  message?: string;
  /** Client clock when it was first seen (the pill hides a while after it finishes). */
  seenAt: number;
  finishedAt?: number;
  /** This tab asked for it (it navigates itself; others get links). */
  own: boolean;
  /** The refinement was reverted from the card. */
  undone?: boolean;
  published?: boolean;
}

interface BootsState {
  boots: Record<string, BootView>;
  /** A navigation this tab should make (consumed by `BootNavigator` inside the router). */
  pendingNav: { bootId: string; url: string } | null;
  /** Ask the boot route for a Studio (New Studio, `/studio`, an offer card's Create). */
  start: (projectId: string, req: { preset: string; name?: string; patch?: unknown[]; bootId?: string }) => Promise<BootView>;
  /** Stop following: what's built stays (a draft task the person can open or discard). */
  stop: (bootId: string) => void;
  /** Revert the refinement (revision 2 → the preset alone). */
  undo: (bootId: string) => Promise<void>;
  publish: (bootId: string) => Promise<void>;
  clearNav: () => void;
}

export const newBootId = () => `boot_${crypto.randomUUID().replace(/-/g, "")}`;

const ORDER: Record<string, number> = { task: 0, files: 1, environment: 2, refine: 3 };

/** The rows the card shows: the steps that happened, then what's still to come while it runs. */
export function bootRows(b: BootView): BootStep[] {
  const rows = [...b.steps].sort((x, y) => (ORDER[x.step] ?? 9) - (ORDER[y.step] ?? 9));
  if (b.state !== "running") return rows;
  const have = new Set(rows.map((r) => r.step));
  const next: BootStep[] = [];
  if (!have.has("task")) next.push({ step: "task", state: "pending", label: "Create the draft task" });
  if (!have.has("environment")) next.push({ step: "environment", state: "pending", label: `Set up from ${b.preset || "the preset"}` });
  if (next[0]) next[0] = { ...next[0], state: "active" };
  return [...rows, ...next];
}

export const bootSeconds = (b: BootView) => (b.ms !== undefined ? b.ms / 1000 : b.finishedAt ? (b.finishedAt - b.seenAt) / 1000 : 0);
export const formatSeconds = (s: number) => (s < 1 ? s.toFixed(2) : s < 10 ? s.toFixed(1) : Math.round(s).toString());

type Started = { bootId: string; taskIds?: string[]; preset?: string; initiator?: BootView["initiator"] };
type Step = { bootId: string; step: string; state?: string; label: string; artefact?: string };
type Ready = { bootId: string; taskIds?: string[]; ms?: number };
type Failed = { bootId: string; step?: string; message?: string };

export const useBoots = create<BootsState>()((set, get) => {
  const put = (bootId: string, projectId: string, fn: (b: BootView) => BootView) =>
    set((s) => {
      const cur = s.boots[bootId] ?? { bootId, projectId, taskIds: [], preset: "", state: "running" as const, steps: [], seenAt: Date.now(), own: false };
      return { boots: { ...s.boots, [bootId]: fn(cur) } };
    });

  const navigateTo = (b: BootView) => {
    const task = b.taskIds[0];
    if (!task) return;
    set({ pendingNav: { bootId: b.bootId, url: studioUrl(b.projectId, task) } });
  };

  // ---- project events ------------------------------------------------------------------------
  onProjectEvent("boot.started", (data, projectId) => {
    const e = data as Started | null;
    if (!e?.bootId) return;
    const before = get().boots[e.bootId];
    // The run streaming in this tab started it: its card goes under that message, and this tab opens the Studio.
    const mine = !!(e.initiator?.kind === "agent" && e.initiator.runId && useAgent.getState().attachBoot(e.initiator.runId, e.bootId));
    put(e.bootId, projectId, (b) => ({ ...b, taskIds: e.taskIds ?? b.taskIds, preset: e.preset ?? b.preset, initiator: e.initiator ?? b.initiator, own: b.own || mine }));
    const b = get().boots[e.bootId];
    if (b.own && !before?.taskIds.length) navigateTo(b);
  });
  onProjectEvent("boot.step", (data, projectId) => {
    const e = data as Step | null;
    if (!e?.bootId) return;
    const step: BootStep = { step: e.step, state: e.state === "failed" ? "failed" : "done", label: e.label, ...(e.artefact ? { artefact: e.artefact } : {}) };
    put(e.bootId, projectId, (b) => ({ ...b, steps: [...b.steps.filter((s) => s.step !== e.step), step] }));
  });
  onProjectEvent("boot.ready", (data, projectId) => {
    const e = data as Ready | null;
    if (!e?.bootId) return;
    const was = get().boots[e.bootId];
    if (was?.state === "ready") return;
    put(e.bootId, projectId, (b) => ({ ...b, state: b.state === "stopped" ? "stopped" : "ready", taskIds: e.taskIds ?? b.taskIds, ms: e.ms ?? b.ms, finishedAt: Date.now() }));
    const b = get().boots[e.bootId];
    if (!b.own && b.taskIds[0]) {
      // Someone else's boot (another tab, the model elsewhere): a deep link, never a navigation.
      toast("Studio ready", { id: `boot-${b.bootId}`, description: "A draft Studio was set up in this project.", action: { label: "Open", onClick: () => navigateTo(b) } });
    }
  });
  onProjectEvent("boot.failed", (data, projectId) => {
    const e = data as Failed | null;
    if (!e?.bootId) return;
    put(e.bootId, projectId, (b) => ({
      ...b,
      state: "failed",
      message: e.message ?? b.message,
      finishedAt: Date.now(),
      steps: e.step ? [...b.steps.filter((s) => s.step !== e.step), { step: e.step, state: "failed", label: e.message ?? "Failed" }] : b.steps,
    }));
  });

  return {
    boots: {},
    pendingNav: null,
    start: async (projectId, req) => {
      const bootId = req.bootId ?? newBootId();
      put(bootId, projectId, (b) => ({ ...b, preset: req.preset, own: true, initiator: { kind: "person" } }));
      try {
        const res = await api<{ bootId: string; taskIds: string[]; state: "running" | "ready" | "failed"; steps?: Step[]; ms?: number }>(`/projects/${encodeURIComponent(projectId)}/boots`, {
          method: "POST",
          json: { bootId, preset: req.preset, ...(req.name ? { name: req.name } : {}), ...(req.patch?.length ? { patch: req.patch } : {}) },
        });
        const had = get().boots[bootId]?.taskIds.length;
        put(bootId, projectId, (b) => ({
          ...b,
          taskIds: res.taskIds?.length ? res.taskIds : b.taskIds,
          // The route answers after the boot ran; the events say the same, whichever lands first.
          state: b.state === "running" ? (res.state === "failed" ? "failed" : res.state === "ready" ? "ready" : "running") : b.state,
          ms: res.ms ?? b.ms,
          finishedAt: res.state === "running" ? b.finishedAt : (b.finishedAt ?? Date.now()),
          steps: b.steps.length ? b.steps : (res.steps ?? []).map((s) => ({ step: s.step, state: s.state === "failed" ? "failed" : "done", label: s.label, ...(s.artefact ? { artefact: s.artefact } : {}) })),
        }));
        if (!had) navigateTo(get().boots[bootId]);
      } catch (e) {
        put(bootId, projectId, (b) => ({ ...b, state: "failed", message: e instanceof Error ? e.message : String(e), finishedAt: Date.now() }));
      }
      return get().boots[bootId];
    },
    stop: (bootId) => {
      const b = get().boots[bootId];
      if (!b || b.state !== "running") return;
      // A boot the model is running: stop its run. Steps already done stay done.
      if (b.initiator?.runId && useAgent.getState().active?.runId === b.initiator.runId) useAgent.getState().stop();
      put(bootId, b.projectId, (x) => ({ ...x, state: "stopped", finishedAt: Date.now() }));
    },
    undo: async (bootId) => {
      const b = get().boots[bootId];
      const task = b?.taskIds[0];
      if (!b || !task) return;
      const cur = await fetchEnvironment(task);
      await saveEnvironment(task, { revision: cur.revision, environment: { extends: b.preset } as never, author: "person" });
      put(bootId, b.projectId, (x) => ({ ...x, undone: true }));
    },
    publish: async (bootId) => {
      const b = get().boots[bootId];
      const task = b?.taskIds[0];
      if (!b || !task) return;
      await api(`/tasks/${encodeURIComponent(task)}/publish`, { method: "POST" });
      put(bootId, b.projectId, (x) => ({ ...x, published: true }));
    },
    clearNav: () => set({ pendingNav: null }),
  };
});
