import type { DropFindingGroup } from "@studio/contracts/drops";

/**
 * Findings grouped by rule (todo20 D8): a refused import with 35 files breaking one rule says so
 * once, "35 files: …, refused", not 35 times. The API groups a drop's findings itself
 * (`Drop.findings`); this groups a raw list (a 422's `violations`, an import's `findings`).
 */
export interface FindingLike {
  rule?: string;
  severity?: string;
  message?: string;
  fix?: string;
  file?: string;
  renamedTo?: string;
  evaluate?: boolean;
}

const SAMPLE = 5;
const OUTCOME_WORDS: Record<DropFindingGroup["outcome"], string> = { renamed: "renamed automatically", refused: "refused", reported: "reported" };

function outcomeOf(f: FindingLike, refused: boolean): DropFindingGroup["outcome"] {
  if (f.renamedTo) return "renamed";
  if (refused && f.severity === "error" && !f.evaluate) return "refused";
  return "reported";
}

export function groupFindings(list: FindingLike[], opts: { refused?: boolean } = {}): DropFindingGroup[] {
  const by = new Map<string, DropFindingGroup>();
  for (const f of list) {
    const outcome = outcomeOf(f, !!opts.refused);
    const rule = f.rule || f.message || "unknown";
    const key = `${rule}\u0000${outcome}`;
    let g = by.get(key);
    if (!g) {
      g = { rule, severity: f.severity ?? "info", outcome, message: [f.message, f.fix].filter(Boolean).join(" "), count: 0, files: [] };
      by.set(key, g);
    }
    g.count += 1;
    if (f.file && g.files!.length < SAMPLE) g.files!.push(f.file);
    if (f.renamedTo && f.file && (g.renamedTo ??= []).length < SAMPLE) g.renamedTo.push({ from: f.file, to: f.renamedTo });
  }
  return [...by.values()];
}

/** "35 files: the path contains forbidden characters, renamed automatically". */
export function findingLine(g: Pick<DropFindingGroup, "count" | "message" | "rule" | "outcome">): string {
  const what = (g.message || g.rule).replace(/\.\s*$/, "");
  const lead = g.count === 1 ? "1 file" : `${g.count.toLocaleString()} files`;
  return `${lead}: ${what.charAt(0).toLowerCase()}${what.slice(1)}, ${OUTCOME_WORDS[g.outcome] ?? g.outcome}`;
}

/** A renamed group's example, shown once: "a:b.png is now a_b.png". */
export function renamedExample(g: Pick<DropFindingGroup, "renamedTo">): string | undefined {
  const r = g.renamedTo?.[0];
  return r ? `${r.from.split("/").pop()} is now ${r.to.split("/").pop()}` : undefined;
}

/** A rejected write's sentence: each distinct violation once, with its count. */
export function violationsText(violations: FindingLike[]): string {
  const groups = groupFindings(violations);
  return groups.map((g) => (g.count > 1 ? `${g.message} (${g.count} files)` : g.message)).join(" ");
}
