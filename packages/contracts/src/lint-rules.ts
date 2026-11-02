import { z } from "zod";
import { NAMING } from "./naming";
import { RuleSeverity } from "./rules";

/**
 * The lint rule catalogue (todo17 D4). Codes are stable: findings, severity overrides and docs
 * key on them. `mode` (D5): a new rule ships in `evaluate` (findings recorded as if enforced,
 * nothing rejected) until promoted to `enforce`. Emitted to `schemas/lint-rules.json` for the
 * kernel and to `docs/lint-rules.md` for people.
 */
export const LINT_TARGETS = ["label", "annotation", "file", "dataset", "environment", "rules", "dicom", "nifti"] as const;
export const LintTarget = z.enum(LINT_TARGETS);
export const LintMode = z.enum(["enforce", "evaluate"]);
export type LintMode = z.infer<typeof LintMode>;

export const LintRule = z.object({
  code: z.string().regex(/^[a-z]+(\.[a-z0-9-]+)+$/),
  title: z.string().min(1),
  appliesTo: z.array(LintTarget).min(1),
  defaultSeverity: RuleSeverity,
  fix: z.string().min(1).describe("What to do, written for a model and a person"),
  fixable: z.boolean().describe("Whether the normaliser fixes it on write"),
  mode: LintMode,
  phi: z.boolean().default(false).describe("The offending value may be PHI: never echo it, only its path"),
});
export type LintRule = z.infer<typeof LintRule>;

const rule = (r: z.input<typeof LintRule>): LintRule => LintRule.parse(r);

export const LINT_RULES: readonly LintRule[] = [
  rule({ code: "label.unknown", title: "Label isn't in the project's rules", appliesTo: ["annotation"], defaultSeverity: "error", fix: "Use one of the labels in the project rules (see `allowed`), or propose a rules change that adds it.", fixable: false, mode: "enforce" }),
  rule({ code: "label.synonym", title: "Label is a synonym of a canonical label", appliesTo: ["annotation"], defaultSeverity: "info", fix: "Use the canonical label name; the normaliser rewrites synonyms on write.", fixable: true, mode: "enforce" }),
  rule({ code: "geometry.not-allowed", title: "Geometry not allowed for this label", appliesTo: ["annotation"], defaultSeverity: "error", fix: "Draw this label with one of its allowed geometries (see `allowed`).", fixable: false, mode: "enforce" }),
  rule({ code: "annotation.out-of-bounds", title: "Annotation lies outside the image", appliesTo: ["annotation"], defaultSeverity: "error", fix: "Keep the geometry inside the image extent; clip it or redraw it.", fixable: true, mode: "evaluate" }),
  rule({ code: "annotation.too-small", title: "Annotation is smaller than the minimum size", appliesTo: ["annotation"], defaultSeverity: "warn", fix: "Redraw it at least `annotations.minSize` across, or delete it if it was a stray click.", fixable: false, mode: "evaluate" }),
  rule({ code: "annotation.attribute-missing", title: "Required attribute missing", appliesTo: ["annotation"], defaultSeverity: "error", fix: "Set every attribute listed in `annotations.requiredAttributes` and the label's attribute schema.", fixable: false, mode: "evaluate" }),
  rule({ code: "dataset.name-taken", title: "Dataset name already used in this project", appliesTo: ["dataset"], defaultSeverity: "error", fix: "Pick another name, or add the files to the existing dataset.", fixable: false, mode: "enforce" }),
  rule({ code: "dataset.metadata-missing", title: "Required dataset metadata missing", appliesTo: ["dataset"], defaultSeverity: "error", fix: "Fill in every field in `datasets.requiredMetadata` (modality, license, source, description).", fixable: false, mode: "evaluate" }),
  rule({ code: "dataset.mixed-modality", title: "Dataset mixes modalities", appliesTo: ["dataset", "file"], defaultSeverity: "warn", fix: "Put each modality in its own dataset.", fixable: false, mode: "evaluate" }),
  rule({ code: "layout.misplaced", title: "File is outside the project's folder layout", appliesTo: ["file"], defaultSeverity: "warn", fix: "Move the file under one of `layout.folderPatterns`, within `layout.maxDepth`.", fixable: false, mode: "evaluate" }),
  rule({ code: "name.pattern", title: "Name doesn't match the naming rules", appliesTo: ["file", "dataset"], defaultSeverity: "warn", fix: "Rename it to match `layout.fileNamePattern` without `layout.forbiddenCharacters`; trimming and NFC are applied on write.", fixable: true, mode: "evaluate" }),
  rule({ code: "name.phi-suspect", title: "Name may contain personal health information", appliesTo: ["file", "dataset"], defaultSeverity: "error", fix: "Rename it with a pseudonymous id; never use patient names, dates of birth or record numbers.", fixable: false, mode: "evaluate", phi: true }),
  rule({ code: "env.unresolved", title: "Environment doesn't resolve", appliesTo: ["environment"], defaultSeverity: "error", fix: "Fix the references the resolver reports (modules, renderers, tools) using the catalogue.", fixable: false, mode: "enforce" }),
  rule({ code: "env.label-drift", title: "Studio labels differ from the project's rules", appliesTo: ["environment"], defaultSeverity: "warn", fix: "Use the project's labels in the Studio, or propose a rules change.", fixable: true, mode: "evaluate" }),
  rule({ code: "dicom.series-incomplete", title: "DICOM series is incomplete", appliesTo: ["dicom"], defaultSeverity: "warn", fix: "Upload the missing instances (see the slice gaps), or remove the partial series.", fixable: false, mode: "evaluate", phi: true }),
  rule({ code: "dicom.seg-frame-mismatch", title: "SEG frame of reference doesn't match its source", appliesTo: ["dicom"], defaultSeverity: "error", fix: "Regenerate the segmentation against the referenced series.", fixable: false, mode: "evaluate", phi: true }),
  rule({ code: "nifti.orientation-mismatch", title: "NIfTI qform and sform disagree", appliesTo: ["nifti"], defaultSeverity: "warn", fix: "Rewrite the header with one consistent affine (qform = sform).", fixable: false, mode: "evaluate" }),
];

