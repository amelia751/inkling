import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalLabel, Rules } from "./rules";
import { LINT_RULES, lintRule, lintRulesMarkdown, Violation, WriteRejected } from "./lint-rules";

const ROOT = resolve(__dirname, "../../..");
const PRESETS: string[] = readdirSync(resolve(ROOT, "registry/presets")).filter((f: string) => f.endsWith(".json"));

describe("rules.v1", () => {
  it("defaults every section from {}", () => {
    const r = Rules.parse({});
    expect(r.labels).toEqual([]);
    expect(r.datasets.uniqueNames).toBe(true);
    expect(r.merge.auto).toBe("write-tier");
    expect(r.layout.forbiddenCharacters).toBe("");
  });

  it("parses labels with synonyms and finds the canonical label", () => {
    const r = Rules.parse({ labels: [{ id: "pneumonia", name: "Pneumonia", synonyms: ["PNA"], allowedGeometries: ["box"] }] });
    expect(canonicalLabel(r, " pna ")?.id).toBe("pneumonia");
    expect(canonicalLabel(r, "normal")).toBeUndefined();
  });

  it("rejects a synonym that names two labels, bad colours and severities", () => {
    expect(Rules.safeParse({ labels: [{ id: "a", name: "A", synonyms: ["x"] }, { id: "b", name: "B", synonyms: ["X"] }] }).success).toBe(false);
    expect(Rules.safeParse({ labels: [{ id: "a", name: "A", colour: "red" }] }).success).toBe(false);
    expect(Rules.safeParse({ severityOverrides: { "label.unknown": "fatal" } }).success).toBe(false);
    expect(Rules.safeParse({ merge: { auto: "always" } }).success).toBe(false);
  });

  it.each(PRESETS)("preset %s has valid rules", (f: string) => {
    const preset = JSON.parse(readFileSync(resolve(ROOT, "registry/presets", f), "utf8"));
    expect(preset.rules, f).toBeDefined();
    const r = Rules.parse(preset.rules);
    expect(r.labels.length).toBeGreaterThan(0);
    for (const code of [...Object.keys(r.severityOverrides), ...Object.keys(r.imaging.checks)]) expect(lintRule(code), code).toBeDefined();
  });
});

describe("lint rule catalogue", () => {
  it("has unique codes, including every D4 code", () => {
    const codes = LINT_RULES.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of ["label.unknown", "label.synonym", "geometry.not-allowed", "annotation.out-of-bounds", "dataset.name-taken", "dataset.metadata-missing", "dataset.mixed-modality", "layout.misplaced", "name.pattern", "name.phi-suspect", "env.unresolved", "env.label-drift", "dicom.series-incomplete", "dicom.seg-frame-mismatch", "nifti.orientation-mismatch"])
      expect(codes).toContain(c);
  });

  it("documents every rule", () => {
    const md = lintRulesMarkdown();
    for (const r of LINT_RULES) expect(md).toContain(`\`${r.code}\``);
  });

  it("shapes problem JSON with every violation", () => {
    const v = Violation.parse({ rule: "label.unknown", severity: "error", path: "/annotations/0/label", value: "pnemonia", allowed: ["Normal", "Pneumonia"], message: "Unknown label", fix: lintRule("label.unknown")!.fix });
    expect(WriteRejected.safeParse({ type: "about:blank", title: "Write rejected", status: 422, code: "write_rejected", violations: [v], retryable: false }).success).toBe(true);
    expect(WriteRejected.safeParse({ type: "about:blank", title: "x", status: 422, code: "write_rejected", violations: [], retryable: false }).success).toBe(false);
    expect(Violation.safeParse({ ...v, severity: "off" }).success).toBe(false);
  });
});
