import type { Rules, RuleSeverity } from "@studio/contracts/rules";
import { labelId, splitList } from "@/studio/lib/governance-api";

/**
 * The Rules editor's form state (todo17 D3): list fields are kept as the text people type
 * ("pneumonia, PNA") and turned back into `rules.v1` on save, keeping fields the form doesn't edit.
 */

export interface LabelDraft {
  id: string;
  name: string;
  synonyms: string;
  colour: string;
  geometries: string;
}

export interface RulesDraft {
  labels: LabelDraft[];
  folderPatterns: string;
  fileNamePattern: string;
  forbiddenCharacters: string;
  maxDepth: string;
  requiredMetadata: string[];
  mergeAuto: "write-tier" | "never";
  severityOverrides: Record<string, RuleSeverity>;
}

export const DATASET_METADATA = ["modality", "license", "source", "description"] as const;

export function toDraft(r: Partial<Rules>): RulesDraft {
  return {
    labels: (r.labels ?? []).map((l) => ({ id: l.id, name: l.name, synonyms: (l.synonyms ?? []).join(", "), colour: l.colour ?? "", geometries: (l.allowedGeometries ?? []).join(", ") })),
    folderPatterns: (r.layout?.folderPatterns ?? []).join("\n"),
    fileNamePattern: r.layout?.fileNamePattern ?? "",
    forbiddenCharacters: r.layout?.forbiddenCharacters ?? "",
    maxDepth: r.layout?.maxDepth ? String(r.layout.maxDepth) : "",
    requiredMetadata: [...(r.datasets?.requiredMetadata ?? [])],
    mergeAuto: r.merge?.auto ?? "write-tier",
    severityOverrides: { ...(r.severityOverrides ?? {}) },
  };
}

/** The draft as a rules document, on top of `base` (attributes, annotations and imaging stay as they were). */
export function fromDraft(d: RulesDraft, base: Partial<Rules>): Rules {
  const byId = new Map((base.labels ?? []).map((l) => [l.id, l]));
  const ids: string[] = d.labels.map((l) => l.id).filter(Boolean);
  const labels = d.labels.map((l) => {
    const id = l.id || labelId(l.name, ids);
    if (!l.id) ids.push(id);
    const out: Rules["labels"][number] = { ...(byId.get(id) ?? {}), id, name: l.name.trim(), synonyms: splitList(l.synonyms, /,/), allowedGeometries: splitList(l.geometries, /,/) };
    if (l.colour) out.colour = l.colour;
    else delete out.colour;
    return out;
  });
  const depth = Number.parseInt(d.maxDepth, 10);
  const layout = {
    ...(base.layout ?? {}),
    folderPatterns: splitList(d.folderPatterns, /\n/),
    forbiddenCharacters: d.forbiddenCharacters,
  } as Rules["layout"];
  if (d.fileNamePattern.trim()) layout.fileNamePattern = d.fileNamePattern.trim();
  else delete layout.fileNamePattern;
  if (Number.isFinite(depth) && depth > 0) layout.maxDepth = depth;
  else delete layout.maxDepth;
  return {
    ...(base as Rules),
    version: 1,
    labels,
    layout,
    datasets: { ...(base.datasets ?? { oneModalityPerDataset: false, uniqueNames: true }), requiredMetadata: DATASET_METADATA.filter((m) => d.requiredMetadata.includes(m)) } as Rules["datasets"],
    merge: { ...(base.merge ?? {}), auto: d.mergeAuto },
    severityOverrides: { ...d.severityOverrides },
  };
}

/** A new, empty label row. */
export const newLabel = (): LabelDraft => ({ id: "", name: "", synonyms: "", colour: "", geometries: "" });
