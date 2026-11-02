import { describe, expect, it } from "vitest";
import type { SeedAsset, StudioItem } from "@studio/contracts/types";
import type { ResolvedEnv } from "@studio/plugin-ui-sdk/resolved";
import { blindFolders, dirsAbove, disambiguate, folderCount, inFolder, inQueue, itemTree, showSourceLabels, studioItems, withFolders, type ItemState } from "./item-folders";

const asset = (path: string, folder?: string[], nodeId?: string): SeedAsset => ({ path, sha256: "", bytes: 0, folder, nodeId });
const item = (id: string, name: string, assets: SeedAsset[], extra: Partial<StudioItem> = {}): StudioItem => ({ id, name, group: "Images", assets, ...extra });

describe("disambiguate", () => {
  it("gives the shortest distinguishing parent path, only to duplicates", () => {
    const items = [
      { name: "IM-0001.dcm", folder: ["mri", "patient_07", "series_2"] },
      { name: "IM-0001.dcm", folder: ["mri", "patient_08", "series_2"] },
      { name: "IM-0002.dcm", folder: ["mri", "patient_08", "series_2"] },
    ];
    expect(disambiguate(items)).toEqual(["patient_07/series_2", "patient_08/series_2", ""]);
  });
  it("stops at the first folder that differs, per item", () => {
    const items = [
      { name: "a.png", folder: ["x", "left"] },
      { name: "A.PNG", folder: ["y", "left"] },
      { name: "a.png", folder: ["z", "right"] },
    ];
    expect(disambiguate(items)).toEqual(["x/left", "y/left", "right"]);
  });
  it("handles items at the root and items without folders", () => {
    expect(disambiguate([{ name: "a", folder: [] }, { name: "a", folder: ["sub"] }, { name: "b" }])).toEqual(["", "sub", ""]);
  });
});

describe("withFolders", () => {
  it("takes the first asset's node and folder, and strips the folders every item shares", () => {
    const items = withFolders([item("1", "a.png", [asset("p1", ["study", "x"], "n1")]), item("2", "b.png", [asset("p2", ["study", "y"], "n2")])]);
    expect(items.map((i) => [i.folder, i.nodeId])).toEqual([[["x"], "n1"], [["y"], "n2"]]);
  });
  it("puts a bundle named like its folder in the parent folder", () => {
    const series = item("s", "series_2", [asset("a", ["p7", "series_2"], "n1"), asset("b", ["p7", "series_2"], "n2")]);
    const other = item("o", "series_1", [asset("c", ["p8", "series_1"], "n3")]);
    expect(withFolders([series, other]).map((i) => i.folder)).toEqual([["p7"], ["p8", "series_1"]]);
  });
  it("leaves items without folders alone (the seed stand-in)", () => {
    const out = withFolders([item("1", "a", [asset("p")])]);
    expect(out[0].folder).toBeUndefined();
  });
});

describe("D8 blind by default", () => {
  const env = (task?: string, studio?: object) => ({ task, spec: { studio } }) as unknown as Pick<ResolvedEnv, "spec" | "task">;
  it("hides source labels for classification unless opted in", () => {
    expect(showSourceLabels(env("classification"))).toBe(false);
    expect(showSourceLabels(env("classification", { showSourceLabels: true }))).toBe(true);
    expect(showSourceLabels(env("segmentation"))).toBe(true);
  });
  it("drops folders named like a label", () => {
    const items = withFolders([
      item("1", "IM-1.jpeg", [asset("a", ["normal"])], { sourceLabel: "normal" }),
      item("2", "IM-2.jpeg", [asset("b", ["Pneumonia", "left"])], { sourceLabel: "pneumonia" }),
    ]);
    expect(blindFolders(items, [], false).map((i) => i.folder)).toEqual([[], ["left"]]);
    expect(blindFolders(items, [], true)).toBe(items);
  });
});

