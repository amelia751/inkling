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

/**
 * Home's first send or drop creates a project on the person's behalf (todo13 D1): in the
 * browser, through the person's API, never by the agent. It's named from the goal, or from
 * what the files are ("12 images"), never from a file or folder name: the title reaches the
 * assistant's context, and a name can hold an identifier (D3). Renamable in Settings.
 */
export function projectTitle({ goal, picked }: { goal?: string; picked?: Picked }): string {
  if (goal?.trim()) return titleFromGoal(goal);
  const files = picked?.files ?? [];
  if (!files.length) return "New project";
  const kinds = new Set(files.map((f) => guessKind(f.relPath.split("/").pop() ?? "")));
  const n = files.length;
  if (kinds.size === 1) {
    const [k] = [...kinds];
    const view = KINDS[k];
    if (view && k !== "unknown") return `${n.toLocaleString()} ${(n === 1 ? view.label : view.plural).toLowerCase().replace(/^dicom/, "DICOM").replace(/^3d/, "3D")}`;
  }
  return `${n.toLocaleString()} ${n === 1 ? "file" : "files"}`;
}

export function createProject(title: string, description = ""): Promise<ProjectSummary> {
  return api<ProjectSummary>("/projects", { method: "POST", json: { title, description } });
}
