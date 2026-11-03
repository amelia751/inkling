import { create } from "zustand";
import { RES } from "@studio/contracts/naming";
import { personKey } from "@/studio/lib/person-key";
import { personPrefs, prefSegment } from "@/studio/lib/person-prefs";
import type { QueueFilter } from "@/studio/lib/item-folders";

/**
 * The Items panel's view state (todo8 D3), outside `useStudio` (whose fields are a test
 * contract): Folders or Queue, remembered per task and person on the server (todo22 D3, pref
 * `items-view:<task>`, the old localStorage key as cache), the Queue's status chip, and the folder
 * the status bar's path narrowed the list to.
 */
export type ItemsView = "folders" | "queue";

const pref = (taskId: string) => ({ key: `items-view:${prefSegment(taskId)}`, opts: { cache: () => personKey(`${RES}-items-view-${taskId}`), raw: true } });

export function readView(taskId: string): ItemsView | null {
  const p = pref(taskId);
  const v = personPrefs.get<unknown>(p.key, null, p.opts);
  return v === "folders" || v === "queue" ? v : null;
}

function writeView(taskId: string, view: ItemsView) {
  const p = pref(taskId);
  personPrefs.set(p.key, view, p.opts);
}

interface ItemsViewState {
  /** The view chosen in this page per task (falls back to localStorage, then the default). */
  views: Record<string, ItemsView>;
  setView: (taskId: string, view: ItemsView) => void;
  queueFilter: QueueFilter;
  setQueueFilter: (f: QueueFilter) => void;
  /** Folder segments the list is narrowed to (a status-bar path segment), or null. */
  folderFilter: string[] | null;
  setFolderFilter: (f: string[] | null) => void;
}

export const useItemsView = create<ItemsViewState>((set, get) => ({
  views: {},
  setView: (taskId, view) => {
    set({ views: { ...get().views, [taskId]: view } });
    writeView(taskId, view);
  },
  queueFilter: "all",
  setQueueFilter: (queueFilter) => set({ queueFilter }),
  folderFilter: null,
  setFolderFilter: (folderFilter) => set({ folderFilter }),
}));
