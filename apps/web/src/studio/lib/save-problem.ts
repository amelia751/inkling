/**
 * todo18 D2 / §2 C: why the last annotation save failed, and what the save chip says about it.
 * The autosave records the decoded problem; `saveChip` turns it into the chip's words, so the
 * Studio never shows a generic "Not saved · Retry" when it knows better.
 */
import { create } from "zustand";
import type { ApiProblem } from "./problem";

export const useSaveProblem = create<{ problem: ApiProblem | null; attempt: number; set: (p: ApiProblem | null) => void }>((set) => ({
  problem: null,
  attempt: 0,
  set: (problem) => set((s) => ({ problem, attempt: problem ? s.attempt + 1 : 0 })),
}));

export type SaveChip =
  | { state: "offline"; text: string }
  | { state: "invalid-label"; text: string; label: string }
  | { state: "invalid"; text: string }
  | { state: "conflict"; text: string }
  | { state: "session"; text: string }
  | { state: "forbidden"; text: string }
  | { state: "gone"; text: string }
  | { state: "error"; text: string };

/** The label name a 422 violation is about (`label 'x' isn't in this Studio's label set`). */
export function labelOf(p: ApiProblem): string | null {
  for (const v of p.violations) {
    if (v.code !== "label" && !v.path?.endsWith("/label")) continue;
    const m = v.message.match(/label ['"‘’]?([^'"‘’]+)['"‘’]?/i);
    if (m) return m[1];
  }
  return null;
}

export function saveChip(p: ApiProblem | null): SaveChip {
  if (!p) return { state: "error", text: "Not saved" };
  switch (p.kind) {
    case "offline":
    case "server":
    case "rate-limited":
      return { state: "offline", text: p.kind === "offline" ? "Offline, changes kept" : "Can't reach the server, changes kept" };
    case "invalid": {
      const label = labelOf(p);
      return label ? { state: "invalid-label", text: `Not saved: "${label}" isn't a label here`, label } : { state: "invalid", text: `Not saved: ${p.violations[0]?.message ?? p.detail ?? "invalid annotations"}` };
    }
    case "conflict":
      return { state: "conflict", text: "Someone else saved; merging" };
    case "session":
      return { state: "session", text: "Signed out, changes kept" };
    case "forbidden":
      return { state: "forbidden", text: "You can view this Studio but not save annotations" };
    case "gone":
      return { state: "gone", text: "This Studio was moved to Trash" };
    default:
      return { state: "error", text: "Not saved" };
  }
}

/** Back-off before the next automatic retry: 2 s, 4 s, 8 s … capped at 60 s, or the server's Retry-After. */
export function retryDelayMs(p: ApiProblem, attempt: number): number {
  if (p.retryAfter) return p.retryAfter * 1000;
  return Math.min(60_000, 1000 * 2 ** Math.max(1, attempt));
}
