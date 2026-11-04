import { type OssAdvisory, type OssDependencyLicence, type OssEcosystem, OssEvaluation } from "@studio/contracts/oss-evaluation";
import { type Fetcher, getJson, pool } from "./http.ts";
import { AMBER_PACKAGES, RED_PACKAGES, classifyLicence, matchNamed } from "./rules.ts";

/**
 * `vet_oss` (todo23 D6, W3): the static gate. Runs in the agent service from metadata APIs only,
 * never in a sandbox and never on a README: deps.dev (licence, the resolved dependency graph and
 * each dependency's licence), OSV (advisories on this exact version), OpenSSF Scorecard (repo
 * health) and the registry (release dates, maintainers). The red list refuses; amber records
 * conditions. The result is an `oss-evaluation.v1`.
 */

export const DEPS_DEV = "https://api.deps.dev/v3";
export const OSV = "https://api.osv.dev/v1/query";
export const SCORECARD = "https://api.securityscorecards.dev/projects";
export const NPM_REGISTRY = "https://registry.npmjs.org";
export const PYPI = "https://pypi.org/pypi";

const SYSTEM: Record<OssEcosystem, string> = { npm: "NPM", pypi: "PYPI" };
const OSV_ECOSYSTEM: Record<OssEcosystem, string> = { npm: "npm", pypi: "PyPI" };
const MAX_GRAPH_NODES = 120;
const STALE_DAYS = 730;
const LOW_SCORECARD = 3;

export interface VetInput {
  package: string;
  ecosystem: OssEcosystem;
  /** Exact version; the latest release when omitted. */
  version?: string;
}

export interface VetDeps {
  fetch: Fetcher;
  now?: () => Date;
}

export const normaliseName = (eco: OssEcosystem, name: string) => (eco === "pypi" ? name.trim().toLowerCase().replace(/[-_.]+/g, "-") : name.trim());
export const npmPath = (name: string) => name.replace("/", "%2F");

interface DepsDevVersion {
  publishedAt?: string;
  licenses?: string[];
  advisoryKeys?: { id: string }[];
  links?: { label: string; url: string }[];
  relatedProjects?: { projectKey: { id: string }; relationType: string }[];
}
interface DepsDevGraph {
  nodes?: { versionKey: { name: string; version: string }; relation: string }[];
  error?: string;
}
interface Registry {
  latest?: string;
  versions: string[];
  /** Date of the newest release of any version. */
  lastRelease?: string;
  maintainers?: number;
  licence?: string;
  repository?: string;
}

export async function readRegistry(fetcher: Fetcher, eco: OssEcosystem, name: string, version?: string): Promise<{ url: string; data?: Registry }> {
  if (eco === "npm") {
    const url = `${NPM_REGISTRY}/${npmPath(name)}`;
    const d = await getJson<any>(fetcher, url);
    if (!d) return { url };
    const latest: string | undefined = d["dist-tags"]?.latest;
    const v = d.versions?.[version ?? latest ?? ""] ?? {};
    const times = Object.entries((d.time ?? {}) as Record<string, string>).filter(([k]) => k !== "created" && k !== "modified");
    const lastRelease = times.map(([, t]) => t).sort().at(-1);
    const lic = typeof v.license === "string" ? v.license : (v.license?.type ?? (typeof d.license === "string" ? d.license : undefined));
    const repo = typeof d.repository === "string" ? d.repository : d.repository?.url;
    return { url, data: { latest, versions: Object.keys(d.versions ?? {}), lastRelease, maintainers: Array.isArray(d.maintainers) ? d.maintainers.length : undefined, licence: lic, repository: repoUrl(repo) } };
  }
  const url = `${PYPI}/${encodeURIComponent(name)}/json`;
  const d = await getJson<any>(fetcher, url);
  if (!d) return { url };
  const info = d.info ?? {};
  const releases = (d.releases ?? {}) as Record<string, { upload_time_iso_8601?: string; yanked?: boolean }[]>;
  const lastRelease = Object.values(releases)
    .flat()
    .map((f) => f.upload_time_iso_8601)
    .filter((t): t is string => !!t)
    .sort()
    .at(-1);
  const classifier = ((info.classifiers ?? []) as string[]).filter((c) => c.startsWith("License ::")).map((c) => c.split("::").at(-1)!.trim());
  const rawLicence: string | undefined = info.license_expression || (classifier.length ? classifier.join(" AND ") : undefined) || (typeof info.license === "string" && info.license.length < 100 ? info.license : undefined);
  const urls = Object.values((info.project_urls ?? {}) as Record<string, string>);
  const repo = urls.find((u) => /github\.com|gitlab\.com/.test(u)) ?? info.home_page;
  // PyPI's JSON API names an author and a maintainer, not the owner list; count what it names.
  const people = new Set([info.author, info.maintainer, info.author_email, info.maintainer_email].filter((x: unknown) => typeof x === "string" && x.trim()).map((x: string) => x.split(/[<,]/)[0]!.trim().toLowerCase()));
  return { url, data: { latest: info.version, versions: Object.keys(releases), lastRelease, maintainers: people.size || undefined, licence: rawLicence, repository: repoUrl(repo) } };
}

