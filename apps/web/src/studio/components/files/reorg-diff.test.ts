import { describe, expect, it } from "vitest";
import { applyPlanToTree, fileCount, type DiffNode, type ReorgOp, type ReorgTreeNode } from "./reorg-diff";

const file = (id: string, name = id): ReorgTreeNode => ({ id, name, kind: "file" });
const snapshot = (): ReorgTreeNode => ({
  id: "root",
  name: "MRI",
  kind: "folder",
  children: [file("a", "p1_t1.dcm"), file("b", "p1_t2.dcm"), file("c", "p2_t1.dcm"), { id: "old", name: "old", kind: "folder", children: [file("d", "notes.csv")] }, { id: "run", name: "scan001–scan120.dcm", kind: "sequence", count: 120 }],
});
const find = (n: DiffNode, id: string): DiffNode | undefined => (n.id === id ? n : n.children?.map((c) => find(c, id)).find(Boolean));
const names = (n: DiffNode | undefined) => n?.children?.map((c) => c.name);

describe("applyPlanToTree", () => {
  const plan: ReorgOp[] = [
    { kind: "mkdir", id: "nod-p1", parentId: "root", name: "patient_001", reason: "Group by patient" },
    { kind: "mkdir", id: "nod-p2", parentId: "root", name: "patient_002", reason: "Group by patient" },
    { kind: "move", nodeIds: ["a", "b"], parentId: "nod-p1", reason: "Patient 1's scans" },
    { kind: "move", nodeIds: ["c"], parentId: "nod-p2", reason: "Patient 2's scans" },
    { kind: "rename", nodeId: "old", name: "archive", reason: "Clearer name" },
  ];

  it("creates folders, moves files into them and renames", () => {
    const { after, errors, stats } = applyPlanToTree(snapshot(), plan);
    expect(errors).toEqual([]);
    expect(stats).toEqual({ newFolders: 2, moved: 3, renamed: 1 });
    // Folders first, natural order.
    expect(names(after)).toEqual(["archive", "patient_001", "patient_002", "scan001–scan120.dcm"]);
    expect(find(after, "nod-p1")).toMatchObject({ isNew: true });
    expect(names(find(after, "nod-p1"))).toEqual(["p1_t1.dcm", "p1_t2.dcm"]);
    expect(find(after, "a")?.moved).toBe(true);
    expect(find(after, "old")).toMatchObject({ name: "archive", previousName: "old" });
    expect(find(after, "nod-p1")?.moved).toBeFalsy();
  });

  it("marks the before tree with what will happen", () => {
    const { before } = applyPlanToTree(snapshot(), plan);
    expect(find(before, "a")?.moved).toBe(true);
    expect(find(before, "d")?.moved).toBeFalsy();
    expect(find(before, "old")).toMatchObject({ name: "old", nextName: "archive" });
    expect(find(before, "nod-p1")).toBeUndefined();
  });

  it("never mutates the snapshot", () => {
    const tree = snapshot();
    const copy = JSON.parse(JSON.stringify(tree));
    applyPlanToTree(tree, plan);
    expect(tree).toEqual(copy);
  });

  it("refuses a folder into itself or its own child, and keeps going", () => {
    const { after, errors } = applyPlanToTree(snapshot(), [
      { kind: "mkdir", id: "nod-in", parentId: "old", name: "inner", reason: "" },
      { kind: "move", nodeIds: ["old"], parentId: "nod-in", reason: "" },
      { kind: "move", nodeIds: ["old"], parentId: "old", reason: "" },
      { kind: "move", nodeIds: ["a"], parentId: "old", reason: "" },
    ]);
    expect(errors).toEqual(["Step 2: can't move “old” into itself.", "Step 3: can't move “old” into itself."]);
    expect(names(find(after, "old"))).toEqual(["inner", "notes.csv", "p1_t1.dcm"]);
  });

  it("reports missing nodes and non-folder destinations", () => {
    const { errors } = applyPlanToTree(snapshot(), [
      { kind: "move", nodeIds: ["zzz"], parentId: "root", reason: "" },
      { kind: "move", nodeIds: ["a"], parentId: "b", reason: "" },
      { kind: "rename", nodeId: "zzz", name: "x", reason: "" },
      { kind: "mkdir", id: "n", parentId: "nope", name: "x", reason: "" },
      { kind: "move", nodeIds: ["root"], parentId: "old", reason: "" },
    ]);
    expect(errors).toHaveLength(5);
    expect(errors[1]).toContain("isn't a folder");
  });

  it("moving back where it was, or renaming back, is not a change", () => {
    const { after, stats } = applyPlanToTree(snapshot(), [
      { kind: "move", nodeIds: ["a"], parentId: "old", reason: "" },
      { kind: "move", nodeIds: ["a"], parentId: "root", reason: "" },
      { kind: "rename", nodeId: "b", name: "x.dcm", reason: "" },
      { kind: "rename", nodeId: "b", name: "p1_t2.dcm", reason: "" },
    ]);
    expect(stats).toEqual({ newFolders: 0, moved: 0, renamed: 0 });
    expect(find(after, "a")?.moved).toBe(false);
  });

  it("counts files per folder, runs by their count", () => {
    const { after } = applyPlanToTree(snapshot(), plan);
    expect(fileCount(after)).toBe(124);
    expect(fileCount(find(after, "nod-p1")!)).toBe(2);
  });
});
