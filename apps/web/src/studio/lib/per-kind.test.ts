import { describe, expect, it } from "vitest";
import type { EnvironmentSpec, LabelGroup } from "@studio/contracts/environment";
import type { ResolvedEnv } from "@studio/plugin-ui-sdk/resolved";
import { exporterIds, exportersByKind, kindFolder, labelsForItem, queueCountsByKind, reviewRunsByKind, toolsForItem } from "./per-kind";

const X = "studio.core.image2d";
const E = "studio.ecg.record";
const xray: LabelGroup = { name: "dx", control: "RectangleLabels", appliesTo: [X], classes: [{ id: "nodule" }] } as LabelGroup;
const ecg: LabelGroup = { name: "beats", control: "TimeSeriesLabels", appliesTo: [E], classes: [{ id: "N" }] } as LabelGroup;
const adequate: LabelGroup = { name: "ok", control: "Choices", classes: [{ id: "adequate" }] } as LabelGroup;
const geoms: Record<string, string[]> = { RectangleLabels: ["box"], TimeSeriesLabels: ["span"], Choices: [] };
const control = (g: LabelGroup) => ({ geometries: geoms[g.control] ?? [] });
const tool = (name: string, creates?: string, group?: string) => ({ id: `t.${name}`, name, creates, group }) as unknown as ResolvedEnv["tools"][number];
const env = {
  dataKind: { id: X },
  labels: [xray, ecg, adequate],
  tools: [tool("pan", undefined, "navigate"), tool("box", "box"), tool("span", "span")],
} as unknown as ResolvedEnv;

describe("labels and tools per kind (todo19 D7)", () => {
  it("shows only groups that apply to the item's kind, plus kind-less item-level groups", () => {
    expect(labelsForItem(env, { dataKind: X }).map((g) => g.name)).toEqual(["dx", "ok"]);
    expect(labelsForItem(env, { dataKind: E }).map((g) => g.name)).toEqual(["beats", "ok"]);
    expect(labelsForItem(env, { dataKind: "studio.other" }).map((g) => g.name)).toEqual(["ok"]);
  });
  it("falls back to the env's kind for items without one", () => {
    expect(labelsForItem(env, {}).map((g) => g.name)).toEqual(["dx", "ok"]);
  });
  it("a drawing tool shows only when an applicable label uses its geometry", () => {
    expect(toolsForItem(env, { dataKind: X }, control).map((t) => t.name)).toEqual(["pan", "box"]);
    expect(toolsForItem(env, { dataKind: E }, control).map((t) => t.name)).toEqual(["pan", "span"]);
  });
  it("returns env.tools unchanged when every group applies", () => {
    const one = { ...env, labels: [adequate, { ...xray, appliesTo: undefined }] } as ResolvedEnv;
    expect(toolsForItem(one, { dataKind: E }, control)).toBe(one.tools);
  });
});

describe("progress per kind (todo19 D8)", () => {
  it("counts To do / Needs review / Done per kind and in total", () => {
    const items = [{ dataKind: X }, { dataKind: X }, { dataKind: E }, {}];
    const states = ["annotated", "todo", "suggested", "todo"] as const;
    const { total, byKind } = queueCountsByKind(items, (i) => states[i], X);
    expect(total).toEqual({ all: 4, todo: 2, review: 1, done: 1 });
    expect(byKind[X]).toEqual({ all: 3, todo: 2, review: 0, done: 1 });
    expect(byKind[E]).toEqual({ all: 1, todo: 0, review: 1, done: 0 });
  });
});

const spec: EnvironmentSpec = {
  data: { kinds: { [X]: { renderer: "r.x", exporters: ["coco"], reviewRules: ["x-rule"] }, [E]: { renderer: "r.e", exporters: ["wfdb"] } } },
  exporters: ["json"],
  reviewRules: ["unlabeled"],
};

describe("export and review per kind (todo19 D8)", () => {
  it("exporters come from the accepted kinds' profiles plus the env's", () => {
    expect(exportersByKind(spec)).toEqual({ [X]: ["coco", "json"], [E]: ["wfdb", "json"] });
    expect(exporterIds(spec)).toEqual(["json", "coco", "wfdb"]);
  });
  it("only accepted kinds export", () => {
    expect(Object.keys(exportersByKind({ ...spec, accepts: [E] }))).toEqual([E]);
  });
  it("the one-kind shorthand keeps the env's exporters", () => {
    expect(exportersByKind({ data: { kind: X }, viewports: [{ renderer: "r.x" }], exporters: ["coco"] } as EnvironmentSpec)).toEqual({ [X]: ["coco"] });
  });
  it("review rules run over single-kind views", () => {
    const runs = reviewRunsByKind(spec, [{ id: "a", dataKind: X }, { id: "b", dataKind: E }, { id: "c", dataKind: X }]);
    expect(runs).toEqual([
      { kind: X, ruleIds: ["unlabeled", "x-rule"], items: [{ id: "a", dataKind: X }, { id: "c", dataKind: X }] },
      { kind: E, ruleIds: ["unlabeled"], items: [{ id: "b", dataKind: E }] },
    ]);
  });
  it("kind folders are short names", () => {
    expect(kindFolder(X)).toBe("image2d");
  });
});
