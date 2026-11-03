import { create } from "zustand";
import { RES } from "@studio/contracts/naming";
import { personKey } from "@/studio/lib/person-key";
import { personPrefs, type PrefOptions } from "@/studio/lib/person-prefs";

/**
 * Shell chrome state shared by every page (todo6 Phase 2): how the project navigation is
 * shown, and the projects opened recently. Per person on the server (todo22 D3, `shell.*` prefs),
 * with the old localStorage keys as the first-paint cache.
 */
type Pref = { key: string; opts: PrefOptions };
const pref = (key: string, base: string): Pref => ({ key, opts: { cache: () => personKey(`${RES}-${base}`) } });
const NAV_KEY = pref("shell.nav", "nav");
const NAV_STUDIO_KEY = pref("shell.nav-studio", "nav-studio");
/** Per person (todo14 M0): a dev "new person" starts with no recents. */
const RECENT_KEY = pref("shell.recent-projects", "recent-projects");
const OPEN_KEY = pref("shell.assistant-open", "assistant-open");
const WIDTH_KEY = pref("shell.assistant-width", "assistant-width");
const LEFT_KEY = pref("shell.studio-left", "studio-left");
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
  /** Set when something asked the composer to take focus ("Or tell <displayName>…"). */
  assistantFocus: number;
  /** The drawer's width in px (300–480, default 340), per person like its open state. */
  assistantWidth: number;
  setAssistant: (open: boolean, focus?: boolean) => void;
  /** The `toggleAssistant` command outside the Studio; Phase 6's drawer reads `assistantOpen`. */
  toggleAssistant: () => void;
  /** Create project as a dialog, from anywhere (todo6 §3.2). */
  setAssistantWidth: (px: number) => void;
  setNav: (nav: NavPreference) => void;
  toggleStudioRail: () => void;
  visited: (p: RecentProject) => void;
  /** The Studio's left slot (Items, Labels); hidden with the rail, the canvas takes the width (todo6 Phase 7). */
  studioLeft: boolean;
  toggleStudioLeft: () => void;
}

export const ASSISTANT_WIDTH = { min: 300, max: 480, default: 340 } as const;
export const clampAssistantWidth = (px: number) => (Number.isFinite(px) ? Math.round(Math.min(ASSISTANT_WIDTH.max, Math.max(ASSISTANT_WIDTH.min, px))) : ASSISTANT_WIDTH.default);

const read = <T>(p: Pref, fallback: T): T => personPrefs.get<T>(p.key, fallback, p.opts);
const write = (p: Pref, value: unknown) => personPrefs.set(p.key, value, p.opts);

/** What the shell reads from storage, for the current person. */
const stored = () => ({
  nav: read<NavPreference>(NAV_KEY, "auto"),
  studioRail: read<boolean>(NAV_STUDIO_KEY, true),
  recent: read<RecentProject[]>(RECENT_KEY, []),
  assistantOpen: read<boolean>(OPEN_KEY, false),
  assistantWidth: clampAssistantWidth(read<number>(WIDTH_KEY, ASSISTANT_WIDTH.default)),
  studioLeft: read<boolean>(LEFT_KEY, true),
});

export const useShell = create<ShellState>((set, get) => ({
  nav: read<NavPreference>(NAV_KEY, "auto"),
  studioRail: read<boolean>(NAV_STUDIO_KEY, true),
  recent: read<RecentProject[]>(RECENT_KEY, []),
  assistantOpen: read<boolean>(OPEN_KEY, false),
  assistantFocus: 0,
  assistantWidth: clampAssistantWidth(read<number>(WIDTH_KEY, ASSISTANT_WIDTH.default)),
  setAssistantWidth: (px) => {
    const assistantWidth = clampAssistantWidth(px);
    write(WIDTH_KEY, assistantWidth);
    set({ assistantWidth });
  },
  setAssistant: (open, focus = false) => {
    write(OPEN_KEY, open);
    set((s) => ({ assistantOpen: open, assistantFocus: focus ? s.assistantFocus + 1 : s.assistantFocus }));
  },
  toggleAssistant: () => get().setAssistant(!get().assistantOpen, !get().assistantOpen),
  setNav: (nav) => {
    write(NAV_KEY, nav);
    set({ nav });
  },
  toggleStudioRail: () => {
    const studioRail = !get().studioRail;
    write(NAV_STUDIO_KEY, studioRail);
    set({ studioRail });
  },
  visited: (p) => {
    const cur = get().recent;
    if (cur[0]?.id === p.id && cur[0].title === p.title) return;
    const recent = [p, ...cur.filter((r) => r.id !== p.id)].slice(0, RECENT_MAX);
    write(RECENT_KEY, recent);
    set({ recent });
  },
  studioLeft: read<boolean>(LEFT_KEY, true),
  toggleStudioLeft: () => {
    const studioLeft = !get().studioLeft;
    write(LEFT_KEY, studioLeft);
    set({ studioLeft });
  },
}));

// Another person (or organization) signed in, or the server's values arrived (todo15 D1, todo22 D3).
personPrefs.subscribe(() => useShell.setState(stored()));
