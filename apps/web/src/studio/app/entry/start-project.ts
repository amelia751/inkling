import type { ProjectSummary } from "@studio/contracts/types";
import { api } from "@/studio/lib/projects-api";
import { guessKind } from "@/studio/lib/file-kinds";
import { KINDS } from "@/studio/lib/file-kinds";
import type { Picked } from "@/studio/lib/uploads/walk";

/** A title from a goal sentence: "Help me classify chest X-rays." → "Classify chest X-rays". */
export function titleFromGoal(goal: string): string {
  const s = goal
    .trim()
    .replace(/^(please\s+)?(help me( to)?|i want to|i'd like to|i would like to|we want to|let's|lets)\s+/i, "")
    .replace(/[.!?]+$/, "")
    .split(/\n/)[0];
  const t = s.length > 60 ? `${s.slice(0, 57).replace(/\s+\S*$/, "")}…` : s;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** "Chest X-rays" when the file names say so (cxr, chest, x-ray). */
const XRAY = /(^|[^a-z])(cxr|chest|x-?rays?|xray)([^a-z]|$)/i;

const plural = (k: string) => KINDS[k as keyof typeof KINDS]?.plural ?? "Files";
const lower = (s: string) => (/^(DICOM|3D)/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));

/**
 * todo21 D2: the suggested name in the new-project dialog (the person confirms or edits it, so a
 * name is never applied silently). A drop is named from its folder ("knee-mri"), else from what
 * its files are ("Chest X-rays", "Images and videos"); a send from a short name made from the
 * message. Never "35 files".
 */
export function projectTitle({ goal, picked }: { goal?: string; picked?: Picked }): string {
  const files = picked?.files ?? [];
  if (files.length) {
    const tops = new Set(files.map((f) => (f.relPath.includes("/") ? f.relPath.split("/")[0] : "")));
    const [top] = [...tops];
    if (tops.size === 1 && top) return top;
    if (files.some((f) => XRAY.test(f.relPath))) return "Chest X-rays";
    const counts = new Map<string, number>();
    for (const f of files) {
      const k = guessKind(f.relPath.split("/").pop() ?? "");
      if (k !== "unknown") counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const main = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    if (main.length === 1) return plural(main[0]);
    if (main.length >= 2) return `${plural(main[0])} and ${lower(plural(main[1]))}`;
  }
  if (goal?.trim()) return titleFromGoal(goal);
  return "New project";
}

export function createProject(title: string, description = ""): Promise<ProjectSummary> {
  return api<ProjectSummary>("/projects", { method: "POST", json: { title, description } });
}
