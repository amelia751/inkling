import { create } from "zustand";
import { RES } from "@studio/contracts/naming";
import { personKey } from "@/studio/lib/person-key";
import type { QueueFilter } from "@/studio/lib/item-folders";

/**
 * The Items panel's view state (todo8 D3), outside `useStudio` (whose fields are a test
 * contract): Folders or Queue, remembered per task in this browser (a per-person
 * convenience, so localStorage, guarded), the Queue's status chip, and the folder the status
 * bar's path narrowed the list to.
 */
export type ItemsView = "folders" | "queue";

const key = (taskId: string) => personKey(`${RES}-items-view-${taskId}`);

export function readView(taskId: string): ItemsView | null {
  try {
    const v = localStorage.getItem(key(taskId));
    return v === "folders" || v === "queue" ? v : null;
  } catch {
    return null;
  }
}

function writeView(taskId: string, view: ItemsView) {
  try {
    localStorage.setItem(key(taskId), view);
  } catch {
    /* storage blocked: the choice lasts for this page */
  }
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
