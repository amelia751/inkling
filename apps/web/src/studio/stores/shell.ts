import { create } from "zustand";
import { RES } from "@studio/contracts/naming";

/**
 * Shell chrome state shared by every page (todo6 Phase 2): how the project navigation is
 * shown, and the projects opened recently. Both are per-viewer conveniences, so they live
 * in localStorage (guarded: private windows and blocked storage just use the defaults).
 */
const NAV_KEY = `${RES}-nav`;
const RECENT_KEY = `${RES}-recent-projects`;
const RECENT_MAX = 5;

/** `auto`: full sidebar from 1280px, icon rail below; `full` / `rail`: the person's choice. */
export type NavPreference = "auto" | "full" | "rail";

export interface RecentProject {
  id: string;
  title: string;
}

interface ShellState {
  nav: NavPreference;
  /** The Studio shows the rail unless it's hidden (the same toggle command). */
  studioRail: boolean;
  recent: RecentProject[];
  /** The assistant drawer outside the Studio (todo6 Phase 6); its open state is per person. */
  assistantOpen: boolean;
  /** Set when something asked the composer to take focus ("Or tell Inkling…"). */
  assistantFocus: number;
  setAssistant: (open: boolean, focus?: boolean) => void;
  /** The `toggleAssistant` command outside the Studio; Phase 6's drawer reads `assistantOpen`. */
  toggleAssistant: () => void;
  /** Create project as a dialog, from anywhere (todo6 §3.2). */
  newProjectOpen: boolean;
  setNewProject: (open: boolean) => void;
  setNav: (nav: NavPreference) => void;
  toggleStudioRail: () => void;
  visited: (p: RecentProject) => void;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked: keep the in-memory value */
  }
}

export const useShell = create<ShellState>((set, get) => ({
  nav: read<NavPreference>(NAV_KEY, "auto"),
  studioRail: read<boolean>(`${NAV_KEY}-studio`, true),
  recent: read<RecentProject[]>(RECENT_KEY, []),
  assistantOpen: read<boolean>(`${RES}-assistant-open`, false),
  assistantFocus: 0,
  setAssistant: (open, focus = false) => {
    write(`${RES}-assistant-open`, open);
    set((s) => ({ assistantOpen: open, assistantFocus: focus ? s.assistantFocus + 1 : s.assistantFocus }));
  },
  toggleAssistant: () => get().setAssistant(!get().assistantOpen, !get().assistantOpen),
  newProjectOpen: false,
  setNewProject: (newProjectOpen) => set({ newProjectOpen }),
  setNav: (nav) => {
    write(NAV_KEY, nav);
    set({ nav });
  },
  toggleStudioRail: () => {
    const studioRail = !get().studioRail;
    write(`${NAV_KEY}-studio`, studioRail);
    set({ studioRail });
  },
  visited: (p) => {
    const cur = get().recent;
    if (cur[0]?.id === p.id && cur[0].title === p.title) return;
    const recent = [p, ...cur.filter((r) => r.id !== p.id)].slice(0, RECENT_MAX);
    write(RECENT_KEY, recent);
    set({ recent });
  },
}));
