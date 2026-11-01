import type { DatasetCollection, DatasetIssue, DatasetIssueCategory, DatasetProfile, DatasetSummary, DetectedKind } from "@studio/contracts/types";

/**
 * Plain-language reading of a dataset profile (docs/datasets.md §3: `MRI volumes` before
 * `NIfTI float32[Z,Y,X]`). Pure, so the words are tested once and every view says the same.
 */

/** "1 series", "120 images": a count at the level the collection names. */
export function countOf(n: number, unit: { one: string; other: string }): string {
  return `${n.toLocaleString()} ${n === 1 ? unit.one : unit.other}`;
}

/** "1 series · 120 images · 1 table": what is counted, at each collection's own level (§2.1). */
export function contentSummary(profile: Pick<DatasetProfile, "collections">, max = 3): string {
  const parts = profile.collections.slice(0, max).map((c) => countOf(c.count, c.unit));
  const rest = profile.collections.length - max;
  return [...parts, ...(rest > 0 ? [`${rest} more`] : [])].join(" · ");
}

/** "DICOM series · Images · Tables" */
export function collectionNames(profile: Pick<DatasetProfile, "collections">): string {
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

export function modalitiesOf(profile: Pick<DatasetProfile, "collections"> | undefined): Modality[] {
  return [...new Set((profile?.collections ?? []).map((c) => FAMILY[c.kind]).filter((m): m is Modality => !!m))];
}

export type DatasetStatus = "processing" | "needs-attention" | "draft" | "ready";
export const STATUS_LABEL: Record<DatasetStatus, string> = { processing: "Processing", "needs-attention": "Needs attention", draft: "Draft", ready: "Ready" };
export const STATUS_THEME: Record<DatasetStatus, "info" | "warning" | "unknown" | "success"> = { processing: "info", "needs-attention": "warning", draft: "unknown", ready: "success" };

/**
 * One word for where a dataset stands. Files still being checked first (the numbers will
 * change), then anything blocking or high-severity, then a Studio still in draft.
 */
export function datasetStatus(d: Pick<DatasetSummary, "tasks">, profile: Pick<DatasetProfile, "checking" | "issues"> | undefined): DatasetStatus | undefined {
  if (!profile) return undefined;
  if (profile.checking > 0) return "processing";
  if (profile.issues.some((i) => i.blocking || i.severity === "high")) return "needs-attention";
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
