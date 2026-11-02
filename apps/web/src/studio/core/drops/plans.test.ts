import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@studio/ui/ui/sonner", () => ({ toast: vi.fn() }));

const { emitProjectEvent } = await import("@/studio/lib/use-project-events");
const { usePlans, actionLabel, memberCounts, undoSecondsLeft, QUESTION_COPY, replanSummaryText } = await import("./plans");
const { useBoots } = await import("@/studio/stores/boots");
const { catalogForKind } = await import("@/extension-host/catalog");

const PLAN = {
  dropId: "drp_1",
  needsPerson: true,
  actions: [
    { groupId: "g-image", type: "new_dataset" as const, name: "Images", preset: "preset:image-2d", nodeIds: ["n1", "n2"], kind: "image", count: 2 },
    { groupId: "g-table", type: "new_collection" as const, nodeIds: ["n3"], kind: "table", count: 1, asks: "labels_table" as const, relatesTo: "g-image" },
    { groupId: "g-unsupported-unknown", type: "keep_unsupported" as const, nodeIds: ["n4"], kind: "unknown", count: 1, asks: "find_plugin" as const, findPluginKind: "unknown" },
  ],
};

describe("drop plans store (project drop.* events)", () => {
  beforeEach(() => {
    usePlans.setState({ plans: {} });
    useBoots.setState({ boots: {}, pendingNav: null });
  });

  it("classified → planned → applied lands on one card; Undo is offered while the window is open", () => {
    emitProjectEvent("drop.classified", { dropId: "drp_1", groups: [{ groupId: "g-image", kind: "image", count: 2, suggestedAction: "new_dataset" }] }, "p1");
    expect(usePlans.getState().plans.drp_1).toMatchObject({ state: "classified", projectId: "p1" });
    emitProjectEvent("drop.planned", { dropId: "drp_1", plan: PLAN, auto: false }, "p1");
    expect(usePlans.getState().plans.drp_1.state).toBe("planned");
    const until = new Date(Date.now() + 30_000).toISOString();
    emitProjectEvent("drop.applied", { dropId: "drp_1", datasetId: "ds1", taskIds: ["t1"], undoUntil: until, collectionIds: ["c1"] }, "p1");
    const p = usePlans.getState().plans.drp_1;
    expect(p).toMatchObject({ state: "applied", taskIds: ["t1"], datasetId: "ds1" });
    expect(undoSecondsLeft(p)).toBeGreaterThan(25);
    expect(undoSecondsLeft(p, Date.parse(until) + 1)).toBe(0);
    // A second, different drop never navigates (J4).
    expect(useBoots.getState().pendingNav).toBeNull();
    emitProjectEvent("drop.applied", { dropId: "drp_1", taskIds: [], undoUntil: null, collectionIds: [], undone: true }, "p1");
    expect(usePlans.getState().plans.drp_1).toMatchObject({ state: "undone", taskIds: [], undoUntil: null });
  });

  it("an auto-applied plan shows as applying; the fast path opens the Studio in the tab that dropped", () => {
    usePlans.getState().markOwn("drp_f");
    emitProjectEvent("drop.planned", { dropId: "drp_f", plan: { ...PLAN, dropId: "drp_f", needsPerson: false }, auto: true }, "p1");
    expect(usePlans.getState().plans.drp_f.state).toBe("applying");
    emitProjectEvent("drop.applied", { dropId: "drp_f", taskIds: ["t9"], undoUntil: null, fastPath: true, auto: true }, "p1");
    // todo18: not before the first item exists ("Preparing your first item").
    expect(useBoots.getState().pendingNav).toBeNull();
    expect(usePlans.getState().plans.drp_f.waitingFirstItem).toBe(true);
    emitProjectEvent("item.ready", { taskId: "other", itemId: "i0" }, "p1");
    expect(useBoots.getState().pendingNav).toBeNull();
    emitProjectEvent("item.ready", { taskId: "t9", itemId: "i1" }, "p1");
    expect(useBoots.getState().pendingNav).toEqual({ bootId: "drp_f", url: "/projects/p1/studio/t9" });
    expect(usePlans.getState().plans.drp_f.waitingFirstItem).toBe(false);
  });

  it("a refused archive is a chip; a failed apply is the card's state", () => {
    emitProjectEvent("drop.planned", { dropId: "drp_z", plan: { ...PLAN, dropId: "drp_z" }, auto: false }, "p1");
    emitProjectEvent("drop.failed", { dropId: "drp_z", step: "unpack", errorClass: "ratio", nodeId: "nod-zip" }, "p1");
    expect(usePlans.getState().plans.drp_z).toMatchObject({ state: "planned", refused: { "nod-zip": "ratio" } });
    emitProjectEvent("drop.failed", { dropId: "drp_z", step: "apply", errorClass: "HTTPException" }, "p1");
    expect(usePlans.getState().plans.drp_z).toMatchObject({ state: "failed", failed: { step: "apply" } });
  });

  it("words each action without file names", () => {
    expect(actionLabel(PLAN.actions[0])).toBe("2 images → a new draft dataset (“Images”)");
    const one = { groupId: "g-image", type: "new_dataset" as const, nodeIds: ["a", "b", "c", "d"], kind: "image", count: 4, members: [
      { groupId: "g-image", kind: "image", count: 2, nodeIds: ["a", "b"] },
      { groupId: "g-waveform", kind: "waveform", count: 1, nodeIds: ["c"] },
      { groupId: "g-video", kind: "video", count: 1, nodeIds: ["d"] },
    ] };
    expect(actionLabel(one)).toBe("One Studio · 4 files · 3 kinds");
    expect(memberCounts(one).map((m) => m.label)).toEqual(["2 images", "1 recording", "1 video"]);
    expect(actionLabel(PLAN.actions[1])).toBe("1 table: labels or metadata for these items?");
    expect(actionLabel(PLAN.actions[2])).toBe("1 file: kept in Sources, can't use yet");
    expect(QUESTION_COPY.labels_table.noChange).toEqual({ type: "keep_reference" });
  });
});

