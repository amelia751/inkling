import { describe, expect, it } from "vitest";
import type { DatasetCollection, DatasetIssue, DatasetProfile } from "@studio/contracts/types";
import { byRisk, contentSummary, countOf, datasetStatus, groupIssues, itemShape, modalitiesOf, percent, swatch } from "./model";

const col = (over: Partial<DatasetCollection>): DatasetCollection => ({
  id: "kind:image",
  name: "Images",
  kind: "image",
  count: 1,
  unit: { one: "image", other: "images" },
  files: 1,
  formats: [],
  facts: [],
  fields: [],
  previewNodeId: null,
  suggested: true,
  issues: 0,
  ...over,
});

const issue = (over: Partial<DatasetIssue>): DatasetIssue => ({
  id: "x",
  category: "quality",
  severity: "medium",
  blocking: false,
  title: "t",
  detail: "",
  count: 1,
  ruleId: "inspection.quality@1",
  nodeIds: [],
  action: { label: "Show", target: { section: "sources" } },
  ...over,
});

const profile = (over: Partial<DatasetProfile> = {}): DatasetProfile => ({ datasetId: "d", snapshot: { kind: "draft", label: "Working draft", readOnly: false }, files: 0, checking: 0, collections: [], relationships: [], issues: [], ...over });

describe("dataset words", () => {
  it("counts each collection at its own level, never files plus series", () => {
    const p = profile({ collections: [col({ kind: "dicom-series", count: 1, files: 120, unit: { one: "series", other: "series" } }), col({ count: 34 }), col({ kind: "table", count: 1, unit: { one: "table", other: "tables" } }), col({ kind: "video", count: 2, unit: { one: "video", other: "videos" } })] });
    expect(contentSummary(p)).toBe("1 series · 34 images · 1 table · 1 more");
    expect(countOf(1_200, { one: "image", other: "images" })).toBe("1,200 images");
  });

  it("maps kinds to the modality families the filter offers", () => {
    expect(modalitiesOf(profile({ collections: [col({ kind: "dicom-series" }), col({ kind: "dicom" }), col({ kind: "image" }), col({ kind: "archive" })] }))).toEqual(["volume", "image"]);
  });

  it("states where a dataset stands, processing before problems before drafts", () => {
    const tasks = [{ state: "published" as const }] as never;
    expect(datasetStatus({ tasks }, undefined)).toBeUndefined();
    expect(datasetStatus({ tasks }, profile({ checking: 3, issues: [issue({ blocking: true })] }))).toBe("processing");
    expect(datasetStatus({ tasks }, profile({ issues: [issue({ blocking: true, severity: "low" })] }))).toBe("needs-attention");
    expect(datasetStatus({ tasks }, profile({ issues: [issue({ severity: "medium" })] }))).toBe("ready");
    expect(datasetStatus({ tasks: [] }, profile())).toBe("draft");
  });

  it("ranks issues by risk, not count, and groups them by category", () => {
    const many = issue({ id: "many", count: 900, severity: "low" });
    const held = issue({ id: "held", category: "privacy", severity: "high", blocking: true, count: 1 });
    const warn = issue({ id: "warn", severity: "medium", count: 5 });
    expect(byRisk([many, warn, held]).map((i) => i.id)).toEqual(["held", "warn", "many"]);
    expect(groupIssues([many, held]).map((g) => g.title)).toEqual(["Privacy", "Data quality"]);
  });

  it("reads fill rates as whole percentages", () => {
    expect([percent(1), percent(0.955), percent(0.004), percent(0)]).toEqual(["100%", "95%", "<1%", "0%"]);
  });

  it("describes one item in a line, saying 'mostly' when sizes vary", () => {
    const c = col({ formats: [{ label: "DICOM", count: 3 }], facts: [{ key: "size", label: "Image size", values: [{ value: "512 × 512 px", count: 2 }, { value: "256 × 256 px", count: 1 }], more: 0, missing: 0 }, { key: "modality", label: "Modality", values: [{ value: "CT", count: 3 }], more: 0, missing: 0 }] });
    expect(itemShape(c)).toBe("mostly 512 × 512 px · CT · DICOM");
  });

  it("keeps a class's own colour and falls back to the palette by position", () => {
    expect(swatch("chart-2", 0)).toBe("hsl(var(--chart-2))");
    expect(swatch("#ff0000", 0)).toBe("#ff0000");
    expect(swatch(undefined, 6)).toBe("hsl(var(--chart-2))");
  });
});
