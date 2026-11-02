import type { AttentionItem, DatasetCollection, DatasetIssue, DatasetIssueCategory, DatasetProfile, DatasetSummary, DetectedKind } from "@studio/contracts/types";
import type { Commit } from "@/studio/core/versioning/api";
import type { PipelineRun, PipelineRunSummary } from "@/studio/core/pipelines/contract";
import type { DatasetAttentionItem, DatasetLandingSummary } from "./api";

/**
 * Plain-language reading of a dataset profile (docs/datasets.md §3: `MRI volumes` before
 * `NIfTI float32[Z,Y,X]`). Pure, so the words are tested once and every view says the same.
 */

/** "1 series", "120 images": a count at the level the collection names. */
export function countOf(n: number, unit: { one: string; other: string }): string {
  return `${n.toLocaleString()} ${n === 1 ? unit.one : unit.other}`;
}

/** "1 series · 120 images · 1 table": what is counted, at each collection's own level (§2.1). */
type Counted = { collections: Pick<DatasetCollection, "count" | "unit">[] };
type Kinded = { collections: Pick<DatasetCollection, "kind">[] };

export function contentSummary(profile: Counted, max = 3): string {
  const parts = profile.collections.slice(0, max).map((c) => countOf(c.count, c.unit));
  const rest = profile.collections.length - max;
  return [...parts, ...(rest > 0 ? [`${rest} more`] : [])].join(" · ");
}

/** "DICOM series · Images · Tables" */
export function collectionNames(profile: { collections: Pick<DatasetCollection, "name">[] }): string {
  return profile.collections.map((c) => c.name).join(" · ");
}

/** The landing page's modality filter (§2.1): families, not detected kinds. */
export const MODALITIES = [
  { value: "image", label: "Image" },
  { value: "volume", label: "Volume" },
  { value: "video", label: "Video" },
  { value: "tabular", label: "Tabular" },
  { value: "text", label: "Text" },
  { value: "wsi", label: "Whole-slide" },
  { value: "timeseries", label: "Time series" },
] as const;
export type Modality = (typeof MODALITIES)[number]["value"];

const FAMILY: Partial<Record<DetectedKind, Modality>> = {
  image: "image",
  dicom: "image",
  "dicom-series": "volume",
  volume: "volume",
  mask: "volume",
  video: "video",
  table: "tabular",
  document: "text",
  slide: "wsi",
  waveform: "timeseries",
};

export function modalitiesOf(profile: Kinded | undefined): Modality[] {
  return [...new Set((profile?.collections ?? []).map((c) => FAMILY[c.kind]).filter((m): m is Modality => !!m))];
}

export type DatasetStatus = "processing" | "needs-attention" | "draft" | "ready";
export const STATUS_LABEL: Record<DatasetStatus, string> = { processing: "Processing", "needs-attention": "Needs attention", draft: "Draft", ready: "Ready" };
export const STATUS_THEME: Record<DatasetStatus, "info" | "warning" | "unknown" | "success"> = { processing: "info", "needs-attention": "warning", draft: "unknown", ready: "success" };

/**
 * One word for where a dataset stands. Files still being checked first (the numbers will
 * change), then anything blocking or high-severity, then a Studio still in draft.
 */
export function datasetStatus(d: Pick<DatasetSummary, "tasks">, profile: Pick<DatasetProfile, "checking" | "issues"> | Pick<DatasetLandingSummary, "checking" | "issues"> | undefined): DatasetStatus | undefined {
  if (!profile) return undefined;
  if (profile.checking > 0) return "processing";
  const serious = Array.isArray(profile.issues) ? profile.issues.some((i) => i.blocking || i.severity === "high") : profile.issues.blocking + profile.issues.high > 0;
  if (serious) return "needs-attention";
  if (!d.tasks.length || d.tasks.some((t) => t.state === "draft")) return "draft";
  return "ready";
}

/** Quality's panels (§8), riskiest first; each names its category in words a researcher uses. */
export const ISSUE_GROUPS: { category: DatasetIssueCategory; title: string }[] = [
  { category: "privacy", title: "Privacy" },
  { category: "identity", title: "Links between records" },
  { category: "quality", title: "Data quality" },
  { category: "unreadable", title: "Formats we can't read" },
  { category: "duplicate", title: "Duplicates" },
  { category: "checking", title: "Still being checked" },
];

