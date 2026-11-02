import { describe, expect, it } from "vitest";
import { resolvePhases } from "./model";

describe("todo18 D5: Info.cfg meta on the item", () => {
  it("ED/ES come from the item's own meta before the project's", () => {
    const assets = [{ path: "u/p/patient101_4d.nii.gz", sha256: "", bytes: 1, meta: { ed: 0, es: 13 } }];
    expect(resolvePhases([], "it", assets, { ed: 5 }, ["ED", "ES"])).toEqual({ ED: { frame: 0, source: "meta" }, ES: { frame: 13, source: "meta" } });
  });
});
