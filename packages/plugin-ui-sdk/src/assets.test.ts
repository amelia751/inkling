import { describe, expect, it } from "vitest";
import { assetName, isStorageKey } from "./assets";

const H = "4bb16896".padEnd(64, "a");

describe("assetName", () => {
  it("prefers the original name", () => {
    expect(assetName({ path: `sources/prj-x/${H}.svs`, name: "TCGA-A6.svs", slide: "x" })).toBe("TCGA-A6.svs");
  });
  it("skips storage keys in name/slide and falls back", () => {
    expect(assetName({ path: `sources/prj-x/${H}.svs`, slide: `sources/prj-x/${H}.svs`, record: "r1" })).toBe("r1");
    expect(assetName({ path: "seeds/ecg/100.hea" })).toBe("100.hea");
    expect(assetName({ path: "seeds/ecg/100.hea", name: "100.hea" }, "100")).toBe("100");
  });
  it("never returns a storage key", () => {
    const n = assetName({ path: `sources/prj-x/${H}.svs`, slide: `sources/prj-x/${H}.svs` });
    expect(isStorageKey(n)).toBe(false);
    expect(n).toBe("4bb16896.svs");
  });
});
