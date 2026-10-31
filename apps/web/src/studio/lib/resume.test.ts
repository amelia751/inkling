import { describe, expect, it } from "vitest";
import { placementOf } from "./resume";

describe("resume placement", () => {
  it("reads frames from the playhead and the volume's active plane slice", () => {
    expect(placementOf({ frame: 12 }, undefined)).toEqual({ frame: 12 });
    expect(placementOf({ frame: 3, slice: 5 }, undefined)).toEqual({ frame: 3, slice: 5 });
    expect(placementOf(undefined, { activePlane: "sagittal", slices: { axial: 70, sagittal: 40 } })).toEqual({ plane: "sagittal", slice: 40 });
    expect(placementOf(undefined, { activePlane: "axial" })).toEqual({});
  });
});
