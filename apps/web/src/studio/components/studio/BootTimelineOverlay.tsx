import { useEffect, useState } from "react";
import { bootTimeline, type BootTimeline } from "@/extension-host/boot-timing";
import { featureEnabled } from "@/extension-host/flags";

/** Shown with the `bootTimeline` flag or `?boot-timeline` in the URL (todo11 Milestone 1). */
export const bootTimelineEnabled = (search: string) => featureEnabled("bootTimeline") || new URLSearchParams(search).has("boot-timeline");

const KEY_STEPS = new Set(["route-enter", "env-fetched", "env-resolved", "shell-painted", "items-painted", "first-frame"]);

/**
 * Dev overlay: the current boot's marks, in ms since the Studio route rendered (and since
 * navigation start). Polls for a few seconds, then stops; modules show by id.
 */
export function BootTimelineOverlay() {
  const [t, setT] = useState<BootTimeline>(() => bootTimeline());
  const [open, setOpen] = useState(true);
  useEffect(() => {
    let n = 0;
    const id = setInterval(() => {
      setT(bootTimeline());
      if (++n > 60) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="fixed bottom-10 right-3 z-50 w-80 rounded-md border border-border bg-float p-2 font-mono text-xs shadow-lg" data-testid="boot-timeline">
      <button type="button" className="mb-1 flex w-full items-center justify-between font-sans text-sm font-medium" onClick={() => setOpen((o) => !o)}>
        <span>Boot timeline {t.cold ? "(cold)" : "(warm)"}</span>
        <span className="text-muted-foreground">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <table className="w-full">
          <tbody>
            {t.steps.map((s) => (
              <tr key={s.step} className={KEY_STEPS.has(s.step) ? "" : "text-muted-foreground"}>
                <td className="max-w-48 truncate pr-2" title={s.step}>{s.step.replace(/^module:/, "· ")}</td>
                <td className="tnum text-right">{s.sinceRoute} ms</td>
                <td className="tnum pl-2 text-right text-hint">{s.at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
