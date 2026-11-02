import { useCallback } from "react";
import { create } from "zustand";
import { RES } from "@studio/contracts/naming";
import { personKey } from "@/studio/lib/person-key";
import type { DatasetProfile, DatasetSummary } from "@studio/contracts/types";
import type { AgentContextProvider } from "@/studio/lib/agent/providers";
import { useShell } from "@/studio/stores/shell";

/**
 * "Add data" and "Drop files" from Datasets (todo13 Milestone 3 item 7): open the composer
 * scoped to a dataset, so a drop there skips the "which dataset" question.
 *
 * This is the one seam between the Datasets pages and the composer (`todo13-drops`) and the
 * drawer (`todo13-entry`): the pages call `useAddData()` and nothing else. Today it opens the
 * project's assistant drawer with the dataset as its context and records the scope in
 * `useComposerScope`, which the composer reads to target its drop; rewire `open` here when the
 * composer has its own entry point.
 */
export interface ComposerScope {
  projectId: string;
  /** The dataset a drop goes to; absent on the landing page (the plan asks). */
  datasetId?: string;
  datasetTitle?: string;
  /** What the person asked for: pick files, or say what they need. */
  intent: "drop" | "ask";
  at: number;
}

export const useComposerScope = create<{ scope: ComposerScope | null; set: (s: ComposerScope | null) => void }>((set) => ({
  scope: null,
  set: (scope) => set({ scope }),
}));

export function useAddData(projectId: string, dataset?: Pick<DatasetSummary, "id" | "title">) {
  const setAssistant = useShell((s) => s.setAssistant);
  const setScope = useComposerScope((s) => s.set);
  return useCallback(
    (intent: ComposerScope["intent"] = "drop") => {
      setScope({ projectId, datasetId: dataset?.id, datasetTitle: dataset?.title, intent, at: Date.now() });
      setAssistant(true, true);
    },
    [projectId, dataset?.id, dataset?.title, setAssistant, setScope],
  );
}

/**
 * What the assistant sees while a dataset is open: its name, collections and counts, never file
 * names or contents. With it, "Add data" and anything asked here are about this dataset.
 */
export function datasetContext(projectId: string, d: Pick<DatasetSummary, "id" | "title">, p: DatasetProfile | undefined): AgentContextProvider {
  const collections = (p?.collections ?? []).map((c) => `${c.name} (${c.count} ${c.count === 1 ? c.unit.one : c.unit.other}${c.suggested ? ", suggested" : ""})`);
  return {
    key: `${projectId}:dataset:${d.id}:${collections.length}`,
    section: "datasets",
    label: `Datasets › ${d.title}`,
    shares: "This dataset's name, its collections and their counts. Files you drop here go to this dataset. No file names or contents.",
    turnContext: () =>
      [
        `Project: ${projectId}`,
        `Section: Datasets, dataset ${d.title} (${d.id})`,
        `Collections: ${collections.join("; ") || "none yet"}`,
        `Files dropped in this conversation now go to dataset ${d.id} (skip asking which dataset).`,
      ].join("\n"),
  };
}

// ---- Recently opened datasets (per viewer; a convenience, never relied on) ---------------------

const RECENT_KEY = () => personKey(`${RES}-recent-datasets`);
const RECENT_MAX = 6;

export function readRecentDatasets(projectId: string): { id: string; at: number }[] {
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_KEY()) ?? "{}") as Record<string, { id: string; at: number }[]>;
    return Array.isArray(all[projectId]) ? all[projectId] : [];
  } catch {
    return [];
  }
}

export function rememberDataset(projectId: string, datasetId: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_KEY()) ?? "{}") as Record<string, { id: string; at: number }[]>;
    const list = [{ id: datasetId, at: Date.now() }, ...(Array.isArray(all[projectId]) ? all[projectId] : []).filter((x) => x.id !== datasetId)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY(), JSON.stringify({ ...all, [projectId]: list }));
  } catch {
    /* private mode or blocked storage: the list is just shorter */
  }
}
