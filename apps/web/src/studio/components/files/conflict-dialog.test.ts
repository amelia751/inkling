import { describe, expect, it } from "vitest";
import type { FsConflict } from "@studio/contracts/types";
import { chooseResolution, othersLikeCurrent, startConflictWalk } from "./conflict-dialog";
import { keepBothName } from "./shared";

const c = (nodeId: string, kind: "file" | "folder" = "file", identical = false): FsConflict => ({ nodeId, name: `${nodeId}.dcm`, parentId: "p", parentName: "MRI", existingId: `x-${nodeId}`, kind, identical });

describe("conflict walk", () => {
  it("skips identical files silently and asks about the rest in order", () => {
    const w = startConflictWalk([c("a", "file", true), c("b"), c("f", "folder"), c("d")]);
    expect(w.identical).toBe(1);
    expect(w.resolutions).toEqual({ a: "skip" });
    expect(w.pending.map((p) => p.nodeId)).toEqual(["b", "f", "d"]);
    expect(w.current).toBe(0);
  });

  it("only identical files: nothing to ask", () => {
    expect(startConflictWalk([c("a", "file", true)]).current).toBeNull();
  });

  it("'do this for the others' applies to later conflicts of the same kind only", () => {
    let w = startConflictWalk([c("b"), c("f", "folder"), c("d"), c("e")]);
    expect(othersLikeCurrent(w)).toBe(2);
    w = chooseResolution(w, "keep_both", true);
    expect(w.resolutions).toEqual({ b: "keep_both", d: "keep_both", e: "keep_both" });
    expect(w.pending[w.current!].nodeId).toBe("f");
    expect(othersLikeCurrent(w)).toBe(0);
    w = chooseResolution(w, "merge", false);
    expect(w.current).toBeNull();
    expect(w.resolutions.f).toBe("merge");
  });

  it("one at a time without the checkbox; invalid choices for a kind are ignored", () => {
    let w = startConflictWalk([c("b"), c("f", "folder")]);
    expect(chooseResolution(w, "merge", false)).toBe(w);
    w = chooseResolution(w, "replace", false);
    expect(w.current).toBe(1);
    expect(chooseResolution(w, "replace", false)).toBe(w);
  });

  it("keep both names the copy like Finder", () => {
    expect(keepBothName("scan001.dcm")).toBe("scan001 (2).dcm");
    expect(keepBothName("MRI", "folder")).toBe("MRI (2)");
    expect(keepBothName(".env")).toBe(".env (2)");
  });
});
