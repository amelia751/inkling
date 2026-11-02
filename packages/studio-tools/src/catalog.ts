import type { CatalogKind } from "./schemas.ts";

/**
 * The generated catalogue (`schemas/catalog.json`) as the Studio tools use it: a compact preset
 * index for the system prompt (instead of the ~30 KB catalogue) and a scored search behind
 * `search_catalog`.
 *
 * Presets are catalogue contributions `<module>.presets.<name>`, but environments reference them
 * as `preset:<name>` (the `extends` enum of schemas/environment.v1.json); `presetRef` maps one to
 * the other without naming the product namespace.
 */

export interface CatalogModule {
  id: string;
  title?: string;
  description?: string;
  version?: string;
}

export interface CatalogContribution {
  id: string;
  type: string;
  module: string;
  description?: string;
  label?: string;
  example?: unknown;
  [key: string]: unknown;
}

/** todo19 D12: one preset as the profile for one data kind. */
export interface CatalogProfile {
  kind: string;
  preset: string;
  renderer?: string;
  description?: string;
}

export interface Catalog {
  version: number;
  modules: CatalogModule[];
  contributions: CatalogContribution[];
  /** Presets as per-kind profiles (kind → preset); older catalogues lack it (derived from the presets then). */
  profiles?: CatalogProfile[];
}

const PRESET_SEGMENT = ".presets.";

/** `<module>.presets.<name>` → `preset:<name>`; anything else is returned as is. */
export function presetRef(contributionId: string): string {
  const at = contributionId.lastIndexOf(PRESET_SEGMENT);
  return at >= 0 ? `preset:${contributionId.slice(at + PRESET_SEGMENT.length)}` : contributionId;
}

export const presetRefs = (catalog: Catalog): string[] =>
  catalog.contributions
    .filter((c) => c.type === "presets")
    .map((c) => presetRef(c.id))
    .sort();

/** Data kind ids in the catalogue. */
export const kindIds = (catalog: Catalog): string[] => catalog.contributions.filter((c) => c.type === "dataKinds").map((c) => c.id);

/** A full kind id from a full id or its last segment ("raster"), or undefined if unknown or ambiguous. */
export function resolveKind(catalog: Catalog, ref: string): string | undefined {
  const ids = kindIds(catalog);
  if (ids.includes(ref)) return ref;
  const short = ids.filter((id) => id.slice(id.lastIndexOf(".") + 1) === ref);
  return short.length === 1 ? short[0] : undefined;
}

/** Every per-kind profile: the catalogue's `profiles`, else each preset's `data.kind` / `data.kinds`. */
export function catalogProfiles(catalog: Catalog): CatalogProfile[] {
  if (catalog.profiles) return catalog.profiles;
  return catalog.contributions
    .filter((c) => c.type === "presets")
    .flatMap((c) => {
      const data = (c.example as { data?: { kind?: string; kinds?: Record<string, unknown> } } | undefined)?.data;
      const kinds = [...new Set([...(data?.kind ? [data.kind] : []), ...Object.keys(data?.kinds ?? {})])];
      return kinds.map((kind) => ({ kind, preset: presetRef(c.id), description: c.description }));
    });
}

/** The kinds a renderer consumes (empty when it isn't a known renderer). */
export function rendererConsumes(catalog: Catalog, renderer: string): string[] | undefined {
  const r = catalog.contributions.find((c) => c.type === "renderers" && c.id === renderer);
  return r ? ((r.consumes as string[] | undefined) ?? []) : undefined;
}

/** First sentence-ish line, at most `max` characters. */
export function oneLine(text: string | undefined, max = 160): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * A short, stable text index for the system prompt: every preset (`preset:<name>` plus one line)
 * and every module (one line). Sorted, so it is byte-identical for the same catalogue.
 */
