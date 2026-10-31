import { describe, expect, it } from "vitest";
import { BOUNDARY_SCHEMA, FilteredAnnotations, Probe, SourcePath, VerifyReport, placeholder, suppress } from "./boundary";

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const report = {
  schema: BOUNDARY_SCHEMA.verify,
  pass: false,
  sampleId: "asset_1",
  sampleDigest: digest("a"),
  sourceDigest: digest("b"),
  stage: "convert",
  errorClass: "ValueError",
  errorFile: "src/convert.py",
  errorLine: 12,
  outputs: [],
  durationMs: 40,
  timedOut: false,
  toolchain: { python: "3.12.8", runner: "verify-v1" },
} as const;

describe("boundary contracts", () => {
  it("accepts a fixed-schema verify report and nothing beyond it", () => {
    expect(VerifyReport.parse(report)).toEqual(report);
    // Free text has no field to live in: an exception message is an unknown key.
    expect(() => VerifyReport.parse({ ...report, message: "invalid literal for int(): 'Jane Doe'" })).toThrow();
    expect(() => VerifyReport.parse({ ...report, errorClass: "JaneDoeError" })).toThrow();
    expect(() => VerifyReport.parse({ ...report, errorFile: "../../etc/passwd" })).toThrow();
    expect(() => VerifyReport.parse({ ...report, errorFile: "/data/sample.dcm" })).toThrow();
  });

  it("keeps source paths inside the plugin", () => {
    for (const ok of ["plugin.yaml", "src/a_b/c.py", "tests/test-x.py"]) expect(SourcePath.safeParse(ok).success).toBe(true);
    for (const bad of ["..", "a/../b", "/abs", ".hidden", "a//b"]) expect(SourcePath.safeParse(bad).success).toBe(false);
  });

  it("types probes and bounds them", () => {
    expect(Probe.parse({ op: "magic", offset: 128, hex: "4449434d" })).toBeTruthy();
    expect(() => Probe.parse({ op: "read_text", offset: 0, length: 4096 })).toThrow();
    expect(() => Probe.parse({ op: "shell", cmd: "cat" })).toThrow();
  });

  it("drops strings from geometry", () => {
    const doc = { schema: BOUNDARY_SCHEMA.annotations, total: "<20", redacted: 0, annotations: [{ id: "a1", itemId: "img/a.png", label: "cat", geometry: { type: "box", x: 1, y: 2 }, provenance: null, review: null, attributes: { note: placeholder("seen by Dr Smith") } }] };
    expect(FilteredAnnotations.parse(doc)).toBeTruthy();
    const withText = { ...doc, annotations: [{ ...doc.annotations[0], geometry: { type: "box", note: "Dr Smith" } }] };
    expect(() => FilteredAnnotations.parse(withText)).toThrow();
  });

  it("suppresses small counts", () => {
    expect([0, 1, 19, 20, 500].map((n) => suppress(n))).toEqual([0, "<20", "<20", 20, 500]);
    expect(placeholder("Jane Doe")).toBe("<redacted:8>");
  });
});