describe("catalogue kind filter (Find a plugin)", () => {
  it("keeps the data kinds that open a detected kind, and their modules", () => {
    const cat = {
      version: 1 as const,
      modules: [{ id: "m.img", version: "1", title: "Img", description: "" }, { id: "m.vid", version: "1", title: "Vid", description: "" }],
      contributions: [
        { id: "m.img.dataKinds.raster", type: "dataKinds" as const, module: "m.img", description: "", fileKinds: ["image", "dicom"] },
        { id: "m.vid.dataKinds.video", type: "dataKinds" as const, module: "m.vid", description: "", fileKinds: ["video"] },
        { id: "m.img.tools.box", type: "tools" as const, module: "m.img", description: "" },
      ],
    };
    expect(catalogForKind(cat, "Image").contributions.map((c) => c.id)).toEqual(["m.img.dataKinds.raster"]);
    expect(catalogForKind(cat, "image").modules.map((m) => m.id)).toEqual(["m.img"]);
    expect(catalogForKind(cat, "audio").contributions).toEqual([]);
  });
});

describe("replanSummaryText", () => {
  const none = { moved: [], createdCollections: [], createdStudios: [], retiredStudios: [], retiredCollections: [], keptAnnotated: [] };
  it("says what moved, what was made and what was kept", () => {
    expect(replanSummaryText({ ...none, moved: [{ collectionId: "c1", nodeIds: ["a", "b"] }], createdStudios: ["t1"], retiredStudios: ["t2"], keptAnnotated: ["t3"] })).toBe(
      "Re-planned: 2 files moved, 1 new Studio, 1 Studio left empty moved to Trash, 1 Studio kept because of annotations.",
    );
  });
  it("says when nothing changed", () => {
    expect(replanSummaryText(none)).toBe("Already matches the current rules: nothing changed.");
  });
});