export function groupIssues(issues: DatasetIssue[]): { category: DatasetIssueCategory; title: string; issues: DatasetIssue[] }[] {
  return ISSUE_GROUPS.map((g) => ({ ...g, issues: issues.filter((i) => i.category === g.category) })).filter((g) => g.issues.length > 0);
}

/** Issues by risk, not raw count (§4): blocking, then severity, then how many items. */
export function byRisk(issues: DatasetIssue[]): DatasetIssue[] {
  const sev = { high: 0, medium: 1, low: 2 } as const;
  return [...issues].sort((a, b) => Number(b.blocking) - Number(a.blocking) || sev[a.severity] - sev[b.severity] || b.count - a.count);
}

/** "95%", "<1%", "100%": how full a field is, never "0.95". */
export function percent(share: number): string {
  if (share >= 1) return "100%";
  if (share > 0 && share < 0.01) return "<1%";
  return `${Math.floor(share * 100)}%`;
}

/** Plain field types (§3: readable units and field types). */
export const FIELD_TYPE: Record<string, string> = {
  integer: "Whole number",
  number: "Number",
  decimal: "Decimal",
  text: "Text",
  category: "Category",
  id: "Identifier",
  date: "Date",
  boolean: "Yes / no",
  empty: "Empty",
  list: "List of numbers",
};

export function fieldType(type: string): string {
  return FIELD_TYPE[type] ?? type;
}

/** What one item of a collection looks like, in one line: "512 × 512 px · CT · DICOM". */
export function itemShape(c: Pick<DatasetCollection, "facts" | "formats">): string {
  const top = (key: string) => c.facts.find((f) => f.key === key)?.values[0]?.value;
  const mostly = (key: string) => {
    const f = c.facts.find((x) => x.key === key);
    const v = f?.values[0];
    if (!f || !v) return undefined;
    return f.values.length > 1 || f.more ? `mostly ${v.value}` : v.value;
  };
  return [mostly("size"), top("modality"), mostly("fps"), top("duration"), top("rows") && `${top("rows")} rows`, c.formats.map((f) => f.label).slice(0, 2).join(", ")].filter(Boolean).join(" · ");
}

/** A label class's swatch: its own colour (a CSS colour or a `chart-N` slot), else the palette by position. */
export function swatch(color: string | undefined, index: number): string {
  if (color && /^chart-[1-5]$/.test(color)) return `hsl(var(--${color}))`;
  if (color) return color;
  return `hsl(var(--chart-${(index % 5) + 1}))`;
}

// ---- Landing (todo13 Milestone 3) --------------------------------------------------------------

/** The landing summary built from a full profile, for servers without `dataset-summaries`. */
export function summaryFromProfile(datasetId: string, p: DatasetProfile): DatasetLandingSummary {
  const max = 8;
  return {
    datasetId,
    files: p.files,
    checking: p.checking,
    collections: p.collections.slice(0, max).map(({ id, name, kind, count, unit, files, suggested, issues, previewNodeId }) => ({ id, name, kind, count, unit, files, suggested, issues, previewNodeId })),
    moreCollections: Math.max(0, p.collections.length - max),
    relationships: p.relationships.length,
    issues: { count: p.issues.length, items: p.issues.reduce((n, i) => n + i.count, 0), blocking: p.issues.filter((i) => i.blocking).length, high: p.issues.filter((i) => i.severity === "high").length },
    suggestions: p.collections.filter((c) => c.suggested).length + p.relationships.filter((r) => r.status === "suggested").length,
    snapshot: p.snapshot,
    lastChangedAt: null,
  };
}

/** The review queue's dataset rows as attention rows, for servers without `dataset-attention`. */
export function attentionFromQueue(items: AttentionItem[]): DatasetAttentionItem[] {
  return items
    .filter((i) => i.datasetId)
    .map((i) => ({
      id: `queue:${i.id}`,
      kind: i.type === "privacy" || i.type === "quality" || i.type === "import" ? "malformed" : "suggestion",
      datasetId: i.datasetId ?? null,
      severity: i.severity,
      blocking: i.type === "privacy",
      title: i.title,
      detail: i.detail,
      count: 1,
      action: { label: "Open", target: i.target },
      at: i.at,
    }));
}

