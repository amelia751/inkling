import { beforeEach, describe, expect, it } from "vitest";
import { clipboardFor, useFilesClipboard } from "./clipboard";

const c = () => useFilesClipboard.getState();

describe("Files clipboard (todo7 Phase 3)", () => {
  beforeEach(() => {
    c().setProject(null);
    c().clear();
  });

  it("holds node ids per project, deduplicated", () => {
    c().setProject("p1");
    c().set("p1", "copy", ["a", "b", "a"]);
    expect(clipboardFor("p1")).toEqual({ mode: "copy", nodeIds: ["a", "b"] });
    expect(clipboardFor("p2")).toBeNull();
  });

  it("survives navigation in the project and clears on project change", () => {
    c().setProject("p1");
    c().set("p1", "cut", ["a"]);
    c().setProject("p1");
    expect(clipboardFor("p1")?.nodeIds).toEqual(["a"]);
    c().setProject("p2");
    expect(clipboardFor("p1")).toBeNull();
    expect(c().nodeIds).toEqual([]);
  });

  it("a cut is consumed by paste; a copy can be pasted again", () => {
    c().setProject("p1");
    c().set("p1", "copy", ["a"]);
    c().pasted();
    expect(clipboardFor("p1")?.mode).toBe("copy");
    c().set("p1", "cut", ["a", "b"]);
    c().pasted();
    expect(clipboardFor("p1")).toBeNull();
  });

  it("forgets nodes that are gone, and clears when none are left", () => {
    c().setProject("p1");
    c().set("p1", "cut", ["a", "b"]);
    c().forget(["a"]);
    expect(clipboardFor("p1")).toEqual({ mode: "cut", nodeIds: ["b"] });
    c().forget(["b"]);
    expect(clipboardFor("p1")).toBeNull();
  });

  it("an empty set clears it", () => {
    c().set("p1", "copy", ["a"]);
    c().set("p1", "copy", []);
    expect(clipboardFor("p1")).toBeNull();
  });
});
