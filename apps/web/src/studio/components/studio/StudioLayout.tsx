import { useEffect, useReducer, useRef, type ReactNode } from "react";
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelProps } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { personPrefs } from "@/studio/lib/person-prefs";

/**
 * Desktop Studio layout on dockview, so the arrangement is a serialisable document an
 * agent can write (`env.layout` = dockview `toJSON()`). Dockview panels are the slots —
 * `viewer`, `slot:left`, `slot:right`, `slot:bottom` — each rendering its own tabbed slot
 * content, which keeps panel semantics (tabs, testids) identical to the old fixed layout.
 *
 * `layout: null` (the default) lays slots out automatically; a stored layout is filtered to
 * the slots this environment has before `fromJSON` (dockview throws on unknown panels) and
 * falls back to the automatic layout if it still doesn't load. The user's own drags are
 * remembered per person on the server (todo22 D3: pref `prefKey`, `layout:<project>:<task>:<viewport>`),
 * with `storageKey` in localStorage as the first-paint cache; another device's layout arriving
 * from the server is applied when it loads.
 */
export type SlotId = "viewer" | "slot:left" | "slot:right" | "slot:bottom";

export interface StudioLayoutProps {
  /** Content per slot; a slot is present only when its node is non-null. */
  slots: Partial<Record<SlotId, ReactNode>>;
  /** dockview toJSON() from the environment, or null for automatic. */
  layout: unknown;
  /** The localStorage cache key (per person). */
  storageKey: string;
  /** The server preference key (D8: `^[a-z][a-z0-9:._-]{0,127}$`). */
  prefKey: string;
}

const TITLES: Record<SlotId, string> = { viewer: "Viewer", "slot:left": "Items and labels", "slot:right": "Panels", "slot:bottom": "Bottom" };

// Rendered content per slot, read by the dockview components (which dockview mounts itself).
const content = new Map<SlotId, ReactNode>();
const listeners = new Set<() => void>();
function SlotPanel({ params }: IDockviewPanelProps<{ slot: SlotId }>) {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    listeners.add(force);
    return () => void listeners.delete(force);
  }, [force]);
  return <div className="flex h-full min-h-0 flex-col">{content.get(params.slot)}</div>;
}

const components = { slot: SlotPanel };

type LayoutJson = { grid?: unknown; panels?: Record<string, unknown>; activeGroup?: string };

/** Keep only panels this environment has, so `fromJSON` can't throw on unknown ids. */
export function filterLayout(json: unknown, present: SlotId[]): LayoutJson | null {
  if (!json || typeof json !== "object") return null;
  const j = structuredClone(json) as LayoutJson;
  if (!j.panels || !j.grid) return null;
  const keep = new Set<string>(present);
  for (const id of Object.keys(j.panels)) if (!keep.has(id)) delete j.panels[id];
  const prune = (node: unknown): unknown => {
    if (!node || typeof node !== "object") return node;
    const n = node as { type?: string; data?: unknown };
    if (n.type === "leaf") {
      const d = n.data as { views?: string[]; activeView?: string };
      d.views = (d.views ?? []).filter((v) => keep.has(v));
      if (!d.views.length) return null;
      if (d.activeView && !keep.has(d.activeView)) d.activeView = d.views[0];
      return n;
    }
    if (n.type === "branch" && Array.isArray(n.data)) {
      n.data = n.data.map(prune).filter(Boolean);
      return (n.data as unknown[]).length ? n : null;
    }
    return n;
  };
  const root = (j.grid as { root?: unknown }).root;
  (j.grid as { root?: unknown }).root = prune(root);
  if (!(j.grid as { root?: unknown }).root) return null;
  // Every present slot must appear, or the auto layout is the better choice.
  return present.every((id) => j.panels![id]) ? j : null;
}

function autoLayout(api: DockviewApi, present: SlotId[]) {
  api.clear();
  api.addPanel({ id: "viewer", component: "slot", title: TITLES.viewer, params: { slot: "viewer" } });
  if (present.includes("slot:left"))
    api.addPanel({ id: "slot:left", component: "slot", title: TITLES["slot:left"], params: { slot: "slot:left" }, position: { referencePanel: "viewer", direction: "left" }, initialWidth: 280, minimumWidth: 240, maximumWidth: 420 });
  if (present.includes("slot:right"))
    api.addPanel({ id: "slot:right", component: "slot", title: TITLES["slot:right"], params: { slot: "slot:right" }, position: { referencePanel: "viewer", direction: "right" }, initialWidth: 340, minimumWidth: 300, maximumWidth: 480 });
  if (present.includes("slot:bottom"))
    api.addPanel({ id: "slot:bottom", component: "slot", title: TITLES["slot:bottom"], params: { slot: "slot:bottom" }, position: { referencePanel: "viewer", direction: "below" }, initialHeight: 220 });
}

/** Slots are whole regions, so their tab strips are hidden; resizing still works on the sashes. */
function hideHeaders(api: DockviewApi) {
  for (const g of api.groups) g.header.hidden = true;
}

export function StudioLayout({ slots, layout, storageKey, prefKey }: StudioLayoutProps) {
  const api = useRef<DockviewApi | null>(null);
  /** The layout value this component last read or wrote, so only someone else's change re-applies. */
  const known = useRef<unknown>(undefined);
  const opts = { cache: storageKey };
  const present = (Object.keys(slots) as SlotId[]).filter((k) => slots[k] != null);
  const key = present.sort().join("|");

  for (const id of present) content.set(id, slots[id]);
  useEffect(() => listeners.forEach((l) => l()));

  const apply = (a: DockviewApi) => {
    const saved = personPrefs.get<unknown>(prefKey, null, opts);
    known.current = saved;
    for (const candidate of [filterLayout(layout, present), filterLayout(saved, present)]) {
      if (!candidate) continue;
      try {
        a.fromJSON(candidate as never);
        hideHeaders(a);
        return;
      } catch {
        /* fall through to the next candidate */
      }
    }
    autoLayout(a, present);
    hideHeaders(a);
  };

  const onReady = (e: DockviewReadyEvent) => {
    api.current = e.api;
    apply(e.api);
    e.api.onDidLayoutChange(() => {
      const next = e.api.toJSON();
      known.current = next;
      personPrefs.set(prefKey, next, opts);
    });
  };

  // The server's layout (another device's drags) arriving after the first paint.
  useEffect(
    () =>
      personPrefs.subscribe(() => {
        const a = api.current;
        if (!a || personPrefs.get<unknown>(prefKey, null, opts) === known.current) return;
        apply(a);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prefKey, storageKey],
  );

  // Slots appearing or disappearing (the assistant toggled, an agent edit) re-lays out.
  useEffect(() => {
    if (api.current) apply(api.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, JSON.stringify(layout ?? null)]);

  return <DockviewReact className="studio-dockview min-h-0 flex-1" components={components} onReady={onReady} disableDnd />;
}
