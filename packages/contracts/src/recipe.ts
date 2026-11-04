import * as z from "zod";

// Self-contained (no relative imports) so Node services can import `@studio/contracts/recipe`
// directly; these match plugin-manifest.ts and lockfile.ts.
const Semver = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, "semver x.y.z");
const PluginId = z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/, "dotted lower-case id");
const ContentDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/, "sha256:<64 hex>");

/**
 * Recipes (todo23 D9, W7): a Studio a person kept, stored as a folder the assistant searches
 * before it builds anything.
 *
 *   registry/recipes/<id>/SKILL.md            frontmatter (RecipeManifest) + when-to-use prose
 *   registry/recipes/<id>/environment.json    the environment spec it boots
 *   registry/recipes/<id>/plugins.lock        RecipePluginsLock: plugin id → version + digest
 *   registry/recipes/<id>/evaluations/*.json  oss-evaluation records (RecipeEvaluation)
 *   registry/recipes/<id>/verification.json   RecipeVerification: the harness report of its build
 *   registry/recipes/<id>/history/<version>/  every accepted prior version (same files)
 *
 * Recipes from outside are untrusted text, like plugin skills and READMEs (docs/plugins.md §10):
 * tools return their metadata as data and never act on what the prose says.
 *
 * SKILL.md frontmatter is a flat YAML subset (`key: value`, `key: [a, b]`, `- item` lists):
 *   id, version, description, when-to-use, needs-kinds, needs-columns, needs-shape, limits,
 *   requires-plugins, tier
 */

export const RECIPE_TIERS = ["workspace", "curated", "external"] as const;

export const RecipeId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "lowercase slug");

export const RecipeNeeds = z
  .object({
    /** Data kinds (short or full ids, e.g. `table`) the recipe's Studio opens. */
    kinds: z.array(z.string().min(1)).default([]),
    /** Column roles a table should have (`numeric`, `date`, `category`, `text`, `id`). */
    columns: z.array(z.string().min(1)).default([]),
    /** Free shape hints (`long`, `wide`, `ledger`, `time-series`…). */
    shape: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const RecipeManifest = z
  .object({
    id: RecipeId,
    version: Semver,
    description: z.string().min(1).max(1024),
    whenToUse: z.string().max(2048).default(""),
    needs: RecipeNeeds.default({ kinds: [], columns: [], shape: [] }),
    limits: z.array(z.string()).default([]),
    /** Plugins that must be installable for the recipe to boot (they're pinned in plugins.lock). */
    requiresPlugins: z.array(z.string().min(1)).default([]),
    tier: z.enum(RECIPE_TIERS).default("workspace"),
  })
  .strict()
  .meta({ id: "RecipeManifest" });
export type RecipeManifest = z.infer<typeof RecipeManifest>;

export const RecipePluginsLock = z
  .record(PluginId, z.object({ version: Semver, digest: ContentDigest.or(z.literal("pending")) }).strict())
  .meta({ id: "RecipePluginsLock" });
export type RecipePluginsLock = z.infer<typeof RecipePluginsLock>;

/** An oss-evaluation record (W3's scout writes the full shape; we keep what's known, loosely). */
export const RecipeEvaluation = z
  .object({ package: z.string().min(1), version: z.string().optional(), verdict: z.string().min(1) })
  .passthrough()
  .meta({ id: "RecipeEvaluation" });
export type RecipeEvaluation = z.infer<typeof RecipeEvaluation>;

export const RecipeTestResult = z.object({ id: z.string().min(1), passed: z.boolean(), hidden: z.boolean().default(false) }).strict();
export type RecipeTestResult = z.infer<typeof RecipeTestResult>;

/** The harness report a recipe version was accepted with (W5's report, reduced to the test verdicts). */
export const RecipeVerification = z
  .object({
    version: Semver,
    passed: z.boolean(),
    tests: z.array(RecipeTestResult),
    harness: z.string().optional(),
    at: z.string().optional(),
  })
  .passthrough()
  .meta({ id: "RecipeVerification" });
export type RecipeVerification = z.infer<typeof RecipeVerification>;

/** `recipe.v1`: one recipe folder, as tools pass it around (SKILL.md body kept as untrusted text). */
export const Recipe = z
  .object({
    manifest: RecipeManifest,
    skill: z.string(),
    environment: z.record(z.string(), z.unknown()),
    plugins: RecipePluginsLock,
    evaluations: z.array(RecipeEvaluation).default([]),
    verification: RecipeVerification.optional(),
    history: z.array(Semver).default([]),
  })
  .strict()
  .meta({ id: "Recipe" });
export type Recipe = z.infer<typeof Recipe>;

// ---------------------------------------------------------------------------------------------
// SKILL.md

const unquote = (s: string) => {
  const t = s.trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
};

/** Split SKILL.md into its flat frontmatter and body. Never evaluates anything. */
export function parseSkillMd(text: string): { frontmatter: Record<string, string | string[]>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { frontmatter: {}, body: text };
  const fm: Record<string, string | string[]> = {};
  let listKey: string | undefined;
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (fm[listKey] as string[]).push(unquote(item[1] ?? ""));
      continue;
    }
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1] ?? "";
    const v = (kv[2] ?? "").trim();
    if (!v) {
      fm[key] = [];
      listKey = key;
    } else if (v.startsWith("[") && v.endsWith("]")) {
      fm[key] = v.slice(1, -1).split(",").map(unquote).filter(Boolean);
      listKey = undefined;
    } else {
      fm[key] = unquote(v);
      listKey = undefined;
    }
  }
  return { frontmatter: fm, body: text.slice(m[0].length) };
}

