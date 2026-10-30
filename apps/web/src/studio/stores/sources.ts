import { create } from "zustand";
import { RES } from "@studio/contracts/naming";

/**
 * Sources browser preferences (todo6 Phase 4): the inspector's open state and the list or
 * grid view, remembered per folder *kind* ("mostly images"), never per path (paths may hold
 * identifiers). Per-viewer conveniences, so localStorage, guarded.
 */
const KEY = `${RES}-sources`;

export type SourcesView = "list" | "grid";

interface Prefs {
  inspector: boolean;
  views: Record<string, SourcesView>;
}

interface SourcesPrefs extends Prefs {
  setInspector: (open: boolean) => void;
  setView: (folderKind: string, view: SourcesView) => void;
}

function read(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as Partial<Prefs>) : {};
    return { inspector: v.inspector ?? true, views: v.views && typeof v.views === "object" ? v.views : {} };
  } catch {
    return { inspector: true, views: {} };
  }
}

function write(p: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage blocked: keep the in-memory value */
  }
}

export const useSourcesPrefs = create<SourcesPrefs>((set, get) => ({
  ...read(),
  setInspector: (inspector) => {
    set({ inspector });
    write({ inspector, views: get().views });
  },
  setView: (folderKind, view) => {
    const views = { ...get().views, [folderKind]: view };
    set({ views });
    write({ inspector: get().inspector, views });
  },
}));

/** Folders that are mostly pictures open as a grid unless the person chose otherwise. */
export function defaultView(folderKind: string): SourcesView {
  return folderKind === "image" || folderKind === "dicom" || folderKind === "slide" ? "grid" : "list";
}