export const LINT_RULE_CODES = LINT_RULES.map((r) => r.code);
export const lintRule = (code: string): LintRule | undefined => LINT_RULES.find((r) => r.code === code);

/** One violation or finding (D6). PHI-suspect values are omitted: `value` is absent, `path` and `rule` remain. */
export const Violation = z.object({
  rule: z.string(),
  severity: RuleSeverity.exclude(["off"]),
  path: z.string().describe("JSON pointer into the operation's input"),
  value: z.unknown().optional(),
  allowed: z.array(z.unknown()).optional(),
  message: z.string(),
  fix: z.string(),
  docs: z.string().optional(),
  mode: LintMode.optional().describe("`evaluate`: recorded as if enforced, nothing rejected (D5)"),
});
export type Violation = z.infer<typeof Violation>;

/** RFC 9457 problem JSON for a rejected write (D6), with every violation at once. */
export const WriteRejected = z.object({
  type: z.string(),
  title: z.string(),
  status: z.literal(422),
  code: z.literal("write_rejected"),
  detail: z.string().optional(),
  violations: z.array(Violation).min(1),
  retryable: z.boolean(),
});
export type WriteRejected = z.infer<typeof WriteRejected>;

/** The machine-readable catalogue, `schemas/lint-rules.json`. */
export function lintRulesDocument() {
  return { $id: `${NAMING.schemaPrefix}://schema/lint-rules/v1`, severities: RuleSeverity.options, rules: LINT_RULES };
}

/** `docs/lint-rules.md`. */
export function lintRulesMarkdown(): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  const lines = [
    "<!-- Generated by `pnpm emit:schemas` from packages/contracts/src/lint-rules.ts. Do not edit. -->",
    "",
    "# Lint rules",
    "",
    "Every write runs these rules (todo17 D4). Severities: **error** rejects the write, **warn** saves it and returns a finding, **info** records it, **off** skips it. Projects override severities per code in `rules.severityOverrides`. Rules in **evaluate** mode record findings as if enforced but reject nothing (D5).",
    "",
    "| Code | Applies to | Default | Mode | Auto-fix | Fix |",
    "|---|---|---|---|---|---|",
    ...LINT_RULES.map((r) => `| \`${r.code}\` | ${r.appliesTo.join(", ")} | ${r.defaultSeverity} | ${r.mode} | ${r.fixable ? "yes" : "no"} | ${esc(r.title)}. ${esc(r.fix)} |`),
    "",
  ];
  return lines.join("\n");
}