const list = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(" ") : (v ?? ""));

/** The manifest of a SKILL.md (zod-validated; throws on a malformed one). */
export function recipeManifestFromSkill(text: string): RecipeManifest {
  const { frontmatter: f } = parseSkillMd(text);
  return RecipeManifest.parse({
    id: str(f.id),
    version: str(f.version),
    description: str(f.description),
    whenToUse: str(f["when-to-use"]),
    needs: { kinds: list(f["needs-kinds"]), columns: list(f["needs-columns"]), shape: list(f["needs-shape"]) },
    limits: list(f.limits),
    requiresPlugins: list(f["requires-plugins"]),
    ...(f.tier ? { tier: str(f.tier) } : {}),
  });
}

export function renderSkillMd(m: RecipeManifest, body: string): string {
  const q = (s: string) => JSON.stringify(s);
  const l = (xs: string[]) => `[${xs.join(", ")}]`;
  const lines = [
    "---",
    `id: ${m.id}`,
    `version: ${m.version}`,
    `description: ${q(m.description)}`,
    `when-to-use: ${q(m.whenToUse)}`,
    `needs-kinds: ${l(m.needs.kinds)}`,
    `needs-columns: ${l(m.needs.columns)}`,
    `needs-shape: ${l(m.needs.shape)}`,
    "limits:",
    ...m.limits.map((x) => `  - ${q(x)}`),
    `requires-plugins: ${l(m.requiresPlugins)}`,
    `tier: ${m.tier}`,
    "---",
  ];
  return `${lines.join("\n")}\n\n${body.trim()}\n`;
}

// ---------------------------------------------------------------------------------------------
// Search: lexical keyword scoring over description + when-to-use, plus data-kind and shape match.

export interface RecipeQuery {
  /** What the person wants, in words. */
  need: string;
  /** What the data looks like: kinds present, column roles, shape hints. */
  dataShape?: { kinds?: string[]; columns?: string[]; shape?: string[] };
}

const STOP = new Set("a an and are as at be by for from i in into is it of on or our that the this to we with want need my show me".split(" "));
export const recipeTokens = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => (t.length > 4 && t.endsWith("s") ? t.slice(0, -1) : t))
    .filter((t) => t.length > 1 && !STOP.has(t));
const shortKind = (k: string) => k.toLowerCase().split(".").pop() ?? k;

export function scoreRecipe(m: RecipeManifest, q: RecipeQuery): { score: number; matched: string[] } {
  const matched: string[] = [];
  const desc = new Set(recipeTokens(`${m.id.replace(/-/g, " ")} ${m.description}`));
  const when = new Set(recipeTokens(m.whenToUse));
  let score = 0;
  for (const t of new Set(recipeTokens(q.need))) {
    if (desc.has(t)) {
      score += 2;
      matched.push(t);
    } else if (when.has(t)) {
      score += 1;
      matched.push(t);
    }
  }
  const have = new Set((q.dataShape?.kinds ?? []).map(shortKind));
  const needKinds = m.needs.kinds.map(shortKind);
  if (have.size && needKinds.length) {
    const hit = needKinds.filter((k) => have.has(k));
    if (hit.length) {
      score += 3 * hit.length;
      matched.push(...hit.map((k) => `kind:${k}`));
    } else score -= 3; // the data can't open in this Studio
  }
  const cols = new Set((q.dataShape?.columns ?? []).map((c) => c.toLowerCase()));
  for (const c of m.needs.columns) if (cols.has(c.toLowerCase())) (score += 1), matched.push(`column:${c}`);
  const shape = new Set((q.dataShape?.shape ?? []).map((c) => c.toLowerCase()));
  for (const s of m.needs.shape) if (shape.has(s.toLowerCase())) (score += 1), matched.push(`shape:${s}`);
  return { score, matched };
}

