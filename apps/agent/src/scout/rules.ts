import type { OssEcosystem } from "@studio/contracts/oss-evaluation";

/**
 * todo23 §2.3: the red list (refused automatically) and the amber list (allowed with a recorded
 * condition). Licence classes are matched on SPDX ids; named packages on their registry name,
 * whether the package is the candidate itself or anywhere in its dependency graph.
 */

/** SPDX ids (or registry free text) that refuse a package: copyleft, source-available, commercial. */
const RED_LICENCE = [
  /^A?GPL-/i,
  /^GPL$/i,
  /\bAGPL\b/i,
  /\bGPL(v?\d)?\b(?!.*(exception|linking))/i,
  /^SSPL/i,
  /^BUSL/i,
  /Commons[- ]Clause/i,
  /^Elastic-/i,
  /^CC-BY-NC/i,
  /^EUPL-/i,
  /^OSL-/i,
  /^RPL-/i,
  /proprietary|commercial|UNLICENSED|SEE LICEN[CS]E IN/i,
];
/** Weak copyleft: allowed if the library stays a separate, replaceable dependency. */
const AMBER_LICENCE = [/^LGPL-/i, /^MPL-/i, /^EPL-/i, /^CDDL-/i];

export interface NamedRule {
  ecosystem?: OssEcosystem;
  /** Exact name, or a prefix ending in `*` (`@ag-grid-enterprise/*`, `highcharts*`). */
  name: string;
  /** Only versions below this major are hit (OpenBB ≤ V4 is AGPL). */
  belowMajor?: number;
  /** Only versions at or above this major are hit (Riskfolio-Lib 7.x pulls in vectorbt). */
  fromMajor?: number;
  reason: string;
}

export const RED_PACKAGES: NamedRule[] = [
  { ecosystem: "npm", name: "handsontable", reason: "Handsontable is commercial (red list)" },
  { ecosystem: "npm", name: "@handsontable/*", reason: "Handsontable is commercial (red list)" },
  { name: "hyperformula", reason: "HyperFormula is GPLv3 or commercial (red list)" },
  { ecosystem: "npm", name: "highcharts*", reason: "Highcharts (including Stock) is commercial (red list)" },
  { ecosystem: "npm", name: "@highcharts/*", reason: "Highcharts (including Stock) is commercial (red list)" },
  { ecosystem: "npm", name: "ag-grid-enterprise", reason: "AG Grid Enterprise features are commercial (red list)" },
  { ecosystem: "npm", name: "@ag-grid-enterprise/*", reason: "AG Grid Enterprise features are commercial (red list)" },
  { ecosystem: "pypi", name: "vectorbt", reason: "vectorbt is under the Commons Clause (red list)" },
  { ecosystem: "pypi", name: "vectorbtpro", reason: "vectorbt PRO is proprietary (red list)" },
  { ecosystem: "pypi", name: "riskfolio-lib", fromMajor: 7, reason: "Riskfolio-Lib 7.x pulls in vectorbt (Commons Clause) transitively (red list)" },
  { ecosystem: "pypi", name: "backtrader", reason: "backtrader is GPL-3.0 and unmaintained (red list)" },
  { name: "metabase", reason: "Metabase is AGPL (red list)" },
  { name: "grafana", reason: "Grafana is AGPL (red list)" },
  { ecosystem: "pypi", name: "openbb", belowMajor: 5, reason: "OpenBB ≤ V4 is AGPL (red list)" },
  { ecosystem: "pypi", name: "yfinance", reason: "Yahoo Finance data via yfinance is for personal use only (red list: data terms)" },
];

export const AMBER_PACKAGES: (NamedRule & { condition: string })[] = [
  { ecosystem: "npm", name: "lightweight-charts", reason: "Lightweight Charts requires visible attribution", condition: "Show the TradingView attribution link on every chart (Apache-2.0 NOTICE plus visible attribution)." },
  { ecosystem: "pypi", name: "finrobot", reason: "FinRobot has a trademark policy", condition: "Follow FinRobot's trademark policy: don't use its name or logo in product branding." },
  { ecosystem: "pypi", name: "edgartools", reason: "SEC fair-access rules apply", condition: "SEC fair access: at most 10 requests per second in total, with a declared User-Agent." },
  { ecosystem: "pypi", name: "quantstats", reason: "QuantStats' Yahoo fetchers carry personal-use data terms", condition: "Don't use QuantStats' Yahoo Finance fetchers; pass it your own returns." },
];

const normalise = (eco: OssEcosystem, name: string) => (eco === "pypi" ? name.toLowerCase().replace(/[-_.]+/g, "-") : name.toLowerCase());
const major = (v?: string) => {
  const m = /^v?(\d+)/.exec(v ?? "");
  return m ? Number(m[1]) : undefined;
};

export function matchNamed<R extends NamedRule>(rules: R[], eco: OssEcosystem, name: string, version?: string): R | undefined {
  const n = normalise(eco, name);
  return rules.find((r) => {
    if (r.ecosystem && r.ecosystem !== eco) return false;
    const rn = normalise(eco, r.name);
    const hit = rn.endsWith("*") ? n.startsWith(rn.slice(0, -1)) : n === rn;
    if (!hit) return false;
    const mj = major(version);
    if (r.belowMajor !== undefined && (mj === undefined || mj >= r.belowMajor)) return false;
    if (r.fromMajor !== undefined && (mj === undefined || mj < r.fromMajor)) return false;
    return true;
  });
}

export type LicenceClass = "ok" | "amber" | "red" | "unknown";

/**
 * Classifies an SPDX expression. `A OR B` passes if any alternative passes (we may choose it);
 * `A AND B` takes the worst. Free text (PyPI's `License` field) is matched by the same patterns.
 */
export function classifyLicence(expr: string | undefined): LicenceClass {
  const s = (expr ?? "").trim().replace(/^\((.*)\)$/, "$1");
  if (!s || /^(unknown|none|non-standard|UNKNOWN)$/i.test(s)) return "unknown";
  // SPDX operators are upper case; free text ("v3 or later") must not split.
  const alternatives = s.split(/\s+OR\s+/);
  const rank: Record<LicenceClass, number> = { ok: 0, amber: 1, unknown: 2, red: 3 };
  const one = (part: string): LicenceClass => {
    const terms = part
      .replace(/[()]/g, " ")
      .split(/\s+AND\s+|\s+WITH\s+/)
      .map((t) => t.trim())
      .filter(Boolean);
    let worst: LicenceClass = "ok";
    for (const t of terms) {
      if (/exception$/i.test(t)) continue;
      const c: LicenceClass = RED_LICENCE.some((r) => r.test(t)) ? "red" : AMBER_LICENCE.some((r) => r.test(t)) ? "amber" : "ok";
      if (rank[c] > rank[worst]) worst = c;
    }
    return worst;
  };
  return alternatives.map(one).reduce((best, c) => (rank[c] < rank[best] ? c : best), "red" as LicenceClass);
}
