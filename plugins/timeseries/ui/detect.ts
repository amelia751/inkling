import { detectBeats } from "./dspClient";
import { beat, kindOf, timeOf } from "./model";
import type { Recording } from "./readers";
import { isEditable, newAnnotation, useHost } from "@studio/plugin-ui-sdk";

/**
 * `studio.timeseries.commands.detectBeats`: Pan–Tompkins R peaks on one channel become
 * `ai-suggested` instants on every channel. One undo step replaces the previous unreviewed
 * detector beats; instants within 150 ms of a kept beat are not suggested again.
 * Returns the notice shown over the chart.
 */
export async function detectSuggestions(o: { itemId: string; rec: Recording; lead: string; label: string; code: string; q: (t: number) => number }): Promise<string> {
  const { rec, lead } = o;
  const peaks = await detectBeats(rec.data[lead], rec.fs);
  const s = useHost.getState();
  const beats = s.annotations.filter((a) => a.itemId === o.itemId && kindOf(a) === "beat");
  const stale = beats.filter((a) => a.provenance === "ai-suggested" && a.attributes?.source === "pan-tompkins" && isEditable(a, s.lockedLabels));
  const kept = beats.filter((a) => !stale.includes(a));
  const fresh = peaks
    .map((p) => o.q(p / rec.fs))
    .filter((t) => !kept.some((k) => Math.abs(timeOf(k.geometry)! - t) < 0.15))
    .map((t) => newAnnotation({ itemId: o.itemId, label: o.label, ...beat("all", t, o.code, { source: "pan-tompkins", lead }), provenance: "ai-suggested" }));
  if (stale.length || fresh.length) s.batch({ remove: stale.map((a) => a.id), upsert: fresh });
  const hr = peaks.length > 1 ? (60 * (peaks.length - 1)) / ((peaks[peaks.length - 1] - peaks[0]) / rec.fs) : 0;
  return `${peaks.length} beats on lead ${lead}${hr ? ` · ~${Math.round(hr)} bpm` : ""} · ${fresh.length} suggested${kept.length ? `, ${peaks.length - fresh.length} already marked` : ""}. Tab to review.`;
}