export function compactPresetIndex(catalog: Catalog): string {
  const presets = catalog.contributions
    .filter((c) => c.type === "presets")
    .map((c) => [presetRef(c.id), oneLine(c.description, 120)] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  const modules = [...catalog.modules].sort((a, b) => a.id.localeCompare(b.id));
  const byKind = new Map<string, string[]>();
  for (const p of catalogProfiles(catalog)) byKind.set(p.kind, [...(byKind.get(p.kind) ?? []), p.preset]);
  const profiles = [...byKind].sort(([a], [b]) => a.localeCompare(b));
  return [
    "## Presets (`extends` / boot_studio `preset`)",
    ...presets.map(([id, d]) => `- ${id}: ${d}`),
    "",
    ...(profiles.length
      ? [
          "## Profiles (data kind → presets; a Studio is one task over many kinds, boot_studio `accepts`, each kind's view at /data/kinds/<kind>)",
          ...profiles.map(([k, ps]) => `- ${k}: ${ps.join(", ")}`),
          "",
        ]
      : []),
    "## Modules",
    ...modules.map((m) => `- ${m.id}: ${oneLine(m.title && m.description ? `${m.title}. ${m.description}` : (m.description ?? m.title), 80)}`),
    "",
    "Contribution ids are `<module>.<type>.<name>` (types: dataKinds, renderers, tools, panels, inspectors, exporters, labelControls, commands, reviewRules). Look them up with search_catalog; never guess one.",
  ].join("\n");
}

export interface CatalogHit {
  id: string;
  type: string;
  module?: string;
  description: string;
  label?: string;
  /** For presets: the catalogue id behind `preset:<name>`. */
  catalogId?: string;
  /** `full` only. */
  example?: unknown;
  /** `full` only: the other declared fields (configSchema, consumes, space, keys, …). */
  more?: Record<string, unknown>;
  score: number;
}

const STOP = new Set(["a", "an", "the", "for", "of", "to", "and", "or", "with", "on", "in", "by", "me", "my", "i", "is", "it", "that", "this", "some", "any"]);
const tokens = (s: string) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !STOP.has(t));
const stem = (t: string) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t);

interface Doc {
  id: string;
  type: string;
  module?: string;
  description: string;
  label?: string;
  catalogId?: string;
  idWords: Set<string>;
  labelWords: Set<string>;
  textWords: Set<string>;
  text: string;
  source?: CatalogContribution;
}

function docs(catalog: Catalog): Doc[] {
  const mk = (id: string, type: string, description: string, label: string | undefined, module?: string, source?: CatalogContribution, catalogId?: string): Doc => ({
    id,
    type,
    module,
    description,
    label,
    catalogId,
    source,
    idWords: new Set(tokens(`${id} ${catalogId ?? ""}`).map(stem)),
    labelWords: new Set(tokens(label ?? "").map(stem)),
    textWords: new Set(tokens(description).map(stem)),
    text: `${label ?? ""} ${description}`.toLowerCase(),
  });
  return [
    ...catalog.modules.map((m) => mk(m.id, "modules", m.description ?? "", m.title)),
    ...catalog.contributions.map((c) => (c.type === "presets" ? mk(presetRef(c.id), c.type, c.description ?? "", c.label, c.module, c, c.id) : mk(c.id, c.type, c.description ?? "", c.label, c.module, c))),
  ];
}

const index = new WeakMap<Catalog, Doc[]>();

/**
 * Scored token search over modules and contributions. Per query word: an id word scores 3, a
 * label word 2, a description word 1, a word naming the type ("tool", "exporter") 1.5; the whole
 * query appearing as a phrase adds 2. Ties sort by id, so results are stable.
 */
export function searchCatalog(catalog: Catalog, query: string, opts: { detail?: "brief" | "full"; kind?: CatalogKind | string; limit?: number } = {}): CatalogHit[] {
  let all = index.get(catalog);
  if (!all) index.set(catalog, (all = docs(catalog)));
  const q = [...new Set(tokens(query).map(stem))];
  if (!q.length) return [];
  const phrase = query.toLowerCase().trim();
  const full = opts.detail === "full";
  const limit = Math.max(1, Math.min(opts.limit ?? (full ? 3 : 8), 25));
  const scored: { d: Doc; score: number }[] = [];
  for (const d of all) {
    if (opts.kind && d.type !== opts.kind) continue;
    let score = 0;
    let hits = 0;
    const type = stem(d.type.toLowerCase());
    for (const t of q) {
      const s = d.idWords.has(t) ? 3 : d.labelWords.has(t) ? 2 : d.textWords.has(t) ? 1 : type.startsWith(t) || t.startsWith(type) ? 1.5 : [...d.idWords].some((w) => w.length > 3 && t.length > 3 && (w.startsWith(t) || t.startsWith(w))) ? 1 : 0;
      if (s) hits++;
      score += s;
    }
    if (!hits) continue;
    // Prefer entries that cover more of the query.
    score *= hits / q.length;
    if (q.length > 1 && d.text.includes(phrase)) score += 2;
    scored.push({ d, score });
  }
  scored.sort((a, b) => b.score - a.score || a.d.id.localeCompare(b.d.id));
  return scored.slice(0, limit).map(({ d, score }) => {
    const hit: CatalogHit = { id: d.id, type: d.type, ...(d.module ? { module: d.module } : {}), description: full ? d.description : oneLine(d.description), score: Math.round(score * 100) / 100 };
    if (d.label) hit.label = d.label;
    if (d.catalogId) hit.catalogId = d.catalogId;
    if (full && d.source) {
      const { id: _i, type: _t, module: _m, description: _d, label: _l, example, ...more } = d.source;
      if (example !== undefined) hit.example = example;
      if (Object.keys(more).length) hit.more = more;
    }
    return hit;
  });
}
