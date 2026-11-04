import { toolSummaryText } from "@studio/studio-tools/tool-summary";
import type { MessagePart } from "@/studio/stores/agent";

type ToolPart = Extract<MessagePart, { type: "tool" }>;

const PAST: Record<string, string> = {
  Reading: "Read",
  Listing: "Listed",
  Checking: "Checked",
  Preparing: "Prepared",
  Drafting: "Drafted",
  Writing: "Wrote",
  Picking: "Picked",
  Finding: "Found",
  Editing: "Edited",
  Running: "Ran",
  Validating: "Validated",
  Previewing: "Previewed",
  Uploading: "Uploaded",
  Exporting: "Exported",
};
export const pastTense = (title: string) => title.replace(/^(\w+)/, (w) => PAST[w] ?? w);

/** todo29 D6: a done row's label: the tool's own past tense when it sent one ("Looked at your files"). */
export const toolDoneLabel = (part: Pick<ToolPart, "title" | "pastTitle">) => part.pastTitle ?? pastTense(part.title);

/** A summary that is a snapshot of live counts ("0 ready · 35 checking"): stale a second later. */
const LIVE_COUNT = /\d+ (ready|checking)\b/i;
export const looksLikeLiveCount = (summary: string) => summary.includes("·") || LIVE_COUNT.test(summary);

/**
 * todo29 D6: what a row shows after its label. A failed tool keeps its one-line reason; a tool
 * marked `progress` (its summary is a live snapshot) shows nothing, and neither does any summary
 * that reads like one (older agents that don't mark it).
 */
export function toolRowSummary(part: Pick<ToolPart, "status" | "summary" | "progress">): string {
  if (!part.summary) return "";
  const text = toolSummaryText(part.summary);
  if (part.status === "error") return text.split("\n")[0] ?? "";
  if (part.progress || looksLikeLiveCount(text)) return "";
  return text;
}

/**
 * todo29 D6: consecutive tool rows fold into one line: the running row's label while one runs,
 * then "Worked for N s" (from the rows' timing) or "Worked through N steps" (rows replayed
 * from the server carry no timing).
 */
export function toolGroupLabel(parts: Pick<ToolPart, "status" | "title" | "startedAt" | "endedAt">[], live: boolean): string {
  const running = live ? parts.find((p) => p.status === "running") : undefined;
  if (running) return `${running.title}…`;
  const starts = parts.map((p) => p.startedAt);
  const ends = parts.map((p) => p.endedAt);
  if (starts.every((t): t is number => typeof t === "number") && ends.every((t): t is number => typeof t === "number")) {
    const s = Math.max(1, Math.round((Math.max(...ends) - Math.min(...starts)) / 1000));
    return `Worked for ${s} s`;
  }
  return `Worked through ${parts.length} steps`;
}
