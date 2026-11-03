import { create } from "zustand";
import { RES } from "@studio/contracts/naming";
import { personKey } from "@/studio/lib/person-key";
import { personPrefs } from "@/studio/lib/person-prefs";

/**
 * Toolbar and shortcuts-sheet preferences (todo8 D4, D6): the last tool used in each folded
 * tool group, per environment; whether the shortcuts sheet has been opened once (the
 * status bar's `? Shortcuts` hint shows until then); and the decision bar's "Advance after
 * choosing" (todo8 D5, on by default). Per person on the server (todo22 D3, pref `tool-prefs`),
 * the old localStorage key as cache; never in `useStudio`, whose fields are a test contract.
 */
const PREF = "tool-prefs";
const OPTS = { cache: () => personKey(`${RES}-tool-prefs`) };

interface Prefs {
  /** envId → tool group → tool name. */
  lastUsed: Record<string, Record<string, string>>;
  shortcutsSeen: boolean;
  /** Decision bar: move to the next to-do item after a single-choice pick. */
  advance: boolean;
}

interface ToolPrefs extends Prefs {
  /** Remember `tool` as the face of its group's split button in this environment. */
  remember: (envId: string, group: string, tool: string) => void;
  markShortcutsSeen: () => void;
  setAdvance: (advance: boolean) => void;
}

function read(): Prefs {
  const raw = personPrefs.get<unknown>(PREF, {}, OPTS);
  const v = (raw && typeof raw === "object" ? raw : {}) as Partial<Prefs>;
  return { lastUsed: v.lastUsed && typeof v.lastUsed === "object" ? v.lastUsed : {}, shortcutsSeen: v.shortcutsSeen === true, advance: v.advance !== false };
}

const write = (p: Prefs) => personPrefs.set(PREF, p, OPTS);

export const useToolPrefs = create<ToolPrefs>((set, get) => {
  const update = (patch: Partial<Prefs>) => {
    set(patch);
    const { lastUsed, shortcutsSeen, advance } = get();
    write({ lastUsed, shortcutsSeen, advance });
  };
  return {
    ...read(),
    remember: (envId, group, tool) => {
      if (get().lastUsed[envId]?.[group] === tool) return;
      update({ lastUsed: { ...get().lastUsed, [envId]: { ...get().lastUsed[envId], [group]: tool } } });
    },
    markShortcutsSeen: () => {
      if (!get().shortcutsSeen) update({ shortcutsSeen: true });
    },
    setAdvance: (advance) => update({ advance }),
  };
});

/** Record a tool choice (toolbar click, menu row or hotkey) as its group's last used tool. */
export function rememberTool(envId: string, tool: { name: string; group: string }): void {
  useToolPrefs.getState().remember(envId, tool.group, tool.name);
}

// Another person (or organization) signed in, or the server's values arrived (todo15 D1, todo22 D3).
personPrefs.subscribe(() => useToolPrefs.setState(read()));