const runTitle = (r: PipelineRunSummary) => r.definition_name || r.definition_id;

/**
 * Pipeline runs that need a person, as attention rows (todo12's validation). For one dataset,
 * only runs whose candidate belongs to it; without a dataset, every problem run of the project.
 */
export function pipelineAttention(problems: { runs: PipelineRunSummary[]; details: PipelineRun[] } | undefined, datasetId?: string): DatasetAttentionItem[] {
  if (!problems) return [];
  const detail = new Map(problems.details.map((d) => [d.run_id, d]));
  const runs = datasetId ? problems.runs.filter((r) => detail.get(r.run_id)?.candidate?.dataset_id === datasetId) : problems.runs;
  return runs.map((r) => {
    const held = (r.item_counts?.quarantined ?? 0) + (r.item_counts?.rejected ?? 0);
    const base = { id: `pipeline:${r.run_id}`, kind: "pipeline" as const, datasetId: detail.get(r.run_id)?.candidate?.dataset_id ?? null, count: Math.max(1, held), at: r.finished_at ?? r.started_at ?? r.created_at, action: { label: "Open run", target: { section: "pipelines" as const, runId: r.run_id } } };
    if (r.state === "failed") return { ...base, severity: "high" as const, blocking: false, title: `${runTitle(r)} run failed`, detail: r.error?.message ?? "A step failed; files it didn't reach weren't processed." };
    if (r.state === "awaiting_review") return { ...base, severity: "medium" as const, blocking: false, title: `${runTitle(r)} run is waiting for review`, detail: held ? `${held.toLocaleString()} ${held === 1 ? "file was" : "files were"} held back by validation.` : "Its output becomes part of the dataset once someone approves it." };
    return { ...base, severity: "medium" as const, blocking: false, title: `${held.toLocaleString()} ${held === 1 ? "file" : "files"} held back by pipeline validation`, detail: `In the ${runTitle(r)} run. Quarantined files stay in Sources and can be retried.` };
  });
}

/** Riskiest first: blocking, severity, then a waiting decision before a suggestion. */
export function rankAttention(items: DatasetAttentionItem[]): DatasetAttentionItem[] {
  const sev = { high: 0, medium: 1, low: 2 } as const;
  const kind = { malformed: 0, pipeline: 1, plan: 2, suggestion: 3 } as const;
  return [...items].sort((a, b) => Number(b.blocking) - Number(a.blocking) || sev[a.severity] - sev[b.severity] || kind[a.kind] - kind[b.kind] || b.count - a.count);
}

// ---- History (§9.2) ----------------------------------------------------------------------------

/**
 * A commit in words (§9.2: "Added 24 reviewed MRI studies", never a hash). The author's message
 * when there is one; otherwise what the operation did.
 */
export function historyTitle(c: Pick<Commit, "message" | "operation" | "annotation_count" | "sample_count">): string {
  const msg = (c.message ?? "").trim().split("\n")[0];
  if (c.operation === "init") return msg && !/^init/i.test(msg) ? msg : "Started keeping versions of this dataset";
  if (c.operation === "merge") return msg && !/^merge\b/i.test(msg) ? `Approved: ${msg}` : "Approved changes reached main";
  if (c.operation === "revert") return "Restored an earlier version";
  if (msg) return msg.charAt(0).toUpperCase() + msg.slice(1);
  if (c.annotation_count !== undefined) return `Saved ${countOf(c.annotation_count, { one: "annotation", other: "annotations" })}`;
  return "Saved changes";
}

/** `user:ada` → "ada", `agent:run_1` → "Assistant", `service:pipeline` → "Pipeline". */
export function authorName(id: string | undefined): string {
  if (!id) return "Someone";
  const [kind, rest] = id.includes(":") ? [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)] : ["user", id];
  if (kind === "agent") return "Assistant";
  if (kind === "service" || kind === "worker") return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : "System";
  return rest || id;
}
