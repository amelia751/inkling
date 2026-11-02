import { describe, expect, it } from "vitest";
import { fileFacts, formatBytes, mainAsset, previewable } from "./facts";

describe("file view facts", () => {
  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(undefined)).toBe("unknown size");
  });
  it("lists kind, type, size and dimensions; previews images only", () => {
    const a = { path: "x/scan.png", sha256: "abcdef0123456789", bytes: 2048, width: 10, height: 20 };
    const rows = Object.fromEntries(fileFacts(a, "studio.image2d.dataKinds.raster").map((r) => [r.label, r.value]));
    expect(rows).toMatchObject({ Kind: "studio.image2d.dataKinds.raster", Type: "image/png", Size: "2.0 KB", Dimensions: "10 × 20" });
    expect(previewable(a)).toBe(true);
    expect(previewable({ ...a, path: "x/notes.bin" })).toBe(false);
    expect(mainAsset({ assets: [{ ...a, role: "thumbnail" }, a] })).toBe(a);
  });
});
