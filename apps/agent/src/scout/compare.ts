import { OssEvaluation } from "@studio/contracts/oss-evaluation";

/**
 * `compare_oss` (todo23 W3): one table across candidates (fit, licence, health, size, smoke) for
 * the person or the builder to choose from. Pure: it only reads evaluation records.
 */

export interface CompareRow {
  package: string;
  ecosystem: string;
  version: string;
  decision: string;
  licence: string;
  scorecard?: number;
  advisories: number;
  lastRelease?: string;
  maintainers?: number;
  smoke?: string;
  sizeMb?: number;
  conditions: number;
}

const ORDER: Record<string, number> = { picked: 0, amber: 1, refused: 2 };

export function compareOss(input: { need?: string; evaluations: unknown[] }): { need?: string; rows: CompareRow[]; table: string; recommended?: string } {
  const evals = input.evaluations.map((e) => OssEvaluation.parse(e));
  const rows: CompareRow[] = evals
    .map((e) => ({
      package: e.package,
      ecosystem: e.ecosystem,
      version: e.version,
      decision: e.decision,
      licence: e.licence,
      scorecard: e.scorecard,
      advisories: e.advisories.length,
      lastRelease: e.lastRelease?.slice(0, 10),
      maintainers: e.maintainers,
      smoke: e.trial?.status,
      sizeMb: e.trial?.sizeBytes !== undefined ? Math.round(e.trial.sizeBytes / 1e5) / 10 : undefined,
      conditions: e.conditions.length,
    }))
    .sort((a, b) => (ORDER[a.decision]! - ORDER[b.decision]!) || ((a.smoke === "pass" ? 0 : 1) - (b.smoke === "pass" ? 0 : 1)) || ((b.scorecard ?? -1) - (a.scorecard ?? -1)));
  const cell = (v: unknown) => (v === undefined || v === null ? "–" : String(v).replace(/\|/g, "\\|"));
  const head = ["package", "version", "decision", "licence", "scorecard", "advisories", "last release", "maintainers", "smoke", "size MB", "conditions"];
  const table = [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${[`${r.package} (${r.ecosystem})`, r.version, r.decision, r.licence, r.scorecard?.toFixed(1), r.advisories, r.lastRelease, r.maintainers, r.smoke, r.sizeMb, r.conditions].map(cell).join(" | ")} |`),
  ].join("\n");
  const best = rows.find((r) => r.decision !== "refused");
  return { need: input.need, rows, table, recommended: best ? `${best.package}@${best.version}` : undefined };
}
