import { create } from "zustand";
import { RES } from "@studio/contracts/naming";
import { personKey } from "@/studio/lib/person-key";
import { personPrefs } from "@/studio/lib/person-prefs";

/**
 * Sources browser preferences (todo6 Phase 4): the inspector's open state and the list or
 * grid view, remembered per folder *kind* ("mostly images"), never per path (paths may hold
 * identifiers). Per person on the server (todo22 D3, pref `sources`), the old localStorage key as cache.
 */
const PREF = "sources";
const OPTS = { cache: () => personKey(`${RES}-sources`) };

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
  const raw = personPrefs.get<unknown>(PREF, {}, OPTS);
  const v = (raw && typeof raw === "object" ? raw : {}) as Partial<Prefs>;
  return { inspector: v.inspector ?? true, views: v.views && typeof v.views === "object" ? v.views : {} };
}

const write = (p: Prefs) => personPrefs.set(PREF, p, OPTS);

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

// Another person (or organization) signed in, or the server's values arrived (todo15 D1, todo22 D3).
personPrefs.subscribe(() => useSourcesPrefs.setState(read()));