function repoUrl(u: unknown): string | undefined {
  if (typeof u !== "string") return undefined;
  const m = /(github\.com|gitlab\.com)[/:]([\w.-]+)\/([\w.-]+?)(\.git)?(\/|#|$)/.exec(u);
  return m ? `https://${m[1]}/${m[2]}/${m[3]}` : undefined;
}

export async function vetOss(input: VetInput, deps: VetDeps): Promise<OssEvaluation> {
  const f = deps.fetch;
  const eco = input.ecosystem;
  const name = normaliseName(eco, input.package);
  const reasons: string[] = [];
  const conditions: string[] = [];
  const evidence: string[] = [];
  let red = false;
  const refuse = (why: string) => {
    red = true;
    reasons.push(why);
  };
  const soft = async <T>(what: string, p: Promise<T>): Promise<T | undefined> => {
    try {
      return await p;
    } catch (err) {
      reasons.push(`${what} unavailable: ${String((err as Error).message ?? err).slice(0, 160)}`);
      return undefined;
    }
  };

  const reg = await soft("registry", readRegistry(f, eco, name, input.version));
  if (reg) evidence.push(reg.url);
  const version = input.version ?? reg?.data?.latest;
  const base = { schema: "oss-evaluation.v1" as const, package: name, ecosystem: eco, evaluatedAt: (deps.now?.() ?? new Date()).toISOString() };
  if (!reg?.data || !version) {
    return OssEvaluation.parse({ ...base, version: version ?? "unknown", licence: "unknown", transitiveLicences: [], advisories: [], decision: "refused", conditions: [], reasons: [...reasons, `${name} isn't published on ${eco}`], evidence });
  }
  if (reg.data.versions.length && !reg.data.versions.includes(version)) refuse(`${name}@${version} isn't a published version`);

  const selfRed = matchNamed(RED_PACKAGES, eco, name, version);
  if (selfRed) refuse(selfRed.reason);
  const selfAmber = matchNamed(AMBER_PACKAGES, eco, name, version);
  if (selfAmber) conditions.push(selfAmber.condition);

  const verUrl = `${DEPS_DEV}/systems/${SYSTEM[eco]}/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
  const graphUrl = `${verUrl}:dependencies`;
  const [dd, graph, osv] = await Promise.all([
    soft("deps.dev", getJson<DepsDevVersion>(f, verUrl)),
    soft("deps.dev dependency graph", getJson<DepsDevGraph>(f, graphUrl)),
    soft("OSV", getJson<{ vulns?: any[] }>(f, OSV, { body: { version, package: { name, ecosystem: OSV_ECOSYSTEM[eco] } } })),
  ]);
  if (dd) evidence.push(verUrl);
  if (graph) evidence.push(graphUrl);
  if (osv) evidence.push(OSV);

  // Licence of the package itself: deps.dev first (SPDX), the registry's declaration otherwise.
  const ddLicence = dd?.licenses?.filter((l) => l && l !== "non-standard").join(" AND ");
  const licence = ddLicence || reg.data.licence || "unknown";
  const cls = classifyLicence(licence);
  if (cls === "red") refuse(`licence ${licence} is on the red list (copyleft, source-available or commercial)`);
  else if (cls === "unknown") refuse("no declared licence: it can't be cleared");
  else if (cls === "amber") conditions.push(`Weak copyleft (${licence}): keep it an unmodified, separately replaceable dependency.`);

  // Transitive licences and named packages anywhere in the graph (vectorbt via Riskfolio-Lib).
  const transitive: OssDependencyLicence[] = [];
  const nodes = (graph?.nodes ?? []).filter((n) => n.relation !== "SELF");
  if (graph && graph.error) reasons.push(`deps.dev graph: ${graph.error.slice(0, 200)}`);
  if (!graph) conditions.push("Transitive licences weren't checked (no dependency graph); review them before keeping the package.");
  if (nodes.length > MAX_GRAPH_NODES) conditions.push(`Only the first ${MAX_GRAPH_NODES} of ${nodes.length} dependencies were licence-checked.`);
  const checked = await pool(nodes.slice(0, MAX_GRAPH_NODES), 8, async (n) => {
    const u = `${DEPS_DEV}/systems/${SYSTEM[eco]}/packages/${encodeURIComponent(n.versionKey.name)}/versions/${encodeURIComponent(n.versionKey.version)}`;
    const v = await getJson<DepsDevVersion>(f, u).catch(() => undefined);
    return { n, licences: v?.licenses ?? [] };
  });
  for (const { n, licences } of checked) {
    const dep = n.versionKey;
    transitive.push({ package: dep.name, version: dep.version, licences, relation: n.relation === "DIRECT" ? "direct" : "indirect" });
    const named = matchNamed(RED_PACKAGES, eco, dep.name, dep.version);
    if (named) refuse(`dependency ${dep.name}@${dep.version}: ${named.reason}`);
    const amberNamed = matchNamed(AMBER_PACKAGES, eco, dep.name, dep.version);
    if (amberNamed) conditions.push(`via ${dep.name}: ${amberNamed.condition}`);
    const c = classifyLicence(licences.filter((l) => l !== "non-standard").join(" AND "));
    if (c === "red") refuse(`dependency ${dep.name}@${dep.version} is ${licences.join(" AND ")} (red list)`);
    else if (c === "amber") conditions.push(`Dependency ${dep.name} is ${licences.join(" AND ")} (weak copyleft): keep it unmodified.`);
  }
  const unknownDeps = transitive.filter((d) => classifyLicence(d.licences.join(" AND ")) === "unknown").map((d) => d.package);
  if (unknownDeps.length) conditions.push(`Dependencies with no declared licence: ${unknownDeps.slice(0, 10).join(", ")}${unknownDeps.length > 10 ? "…" : ""}; check them by hand.`);

  // Advisories on this exact version (OSV), plus any deps.dev lists.
  const advisories: OssAdvisory[] = (osv?.vulns ?? []).slice(0, 50).map((v: any) => ({
    id: String(v.id).slice(0, 80),
    summary: typeof v.summary === "string" ? v.summary.slice(0, 500) : undefined,
    severity: typeof v.database_specific?.severity === "string" ? v.database_specific.severity.slice(0, 40) : undefined,
    url: `https://osv.dev/vulnerability/${encodeURIComponent(String(v.id))}`,
  }));
  for (const k of dd?.advisoryKeys ?? []) if (!advisories.some((a) => a.id === k.id)) advisories.push({ id: k.id.slice(0, 80), url: `https://osv.dev/vulnerability/${encodeURIComponent(k.id)}` });
  const critical = advisories.filter((a) => /critical/i.test(a.severity ?? ""));
  if (critical.length) refuse(`critical advisories on ${version}: ${critical.map((a) => a.id).join(", ")}`);
  else if (advisories.length) conditions.push(`Known advisories on ${version} (${advisories.map((a) => a.id).slice(0, 5).join(", ")}): pick a fixed version or confirm they don't apply.`);

  // Repo health: OpenSSF Scorecard for the source repo deps.dev links (or the registry's).
  const sourceRepo = dd?.relatedProjects?.find((p) => p.relationType === "SOURCE_REPO")?.projectKey.id;
  const repo = (sourceRepo ? repoUrl(`https://${sourceRepo}`) : undefined) ?? reg.data.repository;
  let scorecard: number | undefined;
  if (repo?.startsWith("https://github.com/")) {
    const sUrl = `${SCORECARD}/${repo.slice("https://".length)}`;
    const s = await soft("OpenSSF Scorecard", getJson<{ score?: number }>(f, sUrl));
    if (s && typeof s.score === "number") {
      scorecard = Math.max(0, Math.min(10, s.score));
      evidence.push(sUrl);
    }
  }
  if (scorecard === undefined) reasons.push("no OpenSSF Scorecard for the source repo");
  else if (scorecard < LOW_SCORECARD) conditions.push(`Low OpenSSF Scorecard (${scorecard.toFixed(1)}/10): review its security practices.`);

  const lastRelease = reg.data.lastRelease;
  const now = deps.now?.() ?? new Date();
  if (lastRelease && (now.getTime() - Date.parse(lastRelease)) / 86_400_000 > STALE_DAYS) conditions.push(`No release since ${lastRelease.slice(0, 10)}: treat it as unmaintained.`);
  if (reg.data.maintainers === 1) conditions.push("One maintainer: plan for a fork or a replacement if it goes quiet.");

  const uniq = (xs: string[]) => [...new Set(xs)];
  return OssEvaluation.parse({
    ...base,
    version,
    licence: licence.slice(0, 200),
    transitiveLicences: transitive,
    scorecard,
    advisories,
    lastRelease,
    maintainers: reg.data.maintainers,
    repository: repo,
    decision: red ? "refused" : conditions.length ? "amber" : "picked",
    conditions: uniq(conditions),
    reasons: uniq(red ? reasons : reasons.length ? reasons : ["passed the static gate"]),
    evidence: uniq(evidence),
  });
}
