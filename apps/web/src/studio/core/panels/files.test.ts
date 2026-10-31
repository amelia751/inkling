import { describe, expect, it } from "vitest";
import type { Annotation } from "@studio/contracts/types";
import { itemKind } from "@/studio/lib/file-kinds";
import { itemStates } from "./files";

const ann = (itemId: string, provenance: Annotation["provenance"]) => ({ id: `${itemId}-${provenance}`, itemId, provenance, label: "x", geometry: { type: "class" } }) as unknown as Annotation;

describe("Files tab", () => {
  it("a human annotation wins over imported labels and AI suggestions", () => {
    const s = itemStates([ann("a", "imported"), ann("a", "human-created"), ann("b", "imported"), ann("b", "ai-suggested"), ann("c", "ai-suggested")]);
    expect(Object.fromEntries(s)).toEqual({ a: "annotated", b: "imported", c: "suggested" });
  });

  it("names the item's data kind from its main asset", () => {
    expect(itemKind({ assets: [{ path: "x/a.dcm" }, { path: "x/b.dcm" }] as never })).toBe("dicom-series");
    expect(itemKind({ assets: [{ path: "x/a.dcm" }] as never })).toBe("dicom");
    expect(itemKind({ assets: [{ path: "p/thumb.jpeg", role: "thumbnail" }, { path: "p/s.dzi" }] as never })).toBe("slide");
    expect(itemKind({ assets: [{ path: "e/HR1.json" }] as never })).toBeNull();
  });
});
