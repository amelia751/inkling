import { z } from "zod";

/**
 * Project rules (`rules.v1`, todo17 D3). Stored per project with history, copied into dataset
 * commits as `.studio/rules.json`, defaulted from the preset's `rules` section (domain words stay
 * in presets). Emitted to `schemas/rules.v1.json`; the kernel (apps/api `kernel/lint/`) mirrors it.
 * Every field has a default, so `{}` is a valid, permissive rules document.
 */
export const RULE_SEVERITIES = ["error", "warn", "info", "off"] as const;
export const RuleSeverity = z.enum(RULE_SEVERITIES);
export type RuleSeverity = z.infer<typeof RuleSeverity>;

/** Domain-neutral core geometries (`box`, `polygon`, `span`, `instant`…), as in annotations. */
export const RuleGeometry = z.string().min(1);

export const LabelRule = z.object({
  id: z.string().min(1).describe("Stable id stored on annotations"),
  name: z.string().min(1).describe("Canonical display name"),
  synonyms: z.array(z.string().min(1)).default([]).describe("Other spellings; normalised to `name` on write (label.synonym)"),
  colour: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  allowedGeometries: z.array(RuleGeometry).default([]).describe("Empty means any geometry"),
  attributes: z.record(z.string(), z.unknown()).optional().describe("JSON Schema for annotation.attributes under this label"),
});
export type LabelRule = z.infer<typeof LabelRule>;

export const LayoutRules = z.object({
  folderPatterns: z.array(z.string()).default([]).describe("Glob patterns files must live under; empty means anywhere"),
  fileNamePattern: z.string().optional().describe("Regular expression every file name must match"),
  forbiddenCharacters: z.string().default("").describe("Characters not allowed in file and folder names"),
  maxDepth: z.number().int().positive().optional(),
});

export const DatasetMetadataField = z.enum(["modality", "license", "source", "description"]);
export const DatasetRules = z.object({
  requiredMetadata: z.array(DatasetMetadataField).default([]),
  oneModalityPerDataset: z.boolean().default(false),
  uniqueNames: z.boolean().default(true),
});

export const AnnotationRules = z.object({
  insideImage: z.boolean().default(true),
  minSize: z.number().nonnegative().optional().describe("Minimum extent in pixels (or samples for 1D)"),
  requiredAttributes: z.array(z.string()).default([]),
});

export const ImagingRules = z.object({
  checks: z.record(z.string(), RuleSeverity).default({}).describe("Imaging check code → severity (dicom.*, nifti.*)"),
});

export const MergeRules = z.object({
  auto: z.enum(["write-tier", "never"]).default("write-tier").describe("Auto-merge change requests whose operations are all tier write and pass every check (D7)"),
});

export const Rules = z.object({
  version: z.literal(1).default(1),
  labels: z.array(LabelRule).default([]),
  layout: LayoutRules.default(() => LayoutRules.parse({})),
  datasets: DatasetRules.default(() => DatasetRules.parse({})),
  annotations: AnnotationRules.default(() => AnnotationRules.parse({})),
  imaging: ImagingRules.default(() => ImagingRules.parse({})),
  severityOverrides: z.record(z.string(), RuleSeverity).default({}).describe("Lint rule code → severity"),
  merge: MergeRules.default(() => MergeRules.parse({})),
}).superRefine((r, ctx) => {
  const seen = new Map<string, string>();
  r.labels.forEach((l, i) => {
    for (const word of [l.id, l.name, ...l.synonyms]) {
      const k = word.normalize("NFC").trim().toLowerCase();
      const owner = seen.get(k);
      if (owner !== undefined && owner !== l.id) ctx.addIssue({ code: "custom", path: ["labels", i], message: `"${word}" already names label ${owner}` });
      seen.set(k, l.id);
    }
  });
});
export type Rules = z.infer<typeof Rules>;
export type RulesInput = z.input<typeof Rules>;

/** Canonical label for a name or synonym (case- and NFC-insensitive), or undefined. */
export function canonicalLabel(rules: Pick<Rules, "labels">, word: string): LabelRule | undefined {
  const k = word.normalize("NFC").trim().toLowerCase();
  return rules.labels.find((l) => [l.id, l.name, ...l.synonyms].some((w) => w.normalize("NFC").trim().toLowerCase() === k));
}
