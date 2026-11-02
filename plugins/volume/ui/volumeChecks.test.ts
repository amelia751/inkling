import { describe, expect, it } from "vitest";
import { volumeSources, referenceAsset } from "./dataKind";
import { chooseAffine, isLabelVolume } from "./volumeChecks";

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe("todo18 volume checks", () => {
  it("treats integer volumes with <=16 values as masks", () => {
    expect(isLabelVolume(true, [0, 1, 2, 4, 1, 0])).toBe(true);
    expect(isLabelVolume(true, Array.from({ length: 17 }, (_, i) => i))).toBe(false);
    expect(isLabelVolume(false, [0, 1])).toBe(false);
  });
  it("prefers sform and warns when qform disagrees", () => {
    const s = I.slice();
    s[3] = 5;
    expect(chooseAffine({ code: 1, affine: I }, { code: 1, affine: s })).toMatchObject({ source: "sform", warning: expect.stringContaining("disagree") });
    expect(chooseAffine({ code: 1, affine: I }, { code: 0, affine: s })).toEqual({ source: "qform", affine: I });
    expect(chooseAffine({ code: 1, affine: I }, { code: 1, affine: I }).warning).toBeUndefined();
  });
  it("an untagged BraTS _seg is the reference, not a fifth grey sequence", () => {
    const assets = ["t1", "t1ce", "t2", "flair", "seg"].map((s) => ({ path: `BraTS_001_${s}.nii.gz` }));
    expect(volumeSources(assets)).toHaveLength(4);
    expect(referenceAsset(assets)?.path).toBe("BraTS_001_seg.nii.gz");
  });
});
