import { useEffect, useState, useSyncExternalStore } from "react";
import { useLocation } from "react-router";
import { RES } from "@studio/contracts/naming";
import { dropTimeline, onServerEvent, SERVER_EVENTS, subscribeTimeline } from "@/studio/lib/drop-timeline";
import { onProjectEvent } from "@/studio/lib/use-project-events";

const KEY = `${RES}-timeline-overlay`;
const HEADLINE = new Set(["gesture", "project-created", "first-file-uploaded", "server:source.node.inspected", "studio:route-enter", "first-interactive"]);

/** `?timeline=1` turns the overlay on for this tab (it survives navigation); `?timeline=0` off. */
function useTimelineOverlayEnabled(): boolean {
  const { search } = useLocation();
  const [on, setOn] = useState(() => {
    try {
      return sessionStorage.getItem(KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const v = new URLSearchParams(search).get("timeline");
    if (v === null) return;
    const next = v !== "0" && v !== "false";
    setOn(next);
    try {
      sessionStorage.setItem(KEY, next ? "1" : "0");
    } catch {
      /* storage blocked: this page only */
    }
  }, [search]);
  return on;
}

/** Server-side steps from the project stream (no-ops without a live timeline). */
export function useTimelineServerEvents(): void {
  useEffect(() => {
    const offs = SERVER_EVENTS.map((type) => onProjectEvent(type, (data) => onServerEvent(type, data)));
    return () => offs.forEach((off) => off());
  }, []);
}

let snapshot = dropTimeline();
const subscribe = (fn: () => void) =>
  subscribeTimeline(() => {
    snapshot = dropTimeline();
    fn();
  });

/**
 * The drop timeline overlay (todo13 Milestone 4 item 1): ms from the gesture to each step, the
 * headline steps in full colour. Mounted by the shell on every page; shown with `?timeline=1`.
 */
export function TimelineOverlay() {
  const enabled = useTimelineOverlayEnabled();
  useTimelineServerEvents();
  const t = useSyncExternalStore(subscribe, () => snapshot);
  const [open, setOpen] = useState(true);
  if (!enabled) return null;
  return (
    <div className="fixed bottom-3 left-3 z-50 w-72 rounded-md border border-border bg-float p-2 font-mono text-xs shadow-lg" data-testid="drop-timeline">
      <button type="button" className="mb-1 flex w-full items-center justify-between font-sans text-sm font-medium" onClick={() => setOpen((o) => !o)}>
        <span>Drop timeline{t.origin ? ` · ${t.origin}` : ""}</span>
        <span className="text-muted-foreground">{open ? "Hide" : "Show"}</span>
      </button>
      {open &&
        (t.steps.length === 0 ? (
          <p className="font-sans text-muted-foreground">Drop files or send a message to start one.</p>
        ) : (
          <table className="w-full">
            <tbody>
              {t.steps.map((s) => (
                <tr key={s.step} className={HEADLINE.has(s.step) ? "" : "text-muted-foreground"} data-step={s.step}>
                  <td className="max-w-48 truncate pr-2" title={s.step}>{s.step}</td>
                  <td className="tnum text-right">{s.ms.toLocaleString()} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      {open && t.steps.length > 0 && (
        <p className="mt-1 font-sans text-caption text-hint">
          {t.dropId ? `Drop ${t.dropId}` : "No drop id yet"} · {t.reported ? "reported" : t.active ? "running" : "ended"}
        </p>
      )}
    </div>
  );
}
