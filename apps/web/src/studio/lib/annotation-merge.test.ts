import { describe, expect, it } from "vitest";
import type { Annotation } from "@studio/contracts/types";
import { mergeAnnotations, resolveConflict } from "./annotation-merge";

const a = (id: string, label = "cell") => ({ id, itemId: "i", label, geometry: { type: "box", x: 0, y: 0, w: 1, h: 1 }, provenance: "human-created", author: "x", createdAt: "t" }) as unknown as Annotation;

describe("mergeAnnotations (todo18 P0-4)", () => {
  it("keeps both sides' changes to different annotations", () => {
    const base = [a("1"), a("2")];
    const mine = [a("1", "mine"), a("2"), a("m")];
    const theirs = [a("1"), a("t")]; // they deleted 2 and added t
    const { merged, conflicts } = mergeAnnotations(base, mine, theirs);
    expect(conflicts).toEqual([]);
    expect(merged.map((x) => `${x.id}:${x.label}`)).toEqual(["1:mine", "t:cell", "m:cell"]);
  });
  it("reports the same annotation changed on both sides, keeping mine until chosen", () => {
    const { merged, conflicts } = mergeAnnotations([a("1")], [a("1", "mine")], [a("1", "theirs")]);
    expect(conflicts.map((c) => c.id)).toEqual(["1"]);
    expect(merged[0].label).toBe("mine");
    expect(resolveConflict(merged, conflicts[0], "theirs")[0].label).toBe("theirs");
  });
});