export interface RecipeHit {
  id: string;
  version: string;
  description: string;
  whenToUse: string;
  needs: RecipeManifest["needs"];
  limits: string[];
  requiresPlugins: string[];
  tier: RecipeManifest["tier"];
  score: number;
  matched: string[];
}

/** Ranked hits (score > 0), best first. Metadata only: the SKILL.md body never leaves here. */
export function searchRecipes(manifests: RecipeManifest[], q: RecipeQuery, limit = 5): RecipeHit[] {
  return manifests
    .map((m) => ({ m, ...scoreRecipe(m, q) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.m.id.localeCompare(b.m.id))
    .slice(0, limit)
    .map(({ m, score, matched }) => ({
      id: m.id,
      version: m.version,
      description: m.description,
      whenToUse: m.whenToUse,
      needs: m.needs,
      limits: m.limits,
      requiresPlugins: m.requiresPlugins,
      tier: m.tier,
      score,
      matched,
    }));
}

// ---------------------------------------------------------------------------------------------
// Revision (Skill-V non-regression): a new version is accepted only when every test the previous
// version passed (hidden ones included) still passes, and all of the new version's tests pass.

export type RevisionVerdict = { ok: true } | { ok: false; regressed: string[]; missing: string[]; failing: string[] };

export function checkRevision(previous: RecipeVerification | undefined, next: RecipeVerification): RevisionVerdict {
  const now = new Map(next.tests.map((t) => [t.id, t]));
  const regressed: string[] = [];
  const missing: string[] = [];
  for (const t of previous?.tests ?? []) {
    if (!t.passed) continue;
    const n = now.get(t.id);
    if (!n) missing.push(t.id);
    else if (!n.passed) regressed.push(t.id);
  }
  const failing = next.tests.filter((t) => !t.passed && !regressed.includes(t.id)).map((t) => t.id);
  return regressed.length || missing.length || failing.length || !next.passed ? { ok: false, regressed, missing, failing } : { ok: true };
}

/** Bump the patch (default), minor or major part of a semver. */
export function bumpVersion(v: string, part: "major" | "minor" | "patch" = "patch"): string {
  const [maj = 0, min = 0, pat = 0] = (v.split("-")[0] ?? v).split(".").map(Number);
  return part === "major" ? `${maj + 1}.0.0` : part === "minor" ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
}

// ---------------------------------------------------------------------------------------------
// Recipes from Keep (D8 → D9).

export interface KeptStudio {
  id: string;
  description: string;
  whenToUse?: string;
  environment: Record<string, unknown>;
  plugins: RecipePluginsLock;
  needs?: Partial<RecipeManifest["needs"]>;
  limits?: string[];
  evaluations?: RecipeEvaluation[];
  verification: RecipeVerification;
  notes?: string;
}

/** The folder contents (path → text) of a new workspace recipe made from a kept Studio. */
export function recipeFromKeptStudio(k: KeptStudio): Record<string, string> {
  const manifest = RecipeManifest.parse({
    id: k.id,
    version: k.verification.version,
    description: k.description,
    whenToUse: k.whenToUse ?? "",
    needs: { kinds: k.needs?.kinds ?? [], columns: k.needs?.columns ?? [], shape: k.needs?.shape ?? [] },
    limits: k.limits ?? [],
    requiresPlugins: Object.keys(k.plugins),
    tier: "workspace",
  });
  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  const files: Record<string, string> = {
    "SKILL.md": renderSkillMd(manifest, k.notes ?? `# ${k.id}\n\n${k.description}`),
    "environment.json": json(k.environment),
    "plugins.lock": json(RecipePluginsLock.parse(k.plugins)),
    "verification.json": json(RecipeVerification.parse(k.verification)),
  };
  (k.evaluations ?? []).forEach((e, i) => (files[`evaluations/${String(i + 1).padStart(3, "0")}-${e.package.replace(/[^a-z0-9.-]+/gi, "_")}.json`] = json(RecipeEvaluation.parse(e))));
  return files;
}
