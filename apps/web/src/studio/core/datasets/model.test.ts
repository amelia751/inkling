import { describe, expect, it } from "vitest";
import type { DatasetCollection, DatasetIssue, DatasetProfile } from "@studio/contracts/types";
import { attentionFromQueue, authorName, byRisk, contentSummary, countOf, datasetStatus, groupIssues, historyTitle, itemShape, modalitiesOf, percent, pipelineAttention, rankAttention, summaryFromProfile, swatch } from "./model";

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

describe("landing and history words (todo13 Milestone 3)", () => {
  it("builds the landing summary from a profile, counting suggestions and serious issues", () => {
    const p = profile({ collections: [col({ count: 3 }), col({ id: "kind:table", kind: "table", suggested: false })], issues: [issue({ blocking: true, severity: "high", count: 2 }), issue({ id: "y", count: 5 })] });
    const s = summaryFromProfile("d", p);
    expect(s.issues).toEqual({ count: 2, items: 7, blocking: 1, high: 1 });
    expect(s.suggestions).toBe(1);
    expect(Object.keys(s.collections[0]).sort()).toEqual(["count", "files", "id", "issues", "kind", "name", "previewNodeId", "suggested", "unit"]);
    expect(datasetStatus({ tasks: [{ state: "published" }] as never }, s)).toBe("needs-attention");
    expect(contentSummary(s)).toBe("3 images · 1 image");
  });

  it("turns the review queue's dataset rows into attention rows when the server has no attention read", () => {
    const rows = attentionFromQueue([
      { id: "a", type: "privacy", severity: "high", title: "Held", detail: "", target: { section: "sources" }, datasetId: "d", at: null },
      { id: "b", type: "proposal", severity: "low", title: "Link", detail: "", target: { section: "explore" }, at: null },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "malformed", blocking: true, datasetId: "d" });
  });

  it("says which pipeline runs need a person, scoped to the dataset their candidate belongs to", () => {
    const run = (run_id: string, state: string, item_counts = {}) => ({ run_id, project_id: "p", definition_id: "ingest", definition_name: "Ingest", state, created_at: "2026-11-01T00:00:00Z", item_counts }) as never;
    const problems = { runs: [run("r1", "failed"), run("r2", "running", { quarantined: 3 }), run("r3", "awaiting_review")], details: [{ run_id: "r2", candidate: { dataset_id: "d" } }, { run_id: "r3", candidate: { dataset_id: "other" } }] as never };
    const all = pipelineAttention(problems);
    expect(all.map((i) => i.title)).toEqual(["Ingest run failed", "3 files held back by pipeline validation", "Ingest run is waiting for review"]);
    expect(all[0].action.target).toEqual({ section: "pipelines", runId: "r1" });
    expect(pipelineAttention(problems, "d").map((i) => i.id)).toEqual(["pipeline:r2"]);
    expect(pipelineAttention(undefined)).toEqual([]);
  });

  it("ranks attention by risk: blocking, severity, then a decision before a suggestion", () => {
    const a = (id: string, kind: "malformed" | "plan" | "suggestion" | "pipeline", severity: "high" | "medium" | "low", blocking = false) => ({ id, kind, severity, blocking, datasetId: null, title: id, detail: "", count: 1, action: { label: "", target: { section: "overview" as const } }, at: null });
    expect(rankAttention([a("s", "suggestion", "low"), a("p", "plan", "low"), a("h", "malformed", "medium", true), a("m", "pipeline", "medium")]).map((i) => i.id)).toEqual(["h", "m", "p", "s"]);
  });

  it("writes history in words, never a hash", () => {
    expect(historyTitle({ message: "", operation: "init" })).toBe("Started keeping versions of this dataset");
    expect(historyTitle({ message: "merge work/ada into main", operation: "merge" })).toBe("Approved changes reached main");
    expect(historyTitle({ message: "Add 24 reviewed MRI studies", operation: "merge" })).toBe("Approved: Add 24 reviewed MRI studies");
    expect(historyTitle({ message: "", operation: "revert" })).toBe("Restored an earlier version");
    expect(historyTitle({ message: "", operation: "commit", annotation_count: 3 })).toBe("Saved 3 annotations");
    expect(historyTitle({ message: "relabelled the pneumonia cases\nmore", operation: "commit" })).toBe("Relabelled the pneumonia cases");
    expect([authorName("user:ada"), authorName("agent:run_1"), authorName("service:pipeline"), authorName(undefined)]).toEqual(["ada", "Assistant", "Pipeline", "Someone"]);
  });
});
