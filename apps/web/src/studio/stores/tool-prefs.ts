import { create } from "zustand";
import { RES } from "@studio/contracts/naming";

/**
 * Toolbar and shortcuts-sheet preferences (todo8 D4, D6): the last tool used in each folded
 * tool group, per environment, and whether the shortcuts sheet has been opened once (the
 * status bar's `? Shortcuts` hint shows until then). Per-viewer conveniences, so
 * localStorage, guarded; never in `useStudio`, whose fields are a test contract.
 */
const KEY = `${RES}-tool-prefs`;

interface Prefs {
  /** envId → tool group → tool name. */
  lastUsed: Record<string, Record<string, string>>;
  shortcutsSeen: boolean;
}

interface ToolPrefs extends Prefs {
  /** Remember `tool` as the face of its group's split button in this environment. */
  remember: (envId: string, group: string, tool: string) => void;
  markShortcutsSeen: () => void;
}

function read(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as Partial<Prefs>) : {};
    return { lastUsed: v.lastUsed && typeof v.lastUsed === "object" ? v.lastUsed : {}, shortcutsSeen: v.shortcutsSeen === true };
  } catch {
    return { lastUsed: {}, shortcutsSeen: false };
  }
}

function write(p: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage blocked: keep the in-memory value */
  }
}

export const useToolPrefs = create<ToolPrefs>((set, get) => ({
  ...read(),
  remember: (envId, group, tool) => {
    if (get().lastUsed[envId]?.[group] === tool) return;
    const lastUsed = { ...get().lastUsed, [envId]: { ...get().lastUsed[envId], [group]: tool } };
    set({ lastUsed });
    write({ lastUsed, shortcutsSeen: get().shortcutsSeen });
  },
  markShortcutsSeen: () => {
    if (get().shortcutsSeen) return;
    set({ shortcutsSeen: true });
    write({ lastUsed: get().lastUsed, shortcutsSeen: true });
  },
}));

/** Record a tool choice (toolbar click, menu row or hotkey) as its group's last used tool. */
export function rememberTool(envId: string, tool: { name: string; group: string }): void {
  useToolPrefs.getState().remember(envId, tool.group, tool.name);
}