describe("itemTree", () => {
  const states = new Map<string, ItemState>([["2", "annotated"]]);
  it("compacts single-child chains, counts progress and collapses numbered runs", () => {
    const items = [
      item("1", "IM-0001.png", [], { folder: ["mri", "p7", "s2"] }),
      item("2", "IM-0002.png", [], { folder: ["mri", "p7", "s2"] }),
      item("3", "IM-0003.png", [], { folder: ["mri", "p7", "s2"] }),
      item("4", "other.png", [], { folder: ["ct"] }),
      item("5", "top.png", [], { folder: [] }),
    ];
    const tree = itemTree(items, states);
    expect(tree.total).toBe(5);
    expect(tree.dirs.map((d) => [d.name, d.done, d.total])).toEqual([["ct", 0, 1], ["mri / p7 / s2", 1, 3]]);
    const run = tree.dirs[1].leaves[0];
    expect(run.kind === "run" && [run.name, run.indices]).toEqual(["IM-0001.png–IM-0003.png", [0, 1, 2]]);
    expect(tree.leaves).toEqual([{ kind: "item", index: 4 }]);
    expect(dirsAbove(tree, 1)).toEqual([tree.dirs[1].id, run.kind === "run" ? run.id : ""]);
    expect(folderCount(items)).toBe(3);
  });
  it("filters by indices", () => {
    const items = [item("1", "a", [], { folder: ["x"] }), item("2", "b", [], { folder: ["y"] })];
    expect(itemTree(items, states, [1]).dirs.map((d) => d.name)).toEqual(["y"]);
  });
});

describe("queue and path filters", () => {
  it("chips count what they say", () => {
    expect(inQueue("todo", "todo")).toBe(true);
    expect(inQueue("imported", "review") && inQueue("suggested", "review")).toBe(true);
    expect(inQueue("annotated", "done") && !inQueue("annotated", "todo")).toBe(true);
  });
  it("matches folder prefixes", () => {
    expect(inFolder(["a", "b"], ["a"])).toBe(true);
    expect(inFolder(["a"], ["a", "b"])).toBe(false);
    expect(inFolder(undefined, [])).toBe(true);
  });
});

describe("studioItems per kind (todo19 D3)", () => {
  const asset = (path: string, extra: Record<string, unknown> = {}) => ({ path, sha256: "x", bytes: 1, ...extra });
  const kind = (id: string, ext: string[], fileKinds: string[] = []) => ({
    id,
    name: id.split(".").pop()!,
    match: { ext },
    fileKinds,
    groupItems: (p: { assets: { path: string }[] }) => [{ id: `${id}:${p.assets.map((a) => a.path).join("+")}`, name: id, group: id, assets: p.assets, dataKind: id }],
  });
  const IMG = kind("studio.image2d.dataKinds.raster", [".png"], ["image"]);
  const ECG = kind("studio.timeseries.dataKinds.multichannel-timeseries", [".hea", ".dat"], ["waveform"]);
  const env = {
    spec: {},
    labels: [],
    dataKind: IMG,
    profiles: { [IMG.id]: { kind: IMG, id: "preset:image-2d" }, [ECG.id]: { kind: ECG, id: "preset:ecg" } },
  } as never;

  it("groups each kind with its own groupItems, concatenates, tags kind and profile; unmapped files stay as file items", () => {
    const project = { id: "p", assets: [asset("a.png"), asset("r1.hea"), asset("r1.dat"), asset("b.png", { kind: "image" }), asset("x.bin")] } as never;
    const items = studioItems(project, env);
    expect(items.map((i) => [i.id, i.dataKind, i.profile])).toEqual([
      [`${IMG.id}:a.png+b.png`, IMG.id, "preset:image-2d"],
      [`${ECG.id}:r1.hea+r1.dat`, ECG.id, "preset:ecg"],
      ["x.bin", undefined, undefined],
    ]);
  });

  it("an explicit kind wins over the extension", () => {
    const project = { id: "p", assets: [asset("trace.png", { kind: ECG.id })] } as never;
    expect(studioItems(project, env).map((i) => i.dataKind)).toEqual([ECG.id]);
  });

  it("a one-kind environment hands every file to its kind, as before", () => {
    const one = { spec: {}, labels: [], dataKind: IMG, profiles: { [IMG.id]: { kind: IMG, id: IMG.id } } } as never;
    const items = studioItems({ id: "p", assets: [asset("a.png"), asset("x.bin")] } as never, one);
    expect(items.map((i) => [i.id, i.profile])).toEqual([[`${IMG.id}:a.png+x.bin`, IMG.id]]);
  });
});
